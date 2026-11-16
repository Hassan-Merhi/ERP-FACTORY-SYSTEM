import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const failures = [];

function requireText(relativePath, text, label = text) {
  const contents = read(relativePath);
  if (!contents.includes(text)) failures.push(`${relativePath}: missing ${label}`);
  return contents;
}

function forbidText(relativePath, text, label = text) {
  const contents = read(relativePath);
  if (contents.includes(text)) failures.push(`${relativePath}: contains forbidden ${label}`);
  return contents;
}

const enginePath = "server/services/factory/factoryCostingEngine.ts";
const engine = read(enginePath);
for (const invariant of [
  "FACTORY_COST_PRECISION",
  "calculateCostLine",
  "calculateWeightedAverageCost",
  "calculateMovingAverageRate",
  "calculateRateAfterInventoryValueDelta",
  "calculateRemainingInventoryCorrection",
  "calculateProportionalInventoryValueDelta",
  "formatFactoryLockedRate",
]) {
  if (!engine.includes(invariant)) failures.push(`${enginePath}: missing ${invariant}`);
}
for (const forbidden of ["@shared/schema", "../../db", ".insert(", ".update(", ".delete("]) {
  if (engine.includes(forbidden)) failures.push(`${enginePath}: contains database dependency ${forbidden}`);
}

const stableFallbackPath = "server/services/factory/rawStockStableCost.ts";
const stableFallback = requireText(
  stableFallbackPath,
  "calculateWeightedAverageCost",
  "central weighted fallback",
);
forbidText(stableFallbackPath, "weightedCostSumD", "inline receipt-weighted total");
forbidText(stableFallbackPath, "totalReceivedKgD", "inline receipt-weighted denominator");

const lockedRatePath = "server/services/factory/rawStockLockedRate.ts";
const lockedRate = requireText(
  lockedRatePath,
  'from "./factoryCostingEngine"',
  "central costing engine import",
);
for (const invariant of [
  "calculateMovingAverageRate",
  "formatFactoryLockedRate",
  "calculateCostLine",
  "getAuthoritativeSupplierRemainingKg",
  "getLockedSupplierRate",
]) {
  if (!lockedRate.includes(invariant)) failures.push(`${lockedRatePath}: missing ${invariant}`);
}
forbidText(lockedRatePath, "oldRemaining.times(oldLockedRate)", "inline moving-average formula");

const cascadePath = "server/services/factory/rawStockCostCascade.ts";
const cascade = requireText(
  cascadePath,
  'from "./factoryCostingEngine"',
  "central costing engine import",
);
for (const invariant of [
  "calculateRemainingInventoryCorrection",
  "calculateRateAfterInventoryValueDelta",
  "calculateWeightedAverageCost",
  "calculateCostLine",
  'basis !== "CONTAINER_DIRECT"',
  "assertNoQuantityFields",
]) {
  if (!cascade.includes(invariant)) failures.push(`${cascadePath}: missing ${invariant}`);
}
forbidText(cascadePath, "dTotalCost = dTotalCost.plus", "inline batch weighted-total loop");

const landedPath = "server/services/factory/containerLandedCost.ts";
const landed = read(landedPath);
for (const invariant of [
  "FACTORY_COST_PRECISION",
  "calculateCostLine",
  "factoryCostDecimal",
  "export const COST_SCALE = FACTORY_COST_PRECISION.rate",
]) {
  if (!landed.includes(invariant)) failures.push(`${landedPath}: missing ${invariant}`);
}

const mixBatchPath = "server/services/factory/mixBatchCostingIntegrityService.ts";
const mixBatch = read(mixBatchPath);
for (const invariant of [
  "calculateWeightedAverageCost",
  "calculateCostLine",
  "factoryCostDecimal",
  "MIX_BATCH_SUPPLIER_RATE_DRIFT",
  "expectedUnitCost.eq(unitCost)",
]) {
  if (!mixBatch.includes(invariant)) failures.push(`${mixBatchPath}: missing ${invariant}`);
}

const diagnosticServicePath = "server/services/factory/factoryCostingConsistencyService.ts";
const diagnosticService = read(diagnosticServicePath);
for (const invariant of [
  "getFactoryCostingConsistencyReport",
  "sourceValueMismatchCount",
  "batchHeaderMismatchCount",
  "baleMismatchCount",
  "calculateWeightedAverageCost",
  "calculateCostLine",
]) {
  if (!diagnosticService.includes(invariant)) {
    failures.push(`${diagnosticServicePath}: missing ${invariant}`);
  }
}
for (const forbidden of [".insert(", ".update(", ".delete("]) {
  if (diagnosticService.includes(forbidden)) {
    failures.push(`${diagnosticServicePath}: read-only diagnostic contains ${forbidden}`);
  }
}

const diagnosticRoutePath = "server/routes/factory/raw-stock/rawStockDiagnosticRoutes.ts";
const diagnosticRoutes = read(diagnosticRoutePath);
for (const invariant of [
  '"/api/factory/raw-stock/diagnostics/costing-integrity"',
  'requireRole("Admin", "Developer")',
  "getFactoryCostingConsistencyReport",
]) {
  if (!diagnosticRoutes.includes(invariant)) {
    failures.push(`${diagnosticRoutePath}: missing ${invariant}`);
  }
}

for (const testPath of [
  "tests/factory-costing-engine.test.ts",
  "tests/factory-costing-engine-consolidation-contract.test.ts",
]) {
  if (!fs.existsSync(path.join(root, testPath))) failures.push(`missing focused test: ${testPath}`);
}

const policyPath = ".agents/memory/locked-raw-material-rate.md";
const policy = read(policyPath);
for (const invariant of [
  "factoryCostingEngine.ts",
  "getLockedSupplierRate",
  "computeContainerLandedCost",
  "cascadeContainerCostChange",
  "Supplier-backed source rows",
]) {
  if (!policy.includes(invariant)) failures.push(`${policyPath}: missing ${invariant}`);
}

const completionPath = "docs/archive/engineering/phase5-costing-engine-consolidation.md";
const completion = read(completionPath).toLowerCase();
for (const phrase of [
  "one precision policy",
  "event-driven locked supplier rate",
  "authoritative remaining kg",
  "original agreed quantity",
  "remaining inventory only",
  "supplier-backed",
  "container-direct",
  "persisted source total",
  "read-only costing-integrity diagnostic",
  "verification boundary",
  "merge boundary",
  "ci checks were not run",
]) {
  if (!completion.includes(phrase)) failures.push(`${completionPath}: missing ${phrase}`);
}

if (failures.length > 0) {
  console.error("Phase 5 costing engine consolidation verification failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("Phase 5 costing engine consolidation contracts verified.");
