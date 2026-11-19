import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function requireAll(file, values) {
  const text = read(file);
  for (const value of values) {
    if (!text.includes(value)) failures.push(`${file}: missing ${value}`);
  }
  return text;
}

const service = requireAll("server/services/accounting/historicalCurrencyRepairCenter.ts", [
  "planHistoricalCurrencyRepairs",
  "applyHistoricalCurrencyRepairPlan",
  "listHistoricalRepairCases",
  "normalizeVoucherEntryAmounts",
  "normalizeOpeningBalanceCurrency",
  "pg_advisory_xact_lock",
  "current.versionTag !== item.before.versionTag",
  "INSERT INTO audit_log",
  'client.query("BEGIN")',
  'client.query("COMMIT")',
  'client.query("ROLLBACK")',
]);
for (const kind of ["voucherEntry", "ledger", "bank", "customer", "supplier", "employee", "fixedAsset"]) {
  if (!service.includes(`"${kind}"`)) failures.push(`repair center missing kind ${kind}`);
}
for (const forbidden of ["COALESCE(historical_exchange_rate, 1)", "guessRate", "latest exchange rate"]) {
  if (service.includes(forbidden)) failures.push(`repair center contains forbidden rate guessing: ${forbidden}`);
}

requireAll("server/routes/historicalCurrencyRepairCenterRoutes.ts", [
  '"/api/accounts/multi-currency/repair-center"',
  '"/api/accounts/multi-currency/repair-center/plan"',
  '"/api/accounts/multi-currency/repair-center/apply"',
  "signRepairToken",
  "verifyRepairToken",
  'purpose: "historical-currency-repair-center"',
  "plan.fingerprint !== token.fingerprint",
  'code: "STALE_REPAIR_PLAN"',
  "getHistoricalCurrencyReadiness",
]);

requireAll("server/routes/ledgerRoutes.ts", [
  "registerHistoricalCurrencyRepairCenterRoutes",
  "registerHistoricalCurrencyRepairCenterRoutes(app)",
]);

for (const file of [
  "tests/historical-currency-repair-center-contract.test.ts",
  "docs/archive/engineering/phase6-historical-accounting-fx-repair-center.md",
]) {
  if (!fs.existsSync(path.join(root, file))) failures.push(`missing ${file}`);
}

const docs = read("docs/archive/engineering/phase6-historical-accounting-fx-repair-center.md").toLowerCase();
for (const phrase of [
  "read-only diagnosis",
  "explicit approval",
  "signed preview",
  "stale-state protection",
  "transactional apply",
  "audit trail",
  "readiness reconciliation",
  "verification boundary",
  "merge boundary",
]) {
  if (!docs.includes(phrase)) failures.push(`phase6 docs missing ${phrase}`);
}

if (failures.length) {
  console.error("Phase 6 historical accounting and FX repair center verification failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log("Phase 6 historical accounting and FX repair center contracts verified.");
