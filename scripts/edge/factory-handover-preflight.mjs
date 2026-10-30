#!/usr/bin/env node
/**
 * Phase 10/11 LAN operator preflight and monitoring report (read-only).
 *
 *   status    print per-stream evidence counts as JSON (for monitoring)
 *   handover  exit 0 ONLY when every LAN-captured operation, in every stream,
 *             has a verified cloud receipt (applied or operator-rejected).
 *             Run after freezing the LAN (read-only) and before returning
 *             write authority to the cloud or retiring the factory server.
 *
 * Stopping or restarting the LAN server is always data-safe: evidence is
 * committed in PostgreSQL with the business write. This check is about
 * whether the CLOUD has caught up, never about local durability.
 */
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { summarizeLanEvidence } from "../../server/edge/phase10Handover.mjs";

export { summarizeLanEvidence };

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const mode = process.argv[2];
  if (!["status", "handover"].includes(mode) || process.argv.length !== 3) {
    console.error("Usage: node scripts/edge/factory-handover-preflight.mjs status|handover");
    process.exitCode = 2;
  } else {
    const client = new Client({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl: false,
      connectionTimeoutMillis: 8000,
    });
    client
      .connect()
      .then(() => summarizeLanEvidence(client, process.env.FACTORY_EDGE_SITE_ID))
      .then((report) => {
        console.log(JSON.stringify(report, null, 2));
        if (mode === "handover" && !report.handoverReady) {
          console.error(`HANDOVER_BLOCKED: ${report.pendingTotal} LAN operation(s) lack a verified cloud receipt`);
          process.exitCode = 1;
        }
      })
      .catch((error) => {
        console.error("PREFLIGHT_FAILED", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      })
      .finally(() => client.end().catch(() => undefined));
  }
}
