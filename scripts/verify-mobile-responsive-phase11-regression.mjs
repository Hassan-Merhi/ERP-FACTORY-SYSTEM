#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const checks = [
  ["Critical mobile flows", "node", ["scripts/verify-mobile-responsive-phase1-critical-flows.mjs"]],
  ["Phase 4 forms and dialogs", "node", ["scripts/verify-phase10-dialog-form-consistency.mjs"]],
  ["Phase 5 tables and data lists", "node", ["scripts/verify-mobile-responsive-phase5-tables.mjs"]],
  ["Phase 6 core ERP", "node", ["scripts/verify-mobile-responsive-phase6-core-erp.mjs"]],
  ["Phase 7 Factory", "node", ["scripts/verify-mobile-responsive-phase7-factory.mjs"]],
  ["Phase 8 POS", "node", ["scripts/verify-mobile-responsive-phase8-pos.mjs"]],
  ["Phase 9 dashboards and reports", "node", ["scripts/verify-mobile-responsive-phase9-reports.mjs"]],
  ["Phase 10 performance and offline", "node", ["scripts/verify-mobile-responsive-phase10-performance.mjs"]],
  ["Cross-module UX consistency", "npm", ["run", "audit:ux-consistency"]],
  ["Mobile routing", "npm", ["run", "verify:mobile-web-routing"]],
  ["Bandwidth contracts", "npm", ["run", "verify:bandwidth"]],
  ["Production readiness", "npm", ["run", "verify:final-production-readiness"]],
];

const failures = [];
for (const [name, command, args] of checks) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) failures.push(name);
}

if (failures.length > 0) {
  console.error("\nPhase 11 responsive regression verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      phase: 11,
      status: "complete",
      checks: checks.length,
      sqlRequired: false,
    },
    null,
    2,
  ),
);
