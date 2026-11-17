#!/usr/bin/env node
// Full offline mode (Phase A): checks config/pc-sync-table-policy.json against
// the live schema of DATABASE_URL. Read-only. Exits 1 when any table is
// unclassified, a parent link does not reach a company, a rule is stale, or a
// secret-looking column is not redacted.
import pg from "pg";
import { loadPcSyncPolicy, readPublicSchema, resolvePcSyncPolicy } from "../../server/offline/pcSync/tablePolicy.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required (a disposable or read-only database).");
  process.exit(2);
}
const client = new pg.Client({ connectionString });
await client.connect();
try {
  const schema = await readPublicSchema(client);
  const { rules, problems } = resolvePcSyncPolicy(loadPcSyncPolicy(), schema);
  const counts = {};
  for (const rule of rules.values()) counts[rule.mode] = (counts[rule.mode] ?? 0) + 1;
  console.log(`PC sync table policy: ${schema.size} tables`, JSON.stringify(counts));
  if (problems.length) {
    console.error(`${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log("Every table is classified.");
  }
} finally {
  await client.end();
}
