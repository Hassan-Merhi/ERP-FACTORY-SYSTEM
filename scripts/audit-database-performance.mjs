#!/usr/bin/env node
/**
 * Aggregate, read-only PostgreSQL performance telemetry.
 * Does not EXPLAIN ANALYZE, execute workload, create/drop indexes or alter settings.
 * Uses database views without collecting SQL text, user data or customer identifiers.
 */
import process from "node:process";
import pg from "pg";
import { resolveDatabaseSsl } from "../server/lib/databaseSsl.mjs";
import { summarizeDatabasePerformance } from "./database-performance-core.mjs";

async function run() {
  if (process.argv.slice(2).some(x=>x!=="--json")) throw new Error("Only --json is supported");
  const connectionString=process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client=new pg.Client({connectionString,ssl:resolveDatabaseSsl(connectionString),connectionTimeoutMillis:15000});
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SET LOCAL lock_timeout = '5s'");

    const tables=await client.query(`
      SELECT relname AS relation,
             seq_scan::text AS seq_scans,
             idx_scan::text AS index_scans,
             seq_tup_read::text AS seq_rows,
             n_live_tup::text AS live_rows,
             n_dead_tup::text AS dead_rows
      FROM pg_stat_user_tables
      WHERE schemaname='public' ORDER BY relname`);

    const indexes=await client.query(`
      SELECT idx.relname AS relation, idx.indexrelname AS index,
             idx.idx_scan::text AS scans, pg_relation_size(idx.indexrelid)::text AS bytes,
             ix.indisprimary AS primary, ix.indisunique AS unique,
             EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=idx.indexrelid) AS "constraintBacked"
      FROM pg_stat_user_indexes idx
      JOIN pg_index ix ON ix.indexrelid=idx.indexrelid
      WHERE idx.schemaname='public' ORDER BY idx.relname,idx.indexrelname`);

    // No application query text or session settings are read or returned.
    const activity=await client.query(`
      SELECT wait_event_type,
             EXTRACT(EPOCH FROM (clock_timestamp()-xact_start))::numeric AS xact_seconds
      FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active'`);

    const extension=await client.query("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements') AS installed");
    const statsAvailable=extension.rows[0]?.installed===true;
    // pg_stat_statements may be installed but current role lacks SELECT permission.
    // Avoid reading query texts; collect only aggregate metrics if permitted.
    let statements=[];
    let statementsReadable=false;
    if(statsAvailable) {
      try {
        const top=await client.query(`
          SELECT calls::text AS calls,
                 ROUND(total_exec_time::numeric,2)::text AS total_execution_ms,
                 ROUND(mean_exec_time::numeric,2)::text AS mean_execution_ms,
                 rows::text AS rows
          FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10`);
        statements=top.rows;
        statementsReadable=true;
      } catch(error) {
        // Query permission failures abort the transaction; use a SAVEPOINT
        // around optional extension reads to preserve the read-only audit.
        if(error.code!=="42501" && error.code!=="42P01") throw error;
        throw new Error("pg_stat_statements is present but unavailable; grant read-only stats permission or disable the extension check");
      }
    }
    const result=summarizeDatabasePerformance({
      tables:tables.rows,indexes:indexes.rows,activity:activity.rows,
      statsAvailable:statementsReadable,statements
    });
    await client.query("ROLLBACK");
    console.log(JSON.stringify(result,null,2));
  } catch(error) {
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  } finally {
    await client.end().catch(()=>{});
  }
}
run().catch(error=>{console.error("Database performance audit failed:",error instanceof Error?error.message:String(error));process.exitCode=2;});
