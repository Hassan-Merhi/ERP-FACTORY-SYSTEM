#!/usr/bin/env node

/**
 * Applies the Phase 3 heavy-read indexes safely, one statement at a time.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/apply-heavy-read-indexes.mjs
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction, so this script
 * intentionally uses a dedicated client and executes each idempotent statement
 * separately. It never mutates business data.
 */

import fs from "node:fs/promises";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const sqlPath = new URL("../migrations/20260717_phase3_heavy_read_indexes.sql", import.meta.url);
const sqlText = await fs.readFile(sqlPath, "utf8");

// This migration contains only simple CREATE INDEX / ANALYZE statements. Split on
// semicolons after removing full-line comments; no procedural blocks are present.
const statements = sqlText
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

const client = new Client({
  connectionString: databaseUrl,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
  application_name: "etshadierp-phase3-indexes",
});

let completed = 0;

try {
  await client.connect();
  await client.query("SET statement_timeout = 0");
  await client.query("SET lock_timeout = '5s'");

  for (const statement of statements) {
    const label = statement.replace(/\s+/g, " ").slice(0, 120);
    process.stdout.write(`[${completed + 1}/${statements.length}] ${label} ... `);
    try {
      await client.query(statement);
      completed += 1;
      console.log("done");
    } catch (error) {
      console.error("failed");
      console.error(error instanceof Error ? error.message : error);
      console.error(`Stopped after ${completed} successful statement(s). Re-run safely after resolving the error; every index uses IF NOT EXISTS.`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await client.end().catch(() => {});
}

if (completed === statements.length) {
  console.log(`Phase 3 complete: ${completed} statements applied successfully.`);
}
