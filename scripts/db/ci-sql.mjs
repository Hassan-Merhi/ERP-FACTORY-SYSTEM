#!/usr/bin/env node
/**
 * CI helper: run SQL statements against a DISPOSABLE database URL.
 * Usage: node scripts/db/ci-sql.mjs <database-url> "<sql>" ["<sql>" ...]
 * Refuses any host other than the local CI service container.
 */
import pg from "pg";

const [url, ...statements] = process.argv.slice(2);
const host = new URL(url).hostname;
if (!["127.0.0.1", "localhost"].includes(host)) {
  console.error(`ci-sql refuses non-local database host ${host}`);
  process.exit(2);
}
const client = new pg.Client({ connectionString: url, ssl: false });
await client.connect();
try {
  for (const sql of statements) await client.query(sql);
} finally {
  await client.end();
}
