#!/usr/bin/env node
/**
 * Phase 4: read-only relational and accounting integrity diagnostic.
 * No DDL, UPDATE, DELETE, INSERT, or data repair is executed.
 * Outputs aggregate counts only, not sensitive voucher/customer rows.
 */
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveDatabaseSsl } from "../server/lib/databaseSsl.mjs";

export const REQUIRED = Object.freeze({
  tables: ["companies", "vouchers", "voucher_entries", "ledger_accounts", "bank_accounts"],
  checks: [
    ["voucher_entries", "voucher_entries_ledger_account_id_fkey"],
    ["voucher_entries", "voucher_entries_bank_account_id_fkey"],
    ["voucher_entries", "voucher_entries_amounts_non_negative"],
    ["voucher_entries", "voucher_entries_single_side"],
  ],
  triggers: [
    ["voucher_entries", "voucher_entries_balance_guard"],
    ["vouchers", "vouchers_balance_guard"],
    ["voucher_entries", "voucher_entries_sync_company_id"]
  ]
});

export function summarizeIntegrity({missingTables=[],missingConstraints=[],invalidConstraints=[],missingTriggers=[],metrics={}}) {
  const metricErrors = Object.entries(metrics)
    .filter(([,count])=>Number(count)>0)
    .map(([name,count])=>({name,count:Number(count)}));
  return {
    ok: missingTables.length===0 && missingConstraints.length===0 &&
      invalidConstraints.length===0 && missingTriggers.length===0 && metricErrors.length===0,
    missingTables,missingConstraints,invalidConstraints,missingTriggers,metrics,metricErrors
  };
}

async function audit(client) {
  const missingTables = [];
  const missingConstraints = [];
  const invalidConstraints = [];
  const missingTriggers = [];
  const metrics = {};
  const names = REQUIRED.tables;
  const tables = await client.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY($1::text[])`,[names]);
  const found = new Set(tables.rows.map(x=>x.relname));
  for(const t of names) if(!found.has(t)) missingTables.push(t);

  const constraints = await client.query(`
    SELECT cls.relname AS table_name, con.conname, con.convalidated
    FROM pg_constraint con JOIN pg_class cls ON cls.oid=con.conrelid
    JOIN pg_namespace ns ON ns.oid=cls.relnamespace
    WHERE ns.nspname='public'
      AND (cls.relname, con.conname) IN (
        ('voucher_entries','voucher_entries_ledger_account_id_fkey'),
        ('voucher_entries','voucher_entries_bank_account_id_fkey'),
        ('voucher_entries','voucher_entries_amounts_non_negative'),
        ('voucher_entries','voucher_entries_single_side')
      )`);
  const constraintByKey = new Map(constraints.rows.map(x=>[x.table_name+"."+x.conname,x]));
  for(const [t,c] of REQUIRED.checks) {
    const x=constraintByKey.get(t+"."+c);
    if(!x) missingConstraints.push(t+"."+c);
    else if(x.convalidated!==true) invalidConstraints.push(t+"."+c);
  }

  const triggers=await client.query(`
    SELECT cls.relname AS table_name,t.tgname,t.tgenabled
    FROM pg_trigger t JOIN pg_class cls ON cls.oid=t.tgrelid
    JOIN pg_namespace ns ON ns.oid=cls.relnamespace
    WHERE ns.nspname='public' AND NOT t.tgisinternal`);
  const triggerByKey=new Map(triggers.rows.map(x=>[x.table_name+"."+x.tgname,x]));
  for(const [t,c] of REQUIRED.triggers) {
    const x=triggerByKey.get(t+"."+c);
    if(!x || !["O","A"].includes(x.tgenabled)) missingTriggers.push(t+"."+c);
  }
  // Never infer that a missing table has zero problematic rows.
  if(missingTables.length===0) {
    // Tenant RLS needs explicit company context for each request. The audit
    // uses the same maintenance scope as the existing tenant integrity auditor.
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    const checks = [
      ["orphan_voucher_entries", `
        SELECT COUNT(*)::text AS n FROM voucher_entries e
        LEFT JOIN vouchers v ON v.id=e.voucher_id WHERE v.id IS NULL`],
      ["voucher_entry_company_mismatch", `
        SELECT COUNT(*)::text AS n FROM voucher_entries e
        JOIN vouchers v ON v.id=e.voucher_id
        WHERE e.company_id IS DISTINCT FROM v.company_id`],
      ["voucher_ledger_account_company_mismatch", `
        SELECT COUNT(*)::text AS n FROM voucher_entries e
        JOIN vouchers v ON v.id=e.voucher_id
        LEFT JOIN ledger_accounts a ON a.id=e.ledger_account_id
        WHERE e.ledger_account_id IS NOT NULL
          AND (a.id IS NULL OR a.company_id IS DISTINCT FROM v.company_id)`],
      ["negative_or_two_sided_lines", `
        SELECT COUNT(*)::text AS n FROM voucher_entries
        WHERE COALESCE(debit_amount,0)<0 OR COALESCE(credit_amount,0)<0
           OR (COALESCE(debit_amount,0)>0 AND COALESCE(credit_amount,0)>0)`],
      ["unbalanced_active_nonoptional_vouchers", `
        SELECT COUNT(*)::text AS n FROM (
          SELECT v.id
          FROM vouchers v LEFT JOIN voucher_entries e ON e.voucher_id=v.id
          WHERE v.deleted_at IS NULL AND COALESCE(v.optional,false)=false
          GROUP BY v.id HAVING ABS(COALESCE(SUM(e.debit_amount),0)-COALESCE(SUM(e.credit_amount),0))>0.01
        ) mismatched`]
    ];
    for(const [name,sql] of checks) {
      const result=await client.query(sql);
      metrics[name]=Number(result.rows[0]?.n??0);
    }
    await client.query("SELECT set_config('app.company_scope_maintenance', 'off', true)");
  }
  return summarizeIntegrity({missingTables,missingConstraints,invalidConstraints,missingTriggers,metrics});
}

async function main() {
  if(!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if(process.argv.some(a=>!["--json"].includes(a))) throw new Error("Only --json is supported");
  const client=new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveDatabaseSsl(process.env.DATABASE_URL),
    connectionTimeoutMillis: 15000
  });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout='90s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const result=await audit(client);
    await client.query("ROLLBACK");
    if(process.argv.includes("--json")) console.log(JSON.stringify(result,null,2));
    else {
      console.log("Database integrity audit (read-only)");
      console.log(JSON.stringify(result,null,2));
    }
    if(!result.ok) process.exitCode=1;
  } catch(error) {
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally {
    await client.end().catch(()=>{});
  }
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  main().catch(e=>{console.error("Database integrity audit failed:",e.message);process.exitCode=2;});
}
