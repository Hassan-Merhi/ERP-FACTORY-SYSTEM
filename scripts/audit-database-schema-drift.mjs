#!/usr/bin/env node
/**
 * Read-only scoped schema drift inspection. Never creates/fixes objects.
 * Usage: npm run db:drift
 *        node scripts/audit-database-schema-drift.mjs --json --require-controlled
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "../server/lib/databaseSsl.mjs";
import { compareSchemaDrift, compareMigrationHistory } from "./database-schema-drift-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowed = new Set(["--json","--require-controlled"]);
const supplied = process.argv.slice(2);
if(supplied.some(arg=>!allowed.has(arg)) || new Set(supplied).size!==supplied.length) {
  console.error("Only --json and --require-controlled are supported");
  process.exit(2);
}
const requireControlled = supplied.includes("--require-controlled");

async function manifest() {
  const dir=path.join(root,"migrations/controlled");
  const names=(await readdir(dir)).filter(x=>x.endsWith(".sql")).sort();
  const result=[];
  for(const name of names) {
    if(!/^\d{8}_\d{3}_[a-z0-9_-]+\.sql$/.test(name)) throw new Error("Invalid migration filename: "+name);
    const sql=await readFile(path.join(dir,name),"utf8");
    result.push({name,checksum:createHash("sha256").update(sql).digest("hex")});
  }
  return result;
}

async function collect(client) {
  const [tables,columns,indexes,constraints,triggers]=await Promise.all([
    client.query(`SELECT c.relname AS table_name FROM pg_class c
      JOIN pg_namespace ns ON ns.oid=c.relnamespace
      WHERE ns.nspname='public' AND c.relkind IN ('r','p')`),
    client.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'`),
    client.query(`SELECT cls.relname AS index_name,i.indisvalid AS valid,i.indisready AS ready
      FROM pg_index i JOIN pg_class cls ON cls.oid=i.indexrelid
      JOIN pg_namespace ns ON ns.oid=cls.relnamespace WHERE ns.nspname='public'`),
    client.query(`SELECT cls.relname AS table_name,con.conname AS constraint_name,con.convalidated AS validated
      FROM pg_constraint con JOIN pg_class cls ON cls.oid=con.conrelid
      JOIN pg_namespace ns ON ns.oid=cls.relnamespace WHERE ns.nspname='public'`),
    client.query(`SELECT cls.relname AS table_name,tr.tgname AS trigger_name,tr.tgenabled AS enabled
      FROM pg_trigger tr JOIN pg_class cls ON cls.oid=tr.tgrelid
      JOIN pg_namespace ns ON ns.oid=cls.relnamespace
      WHERE ns.nspname='public' AND NOT tr.tgisinternal`)
  ]);
  return {
    tables:tables.rows.map(x=>x.table_name),
    columns:columns.rows,
    indexes:indexes.rows,
    constraints:constraints.rows,
    triggers:triggers.rows
  };
}

async function run() {
  const url=process.env.DATABASE_URL;
  if(!url) throw new Error("DATABASE_URL is required; no database accessed");
  const client=new pg.Client({connectionString:url,ssl:resolveDatabaseSsl(url),connectionTimeoutMillis:15000});
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");
    const snapshot=await collect(client);
    const existing=await client.query("SELECT to_regclass('public.erp_controlled_migration_history') IS NOT NULL AS present");
    const historyExists=existing.rows[0]?.present===true;
    const rows=historyExists
      ?(await client.query("SELECT migration_name,checksum FROM public.erp_controlled_migration_history ORDER BY migration_name")).rows
      :[];
    const migration=compareMigrationHistory(await manifest(),rows,historyExists);
    const schema=compareSchemaDrift(snapshot,{includeControlled:requireControlled});
    // History is optional for the baseline report, mandatory for certified cutover.
    const gate=schema.ok && migration.ok && (!requireControlled || (historyExists && migration.pending.length===0));
    await client.query("ROLLBACK");
    const output={ok:gate,mode:"read-only",schema,migration,controlledHistoryRequired:requireControlled};
    console.log(JSON.stringify(output,null,2));
    if(!gate) process.exitCode=1;
  } catch(error) {
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally {
    await client.end().catch(()=>{});
  }
}
run().catch(error=>{
  console.error("Schema drift audit failed:",error instanceof Error?error.message:String(error));
  process.exitCode=2;
});
