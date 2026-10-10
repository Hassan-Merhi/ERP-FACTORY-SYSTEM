#!/usr/bin/env node

/**
 * Program 6D static safety guard.
 *
 * Protects the database-optimization boundaries that must not be bypassed by
 * future performance work. This script is read-only and does not contact or
 * mutate the database.
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

const audit = read("scripts/audit-program6d-database-query-risks.mjs");
const validator = read("scripts/validate-program6d-query-classifications.mjs");
const runner = read("scripts/run-program6d-query-review.mjs");
const documentation = read("docs/archive/program-6d-database-query-optimization.md");
const netProfitRoute = read("server/routes/stats/statsNetProfitRoutes.ts");
const netProfitDataLoad = read("server/routes/stats/netProfitDataLoad.ts");

assert(audit.includes("possible-n-plus-one"), "6D audit must continue detecting looped database awaits.");
assert(audit.includes("possibly-unbounded-read"), "6D audit must continue detecting potentially unbounded reads.");
assert(audit.includes("sequential-query-candidate"), "6D audit must continue detecting sequential query candidates.");
assert(audit.includes("Do not add indexes without query-plan evidence"), "6D audit must retain the query-plan evidence rule.");
assert(validator.includes("unresolvedHighSeverity"), "6D classification validation must retain a high-severity completion gate.");
assert(validator.includes('classification.status === "deferred"'), "Deferred high-severity findings must remain unresolved in strict mode.");
assert(runner.includes("audit-program6d-database-query-risks.mjs"), "6D review runner must execute the canonical scanner.");
assert(runner.includes("validate-program6d-query-classifications.mjs"), "6D review runner must validate classifications when supplied.");
assert(documentation.includes("Do not add an index from static inspection alone"), "6D documentation must prohibit evidence-free indexes.");
assert(documentation.includes("Pagination must not change totals or balances"), "6D documentation must preserve full-dataset financial totals.");

// The grouped net-profit SQL was extracted from the route into netProfitDataLoad.ts.
// Guard the active loader rather than the old file location so refactors cannot make
// this check fail while the actual company-scoping and mixed-FX protections remain intact.
assert(netProfitRoute.includes("loadNetProfitData(companyId, toDate)"), "Net-profit route must continue using the guarded grouped-data loader.");
assert(
  netProfitDataLoad.includes("WHERE la.company_id = $1"),
  "Net-profit migrated-account attribution must remain account-company scoped (la.company_id = $1)."
);
// Wave 10 moved supplier and employee figures to the one balance engine
// (netPositionParties.ts over ledgerBalanceEngine.ts): every line is scoped to its
// voucher's company, and a line carrying both a debit and a credit is netted
// rather than dropped (the earlier pure-credit/pure-debit filters lost amounts).
const balanceEngine = read("server/services/accounting/balances/ledgerBalanceEngine.ts");
const netPositionParties = read("server/services/accounting/balances/netPositionParties.ts");
assert(
  netProfitDataLoad.includes("netPositionParties"),
  "Net-profit supplier and employee figures must come from the balance engine (netPositionParties)."
);
assert(
  netPositionParties.includes("getPartyBalances"),
  "Net-position party figures must be read through getPartyBalances."
);
assert(
  balanceEngine.includes("v.company_id = ${companyId} AND v.deleted_at IS NULL AND v.optional = false"),
  "Balance-engine lines must remain voucher-company scoped and exclude deleted and optional vouchers."
);
assert(
  balanceEngine.includes("COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0) AS net"),
  "Balance-engine lines carrying both sides must be netted, never dropped."
);

if (failures.length > 0) {
  console.error("Program 6D query-safety verification failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Program 6D query-safety invariants verified.");
