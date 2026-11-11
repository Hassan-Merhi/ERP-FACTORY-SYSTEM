#!/usr/bin/env node
/**
 * Fail-closed guard before restoring a backup into an isolated PostgreSQL DB.
 * Read-only to the target; does not execute pg_restore or modify any database.
 *
 * Requires:
 *   RESTORE_DATABASE_URL=postgresql://.../isolated_restore
 *   SOURCE_DATABASE_URL=postgresql://.../production (comparison only)
 *   RESTORE_TARGET_CONFIRMATION=ISOLATED_EMPTY_RESTORE
 *
 * The suffix is an extra human-error guard, not proof of isolation. Never
 * provide production credentials as RESTORE_DATABASE_URL.
 */
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "../server/lib/databaseSsl.mjs";

export function parseDbEndpoint(raw) {
  if(!raw) throw new Error("Database URL missing");
  const uri=new URL(raw);
  if(!["postgres:","postgresql:"].includes(uri.protocol)) throw new Error("Expected PostgreSQL URL");
  const db=decodeURIComponent(uri.pathname.replace(/^\//,""));
  if(!db) throw new Error("Database name required");
  return {
    hostname:uri.hostname.toLowerCase(),
    port:uri.port||"5432",
    db,
    user:decodeURIComponent(uri.username||"")
  };
}
export function validateRestoreTarget({source,target,confirmation,tableCount,sourceResolvedAddresses=[],targetResolvedAddresses=[]}) {
  const errors=[];
  if(confirmation!=="ISOLATED_EMPTY_RESTORE") errors.push("Missing exact restore target confirmation");
  if(!/(?:^restore_verify$|_restore(?:_rehearsal)?$|_restore_verify$)/i.test(target.db))
    errors.push("Target database name must explicitly designate an isolated restore");
  if(target.db===source.db &&
     target.hostname===source.hostname && target.port===source.port)
    errors.push("Source and target resolve to the same database endpoint");
  if(sourceResolvedAddresses.some(x=>targetResolvedAddresses.includes(x)) &&
     source.db===target.db && source.port===target.port)
    errors.push("Source and target resolve to the same network address and database");
  if(!Number.isInteger(tableCount)||tableCount!==0)
    errors.push("Restore target is not empty (application tables already exist)");
  return {ok:errors.length===0,errors,targetDatabase:target.db,tableCount};
}

async function main() {
  const sourceRaw=process.env.SOURCE_DATABASE_URL||process.env.BACKUP_DATABASE_URL;
  const targetRaw=process.env.RESTORE_DATABASE_URL;
  const source=parseDbEndpoint(sourceRaw);
  const target=parseDbEndpoint(targetRaw);
  // Use the target's connection string only. This guard never connects to source.
  const client=new pg.Client({connectionString:targetRaw,ssl:resolveDatabaseSsl(targetRaw),connectionTimeoutMillis:10000});
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout='10s'");
    const info=await client.query(`
      SELECT current_database() AS db,
             (SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relkind IN ('r','p','m','S','v','f')) AS object_count`);
    await client.query("ROLLBACK");
    if(info.rows[0]?.db!==target.db) throw new Error("Target connection opened unexpected database");
    const result=validateRestoreTarget({
      source,target,confirmation:process.env.RESTORE_TARGET_CONFIRMATION,
      tableCount:Number(info.rows[0]?.object_count)
    });
    console.log(JSON.stringify({ok:result.ok,targetDatabase:result.targetDatabase,publicObjectCount:result.tableCount,errors:result.errors},null,2));
    if(!result.ok) process.exitCode=1;
  } catch(error) {
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally {
    await client.end().catch(()=>{});
  }
}
if(process.argv[1] && process.argv[1].endsWith("verify-restore-target.mjs")) {
  main().catch(error=>{console.error("Restore target validation failed:",error instanceof Error?error.message:String(error));process.exitCode=2;});
}
