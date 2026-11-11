#!/usr/bin/env node
/**
 * Phase 8: real PostgreSQL integration exercise for the controlled migration runner.
 *
 * SAFETY:
 * - Test-only local PostgreSQL host and privileged disposable database creation.
 * - Creates unique phase8_test_* databases, never writes to DATABASE_URL directly.
 * - Refuses execution without NODE_ENV=test and explicit test confirmation.
 * - Only reads/apply to databases created by this process, then drops them.
 * - The runner remains opt-in and is never used by application startup.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "../server/lib/databaseSsl.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const runner=path.join(root,"scripts/run-controlled-migrations.mjs");
const confirmation="RUN_DISPOSABLE_PHASE8_MIGRATION_TESTS";
const lock=748392106;
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));

function connectionFor(name) {
  const u=new URL(process.env.DATABASE_URL);
  u.pathname="/"+name;
  return u.toString();
}
async function executeRunner(dbUrl,mode,extra={}) {
  return await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[runner,mode],{
      cwd:root,
      env:{...process.env,DATABASE_URL:dbUrl,PGSSLMODE:"disable",
        MIGRATION_CONFIRMATION:"APPLY_CONTROLLED_MIGRATIONS",...extra},
      stdio:["ignore","pipe","pipe"]
    });
    let stdout="",stderr="";
    child.stdout.on("data",data=>{stdout+=data.toString();});
    child.stderr.on("data",data=>{stderr+=data.toString();});
    child.on("error",reject);
    child.on("close",code=>resolve({code,stdout,stderr}));
  });
}

async function run() {
  const raw=process.env.DATABASE_URL;
  if(process.env.NODE_ENV!=="test" || process.env.PHASE8_TEST_CONFIRMATION!==confirmation)
    throw new Error("Explicit disposable test authorization is required");
  if(!raw) throw new Error("DATABASE_URL required for disposable localhost PostgreSQL");
  const u=new URL(raw);
  if(!["localhost","127.0.0.1","::1","[::1]"].includes(u.hostname))
    throw new Error("Tests require a loopback PostgreSQL host; production is forbidden");
  if(!["postgres","postgresql"].includes(u.protocol.replace(":","")))
    throw new Error("Expected PostgreSQL URL");

  const dbName="phase8_test_"+randomUUID().replaceAll("-","").slice(0,16);
  const admin=new pg.Client({connectionString:raw,ssl:false,connectionTimeoutMillis:5000});
  let created=false;
  try {
    await admin.connect();
    if((await admin.query("SELECT inet_server_addr() AS ip")).rows[0]?.ip &&
       !["127.0.0.1","::1"].includes(String((await admin.query("SELECT inet_server_addr() AS ip")).rows[0]?.ip)))
      throw new Error("PostgreSQL server is not loopback");
    await admin.query('CREATE DATABASE "'+dbName+'"');
    created=true;
    const dbUrl=connectionFor(dbName);
    const client=new pg.Client({connectionString:dbUrl,ssl:false});
    try {
      await client.connect();
      // Minimal legacy schema required by the two controlled migrations.
      await client.query(`
        CREATE TABLE companies (id integer PRIMARY KEY);
        CREATE TABLE vouchers (id integer PRIMARY KEY);
        CREATE TABLE voucher_entries (id integer PRIMARY KEY);
        CREATE TABLE sp_containers (id integer PRIMARY KEY);
        CREATE TABLE ledger_accounts (id integer PRIMARY KEY);
        CREATE TABLE user_preferences (id integer PRIMARY KEY);
        CREATE TABLE exchange_rates (
          id integer PRIMARY KEY,
          company_id integer,
          effective_date date,
          from_currency text,
          to_currency text
        );
        INSERT INTO companies(id) VALUES (1);
        INSERT INTO exchange_rates VALUES (1,1,'2026-01-01','USD','EUR');
        INSERT INTO exchange_rates VALUES (2,1,'2026-01-01','USD','EUR');
      `);

      // The first migration applies; the second must fail safely on duplicates.
      let result=await executeRunner(dbUrl,"--apply");
      assert.notEqual(result.code,0,"duplicate rates must abort the controlled migration");
      assert.match(result.stderr,/20261111_002_startup_warning_schema|duplicate key/i);
      const applied=await client.query("SELECT migration_name FROM erp_controlled_migration_history ORDER BY migration_name");
      assert.deepEqual(applied.rows.map(x=>x.migration_name),["20261111_001_factory_fixed_production_plans.sql"]);
      const column=await client.query(`SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name='vouchers' AND column_name='supplier_id'`);
      assert.equal(column.rows[0].n,0,"failed migration must roll back its DDL");
      console.log("PASS: failing migration rolls back DDL and leaves prior committed version intact");

      // On this isolated fixture only, repair the duplicate and verify forward recovery.
      await client.query("DELETE FROM exchange_rates WHERE id=2");
      result=await executeRunner(dbUrl,"--apply");
      assert.equal(result.code,0,result.stderr);
      const history=await client.query("SELECT migration_name, checksum FROM erp_controlled_migration_history ORDER BY migration_name");
      assert.equal(history.rows.length,2);
      assert.equal((await client.query("SELECT to_regclass('public.factory_fixed_production_plans') IS NOT NULL AS ok")).rows[0].ok,true);
      assert.equal((await client.query("SELECT to_regclass('public.exchange_rates_company_date_pair_unique') IS NOT NULL AS ok")).rows[0].ok,true);
      console.log("PASS: cleaned isolated fixture resumes and completes both migrations");

      // On an up-to-date DB the rerun performs no mutations.
      result=await executeRunner(dbUrl,"--apply");
      assert.equal(result.code,0,result.stderr);
      assert.match(result.stdout,/already up to date/);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM erp_controlled_migration_history")).rows[0].n,2);
      console.log("PASS: repeat apply is idempotent");

      result=await executeRunner(dbUrl,"--status");
      assert.equal(result.code,0,result.stderr);
      assert.equal(JSON.parse(result.stdout).pending.length,0);
      console.log("PASS: read-only status reports zero pending");

      // Checksum drift must be rejected before schema writes.
      await client.query("UPDATE erp_controlled_migration_history SET checksum=repeat('0',64) WHERE migration_name=$1",["20261111_001_factory_fixed_production_plans.sql"]);
      result=await executeRunner(dbUrl,"--apply");
      assert.notEqual(result.code,0);
      assert.match(result.stderr,/checksum mismatch/i);
      // Restore history strictly inside the disposable test database.
      await client.query("UPDATE erp_controlled_migration_history SET checksum=$1 WHERE migration_name=$2",
        [history.rows[0].checksum,history.rows[0].migration_name]);
      console.log("PASS: modified historical migration checksum rejected");

      // A second runner must refuse to run under an active advisory lock.
      await client.query("SELECT pg_advisory_lock($1)",[lock]);
      try {
        result=await executeRunner(dbUrl,"--apply");
        assert.notEqual(result.code,0);
        assert.match(result.stderr,/Another controlled migration runner holds the lock/);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)",[lock]);
      }
      console.log("PASS: concurrent runner blocked by advisory lock");
    } finally {
      await client.end().catch(()=>{});
    }
  } finally {
    if(created) {
      // All connections to this uniquely created disposable DB have closed.
      await admin.query('DROP DATABASE IF EXISTS "'+dbName+'"').catch(error=>{
        console.error("WARNING: failed to delete disposable "+dbName+": "+error.message);
        process.exitCode=1;
      });
    }
    await admin.end().catch(()=>{});
  }
}
run().catch(error=>{console.error("Phase 8 PostgreSQL migration integration FAILED:",error.stack||String(error));process.exitCode=1;});
