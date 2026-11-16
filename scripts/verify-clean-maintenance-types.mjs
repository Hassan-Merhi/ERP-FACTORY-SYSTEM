#!/usr/bin/env node
/**
 * Freeze cleaned maintenance scripts at zero TypeScript type escapes.
 * The historical source ratchet separately covers server/, client/src/, shared/.
 * Other scripts/tests are not silently grandfathered in as clean.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { countFileEscapes } from "./audit-type-escapes.mjs";

export const CLEAN_MAINTENANCE_SCRIPTS = Object.freeze([
  "scripts/backfill-charge-voucher-fk.ts",
  "scripts/backfill-inventory-company.ts",
  "scripts/backfill-prepaid-rent.ts",
  "scripts/create-admin.ts",
  "scripts/init-db-manual.ts",
  "scripts/repair-factory-commission-fx.ts",
  "scripts/repair-post-offload-cost-cascade.ts",
  "scripts/repair-rental-payment-accounting.ts",
  "scripts/smoke-test-csrf.ts",
]);

export function inspectCleanMaintenanceScripts(read = (file) => readFileSync(resolve(file), "utf8")) {
  const failures = [];
  for (const file of CLEAN_MAINTENANCE_SCRIPTS) {
    let source;
    try { source = read(file); }
    catch (error) {
      failures.push(`${file}: missing/unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const counts = countFileEscapes(file, source);
    const total = counts.explicitAny + counts.asAny + counts.suppressions;
    if (total !== 0) {
      failures.push(`${file}: ${total} type escapes (${counts.explicitAny} explicit any, ${counts.asAny} as any, ${counts.suppressions} suppressions)`);
    }
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const failures = inspectCleanMaintenanceScripts();
  if (failures.length) {
    console.error("Clean maintenance script type gate failed:\n" + failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Clean maintenance scripts verified: ${CLEAN_MAINTENANCE_SCRIPTS.length} files, zero type escapes.`);
  }
}
