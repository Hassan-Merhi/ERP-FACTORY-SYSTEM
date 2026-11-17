#!/usr/bin/env node
// Full offline mode (Phase A): writes the change-feed install SQL for the exact
// schema of DATABASE_URL to the file given (or stdout). Read-only: it never
// applies anything. A DBA reviews the output and runs it in a maintenance window.
// --grant-to=<role> lets that application role read pages (and nothing else).
import { writeFileSync } from "node:fs";
import pg from "pg";
import { loadPcSyncPolicy, readPublicSchema, resolvePcSyncPolicy } from "../../server/offline/pcSync/tablePolicy.mjs";
import { readPrimaryKeys, renderChangeFeedInstallSql } from "../../server/offline/pcSync/changeFeedSql.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}
const client = new pg.Client({ connectionString });
await client.connect();
try {
  const schema = await readPublicSchema(client);
  const { rules, problems } = resolvePcSyncPolicy(loadPcSyncPolicy(), schema);
  if (problems.length) {
    console.error(`Fix config/pc-sync-table-policy.json first:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const grantTo = args.find((arg) => arg.startsWith("--grant-to="))?.slice("--grant-to=".length);
  const sql = renderChangeFeedInstallSql(rules, await readPrimaryKeys(client), { grantTo });
  const out = args.find((arg) => !arg.startsWith("--"));
  if (out) {
    writeFileSync(out, sql);
    console.error(`Wrote ${out}. Review it before any DBA applies it.`);
  } else {
    process.stdout.write(sql);
  }
} finally {
  await client.end();
}
