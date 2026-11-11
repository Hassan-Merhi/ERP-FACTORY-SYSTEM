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
import { compareDefinitionDrift } from "./database-schema-definition-core.mjs";
import { fingerprintFullSchema,compareFullSchemaFingerprint } from "./database-full-schema-fingerprint-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supplied = process.argv.slice(2);
const allowed = new Set(["--json","--require-controlled","--fingerprint"]);
const referenceArgs = supplied.filter(arg=>arg.startsWith("--full-reference="));
if(referenceArgs.length>1 || supplied.some(arg=>!allowed.has(arg) && !arg.startsWith("--full-reference=")) ||
   new Set(supplied).size!==supplied.length ||
   (supplied.includes("--fingerprint")&&referenceArgs.length)) {
  console.error("Supported: --json, --require-controlled, --fingerprint, --full-reference=<trusted-file>");
  process.exit(2);
}
const requireControlled = supplied.includes("--require-controlled");
const referencePath = referenceArgs[0]?.slice("--full-reference=".length);
if(referenceArgs.length && !referencePath) throw new Error("Reference file path must not be empty");
const fingerprintOnly = supplied.includes("--fingerprint");

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
  const [tables,columns,indexes,constraints,triggers,functions,policies,relations,views,sequences]=await Promise.all([
    client.query(`SELECT c.relname AS table_name FROM pg_class c
      JOIN pg_namespace ns ON ns.oid=c.relnamespace
      WHERE ns.nspname='public' AND c.relkind IN ('r','p')`),
    client.query(`SELECT table_name,column_name,data_type,
      (is_nullable='NO') AS not_null,column_default AS default_expression,
      identity_generation,generation_expression
      FROM information_schema.columns WHERE table_schema='public'`),
    client.query(`SELECT cls.relname AS index_name,tab.relname AS table_name,
        i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,
        pg_get_indexdef(i.indexrelid) AS definition,
        pg_get_expr(i.indpred,i.indrelid) AS predicate,
        ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,true)
          FROM generate_series(1,i.indnkeyatts) k ORDER BY k) AS key_columns
      FROM pg_index i JOIN pg_class cls ON cls.oid=i.indexrelid
      JOIN pg_class tab ON tab.oid=i.indrelid
      JOIN pg_namespace ns ON ns.oid=cls.relnamespace WHERE ns.nspname='public'`),
    client.query(`SELECT cls.relname AS table_name,con.conname AS constraint_name,con.convalidated AS validated,
        con.contype AS type,pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class cls ON cls.oid=con.conrelid
      JOIN pg_namespace ns ON ns.oid=cls.relnamespace WHERE ns.nspname='public'`),
    client.query(`SELECT cls.relname AS table_name,tr.tgname AS trigger_name,tr.tgenabled AS enabled,
        pg_get_triggerdef(tr.oid) AS definition
      FROM pg_trigger tr JOIN pg_class cls ON cls.oid=tr.tgrelid
      JOIN pg_namespace ns ON ns.oid=cls.relnamespace
      WHERE ns.nspname='public' AND NOT tr.tgisinternal`),
    client.query(`SELECT p.proname AS function_name,
        pg_get_function_identity_arguments(p.oid) AS identity_arguments,
        pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
      WHERE ns.nspname='public' AND p.prokind IN ('f','p')`),
    client.query(`SELECT c.relname AS table_name,c.relrowsecurity AS enabled,
        c.relforcerowsecurity AS forced,p.polname AS policy_name,
        p.polpermissive AS permissive,
        CASE WHEN p.polcmd='*' THEN 'ALL' WHEN p.polcmd='r' THEN 'SELECT'
          WHEN p.polcmd='a' THEN 'INSERT' WHEN p.polcmd='w' THEN 'UPDATE'
          WHEN p.polcmd='d' THEN 'DELETE' ELSE p.polcmd::text END AS policy_command,
        ARRAY(SELECT CASE WHEN role_oid=0 THEN 'public' ELSE role_oid::regrole::text END
          FROM unnest(p.polroles) AS role_oid) AS roles,
        pg_get_expr(p.polqual,p.polrelid) AS using_expression,
        pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
      FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
      LEFT JOIN pg_policy p ON p.polrelid=c.oid
      WHERE ns.nspname='public' AND c.relkind IN ('r','p')`),
    client.query(`SELECT c.relname AS relation_name,c.relkind::text AS relation_kind,
        c.relpersistence::text AS persistence
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')`),
    client.query(`SELECT c.relname AS view_name,c.relkind::text AS view_kind,
        pg_get_viewdef(c.oid,true) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('v','m')`),
    client.query(`SELECT sequencename AS sequence_name,data_type,
        start_value::text,min_value::text,max_value::text,
        increment_by::text,cycle,cache_size::text
      FROM pg_sequences WHERE schemaname='public'`)
  ]);
  return {
    tables:tables.rows.map(x=>x.table_name),
    columns:columns.rows,
    indexes:indexes.rows,
    constraints:constraints.rows,
    triggers:triggers.rows,
    functions:functions.rows,
    policies:policies.rows,
    relations:relations.rows,
    views:views.rows,
    sequences:sequences.rows
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
    const fingerprint=fingerprintFullSchema(snapshot);
    if(fingerprintOnly) {
      await client.query("ROLLBACK");
      console.log(JSON.stringify(fingerprint,null,2));
      return;
    }
    const migration=compareMigrationHistory(await manifest(),rows,historyExists);
    const schema=compareSchemaDrift(snapshot,{includeControlled:requireControlled});
    const definitions=requireControlled?compareDefinitionDrift(snapshot):null;
    // History is optional for the baseline report, mandatory for certified cutover.
    const fullReference=referencePath
      ?compareFullSchemaFingerprint(JSON.parse(await readFile(path.resolve(referencePath),"utf8")),fingerprint)
      :null;
    const gate=schema.ok && migration.ok && (!requireControlled ||
      (definitions.ok && historyExists && migration.pending.length===0)) &&
      (!fullReference || fullReference.ok);
    await client.query("ROLLBACK");
    const output={ok:gate,mode:"read-only",schema,definitions,fullReference,migration,controlledHistoryRequired:requireControlled};
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
