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
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "../server/lib/databaseSsl.mjs";
import { compareFullSchemaFingerprint } from "./database-full-schema-fingerprint-core.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const runner=path.join(root,"scripts/run-controlled-migrations.mjs");
const driftRunner=path.join(root,"scripts/audit-database-schema-drift.mjs");
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

async function executeDriftFingerprint(dbUrl) {
  return await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[driftRunner,"--fingerprint"],{
      cwd:root,env:{...process.env,DATABASE_URL:dbUrl,PGSSLMODE:"disable"},
      stdio:["ignore","pipe","pipe"]
    });
    let stdout="",stderr="";
    child.stdout.on("data",d=>stdout+=d.toString());
    child.stderr.on("data",d=>stderr+=d.toString());
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
    // PostgreSQL inside a GitHub Actions Docker service reports its Docker
    // bridge address even though the test connects through 127.0.0.1.
    // Constrain the configured connection URL to loopback (checked above),
    // create only unique disposable databases, and require explicit test opt-in.
    await admin.query('CREATE DATABASE "'+dbName+'"');
    created=true;
    const dbUrl=connectionFor(dbName);
    const client=new pg.Client({connectionString:dbUrl,ssl:false});
    try {
      await client.connect();
      // Minimal legacy schema required by the two controlled migrations.
      await client.query(`
        CREATE TABLE companies (id integer PRIMARY KEY);
        CREATE TABLE insurance_members (id integer PRIMARY KEY);
        CREATE TABLE stock_items (id integer PRIMARY KEY);
        CREATE TABLE containers (id integer PRIMARY KEY);
        CREATE TABLE users (id varchar PRIMARY KEY);
        CREATE TABLE factory_containers (id integer PRIMARY KEY, company_id integer, container_number text);
        CREATE TABLE factory_categories (id integer PRIMARY KEY);
        CREATE TABLE factory_bale_products (id integer PRIMARY KEY, company_id integer, article_code text);
        CREATE TABLE factory_bales (id integer PRIMARY KEY);
        CREATE TABLE customer_proforma_lines (id integer PRIMARY KEY);
        CREATE TABLE customer_order_lines (id integer PRIMARY KEY);
        CREATE TABLE customer_order_bales (id integer PRIMARY KEY);
        CREATE TABLE customer_order_bales_history (id integer PRIMARY KEY);
        CREATE TABLE customer_order_expected_lines (id integer PRIMARY KEY);
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

      // Read-only status on a fresh database must not create migration history.
      let result=await executeRunner(dbUrl,"--status");
      assert.equal(result.code,0,result.stderr);
      assert.equal(JSON.parse(result.stdout).historyExists,false);
      assert.equal(JSON.parse(result.stdout).pending.length,12);
      assert.equal((await client.query("SELECT to_regclass('public.erp_controlled_migration_history') AS name")).rows[0].name,null);
      console.log("PASS: fresh status is read-only and detects all pending migrations");

      // The first migration applies; the second must fail safely on duplicates.
      result=await executeRunner(dbUrl,"--apply");
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
      assert.equal(history.rows.length,12);
      assert.equal((await client.query("SELECT to_regclass('public.factory_fixed_production_plans') IS NOT NULL AS ok")).rows[0].ok,true);
      assert.equal((await client.query("SELECT to_regclass('public.exchange_rates_company_date_pair_unique') IS NOT NULL AS ok")).rows[0].ok,true);
      assert.equal((await client.query("SELECT to_regclass('public.user_security_permissions_unique') IS NOT NULL AS ok")).rows[0].ok,true);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='factory_containers' AND column_name='json_cargo_tracking_status'")).rows[0].n,1);
      assert.equal((await client.query("SELECT to_regclass('public.user_language_preferences') IS NOT NULL AS ok")).rows[0].ok,true);
      assert.equal((await client.query("SELECT to_regclass('public.factory_bale_products_company_article_code_normalized_idx') IS NOT NULL AS ok")).rows[0].ok,true);
      assert.equal((await client.query("SELECT to_regprocedure('public.set_customer_order_bale_scanned_at()') IS NOT NULL AS ok")).rows[0].ok,true);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='customer_order_bales' AND column_name='scanned_at'")).rows[0].n,1);
      assert.equal((await client.query("SELECT to_regclass('public.scheduled_whatsapp_occurrences') IS NOT NULL AS ok")).rows[0].ok,true);
      assert.equal((await client.query("SELECT to_regclass('public.scheduled_whatsapp_attachments') IS NOT NULL AS ok")).rows[0].ok,true);
      assert.equal((await client.query("SELECT to_regclass('public.insurance_member_monthly_amounts') IS NOT NULL AS ok")).rows[0].ok,true);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='stock_items' AND column_name='selling_price'")).rows[0].n,1);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='sp_containers' AND column_name='document_charges_usd'")).rows[0].n,1);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='containers' AND column_name='port_departure_date'")).rows[0].n,1);
      console.log("PASS: cleaned isolated fixture resumes and completes all controlled migrations");

      // Phase 4: execute the real repository tenant-control migration against
      // the disposable database. Never apply or test writes on production.
      await client.query(`
        ALTER TABLE ledger_accounts ADD COLUMN company_id integer;
        CREATE TABLE locations (id integer PRIMARY KEY, company_id integer NOT NULL);
        CREATE TABLE user_company_roles (
          id integer PRIMARY KEY,user_id varchar,company_id integer,
          assigned_location_id integer,cash_account_id integer
        );
        CREATE TABLE user_locations (
          id integer PRIMARY KEY,user_id varchar,company_id integer,location_id integer
        );
        CREATE TABLE user_location_cash_accounts (
          id integer PRIMARY KEY,user_id varchar,company_id integer,
          location_id integer,cash_account_id integer
        );
        CREATE TABLE role_feature_permissions (id integer PRIMARY KEY,company_id integer);
        INSERT INTO companies(id) VALUES (2);
        INSERT INTO users(id) VALUES ('phase4-user');
        INSERT INTO locations(id,company_id) VALUES (10,1),(20,2);
        INSERT INTO ledger_accounts(id,company_id) VALUES (101,1),(202,2);
      `);
      const tenantSql=await readFile(path.join(root,"migrations/0013_tenant_control_integrity_guards.sql"),"utf8");
      await client.query(tenantSql);

      const expectRejected=async (sql,code="23514")=>{
        await assert.rejects(client.query(sql),error=>error.code===code,
          "Database must enforce company boundary with SQLSTATE "+code);
      };
      await expectRejected(`
        INSERT INTO user_company_roles(id,user_id,company_id,assigned_location_id)
        VALUES (1,'phase4-user',1,20)`);
      await expectRejected(`
        INSERT INTO user_location_cash_accounts(id,user_id,company_id,location_id,cash_account_id)
        VALUES (1,'phase4-user',1,10,202)`);
      await expectRejected(`
        INSERT INTO user_company_roles(id,user_id,company_id,assigned_location_id)
        VALUES (2,'phase4-user',99,NULL)`,"23503");
      await client.query(`
        INSERT INTO user_company_roles(id,user_id,company_id,assigned_location_id,cash_account_id)
        VALUES (3,'phase4-user',1,10,101);
        INSERT INTO user_locations(id,user_id,company_id,location_id)
        VALUES (3,'phase4-user',1,10);
        INSERT INTO user_location_cash_accounts(id,user_id,company_id,location_id,cash_account_id)
        VALUES (3,'phase4-user',1,10,101)
      `);
      await expectRejected("UPDATE locations SET company_id=2 WHERE id=10");
      await expectRejected("UPDATE ledger_accounts SET company_id=2 WHERE id=101");
      assert.equal((await client.query("SELECT company_id FROM locations WHERE id=10")).rows[0].company_id,1);
      assert.equal((await client.query("SELECT company_id FROM ledger_accounts WHERE id=101")).rows[0].company_id,1);
      console.log("PASS: live tenant-control SQL rejects cross-company assignments and parent-account moves");

      // Phase 5: execute the real read-only PostgreSQL catalog collector.
      // Compare a fingerprint before/after a scratch-only view addition.
      const before=await executeDriftFingerprint(dbUrl);
      assert.equal(before.code,0,before.stderr);
      const reference=JSON.parse(before.stdout);
      assert.equal(reference.coverage,"full-public-schema-catalog");
      assert.ok(Object.hasOwn(reference.objects,"functions"));
      await client.query("CREATE VIEW phase5_schema_drift_fixture AS SELECT id FROM companies");
      const after=await executeDriftFingerprint(dbUrl);
      assert.equal(after.code,0,after.stderr);
      const changed=compareFullSchemaFingerprint(reference,JSON.parse(after.stdout));
      assert.equal(changed.ok,false);
      assert.ok(changed.blockers.some(x=>x.includes("phase5_schema_drift_fixture")));
      await client.query("DROP VIEW phase5_schema_drift_fixture");
      console.log("PASS: read-only catalog fingerprint detects a real PostgreSQL schema change");

      // On an up-to-date DB the rerun performs no mutations.
      result=await executeRunner(dbUrl,"--apply");
      assert.equal(result.code,0,result.stderr);
      assert.match(result.stdout,/already up to date/);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM erp_controlled_migration_history")).rows[0].n,12);
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
