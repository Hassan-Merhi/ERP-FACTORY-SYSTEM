#!/usr/bin/env node
/**
 * Read-only tenant/accounting catalog audit.
 * Never performs INSERT/UPDATE/DELETE/CREATE/ALTER. Does not assume a
 * 'NOT VALID' legacy FK is missing enforcement for new rows.
 */
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "../server/lib/databaseSsl.mjs";
import { evaluateCatalogIntegrity, CORE_TABLES, CONTROL_TABLES } from "./database-integrity-catalog-core.mjs";

export async function inspectCatalog(client) {
  const requested=[...new Set([...CORE_TABLES,...CONTROL_TABLES])];
  const [tables,constraints,triggers,rls] = await Promise.all([
    client.query(`SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY($1::text[])`,[requested]),
    client.query(`SELECT cl.relname AS table_name,co.conname AS constraint_name,co.convalidated AS validated
      FROM pg_constraint co JOIN pg_class cl ON cl.oid=co.conrelid
      JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='public'`),
    client.query(`SELECT cl.relname AS table_name,t.tgname AS trigger_name,t.tgenabled AS enabled
      FROM pg_trigger t JOIN pg_class cl ON cl.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=cl.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal`),
    client.query(`SELECT c.relname AS table_name,c.relrowsecurity AS enabled,c.relforcerowsecurity AS forced,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS "policyCount"
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') AND
        (c.relrowsecurity OR c.relforcerowsecurity)`)
  ]);
  return {tables:tables.rows.map(x=>x.table_name),constraints:constraints.rows,triggers:triggers.rows,rls:rls.rows};
}

export async function auditIntegrityCatalog(dbUrl) {
  if(!dbUrl)throw new Error("DATABASE_URL required");
  const client=new pg.Client({connectionString:dbUrl,ssl:resolveDatabaseSsl(dbUrl),connectionTimeoutMillis:15000});
  try{
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query("SET LOCAL lock_timeout='5s'");
    const snapshot=await inspectCatalog(client);
    const report=evaluateCatalogIntegrity(snapshot);
    await client.query("ROLLBACK");
    return report;
  }catch(error){
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  }finally{
    await client.end().catch(()=>{});
  }
}
if(process.argv[1]?.endsWith("/audit-database-integrity-catalog.mjs") || process.argv[1]==="scripts/audit-database-integrity-catalog.mjs"){
  if(process.argv.slice(2).some(x=>x!=="--json")){
    console.error("Only --json supported");process.exitCode=2;
  }else{
    auditIntegrityCatalog(process.env.DATABASE_URL).then(result=>{
      console.log(JSON.stringify(result,null,2));
      if(!result.ok)process.exitCode=1;
    }).catch(error=>{
      console.error("Catalog audit failed:",error instanceof Error?error.message:String(error));
      process.exitCode=2;
    });
  }
}
