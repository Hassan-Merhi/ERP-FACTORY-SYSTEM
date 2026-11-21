import {
  DEFAULT_CONTAINER_CAPACITY,
  asNonNegativeInteger,
  normalizeContainerCapacity,
  distributeContainerPlannerProducts,
  type ContainerPlannerSourceRow,
  type ContainerPlannerPreview,
  type ContainerPlannerOptions,
  type SavedPlannerContainer,
  type ContainerPlannerReconciliationProduct,
  type ContainerPlannerReconciliation,
} from "./containerPlannerHelpers";
export {
  DEFAULT_CONTAINER_CAPACITY,
  MAX_CONTAINER_CAPACITY,
  normalizeContainerCapacity,
  distributeContainerPlannerProducts,
  rebalanceUnlockedContainerPlan,
  type ContainerPlannerSourceRow,
  type ContainerPlannerProductPlan,
  type ContainerPlannerContainer,
  type ContainerPlannerPreview,
  type ContainerPlannerOptions,
  type SavedPlannerLine,
  type SavedPlannerContainer,
  type RebalancedUnlockedContainer,
  type ContainerPlannerReconciliationStatus,
  type ContainerPlannerReconciliationProduct,
  type ContainerPlannerReconciliation,
} from "./containerPlannerHelpers";

/**
 * Builds a deterministic, read-only preview from V5 Stock Allocation values.
 *
 * The source of truth remains V5's freeToPromise calculation:
 *   stockAvailable - expectedToLoad - totalLoaded.
 *
 * No bale IDs are reserved and no customer/container rows are written here.
 */
export function buildContainerPlannerPreview(
  rows: ContainerPlannerSourceRow[],
  requestedCapacity = DEFAULT_CONTAINER_CAPACITY,
  options: ContainerPlannerOptions = {}
): ContainerPlannerPreview {
  const capacity = normalizeContainerCapacity(requestedCapacity);
  const includeGarbageWipers = options.includeGarbageWipers === true;

  const totalStockAvailable = rows.reduce((sum, row) => sum + asNonNegativeInteger(row.stockAvailable), 0);
  const customerCommitted = rows.reduce((sum, row) => sum + asNonNegativeInteger(row.expectedToLoad), 0);
  const alreadyLoading = rows.reduce((sum, row) => sum + asNonNegativeInteger(row.totalLoaded), 0);
  const shortageBales = rows.reduce(
    (sum, row) =>
      sum + (Number.isFinite(row.freeToPromise) && row.freeToPromise < 0 ? Math.abs(Math.trunc(row.freeToPromise)) : 0),
    0
  );

  const eligibleRows = rows
    .map((row) => ({
      articleCode: row.articleCode,
      productName: row.productName || row.articleCode,
      plannableQty: asNonNegativeInteger(row.freeToPromise),
      isExcluded: row.isGarbageOrWipers === true,
    }))
    .filter((row) => row.plannableQty > 0);

  const excludedFromPlan = eligibleRows.reduce(
    (sum, row) => sum + (!includeGarbageWipers && row.isExcluded ? row.plannableQty : 0),
    0
  );

  const plannableRows = eligibleRows
    .filter((row) => includeGarbageWipers || !row.isExcluded)
    .sort((a, b) => a.productName.localeCompare(b.productName) || a.articleCode.localeCompare(b.articleCode));

  const totalPlannable = plannableRows.reduce((sum, row) => sum + row.plannableQty, 0);
  const containerCount = totalPlannable > 0 ? Math.ceil(totalPlannable / capacity) : 0;

  if (containerCount === 0) {
    return {
      capacity,
      containerCount: 0,
      totalPlannable: 0,
      averageBalesPerContainer: 0,
      totalStockAvailable,
      customerCommitted,
      alreadyLoading,
      shortageBales,
      excludedFromPlan,
      products: [],
      containers: [],
    };
  }

  const distributed = distributeContainerPlannerProducts(
    plannableRows.map((row) => ({
      articleCode: row.articleCode,
      productName: row.productName,
      qty: row.plannableQty,
    })),
    containerCount
  );

  const containers = distributed.totals.map((totalBales, index) => ({
    index,
    label: `Container ${index + 1}`,
    totalBales,
    fillPercent: capacity > 0 ? (totalBales / capacity) * 100 : 0,
  }));

  return {
    capacity,
    containerCount,
    totalPlannable,
    averageBalesPerContainer: totalPlannable / containerCount,
    totalStockAvailable,
    customerCommitted,
    alreadyLoading,
    shortageBales,
    excludedFromPlan,
    products: distributed.products,
    containers,
  };
}

/**
 * Compares a saved planning draft with the current authoritative V5 stock
 * picture. Positive deltas are newly available/unplanned stock. Negative
 * deltas are quantities the saved plan now overstates. Locked conflicts are
 * reported separately because Phase 3 never silently edits a locked container.
 */
export function buildContainerPlanReconciliation(
  rows: ContainerPlannerSourceRow[],
  containers: SavedPlannerContainer[],
  options: ContainerPlannerOptions = {}
): ContainerPlannerReconciliation {
  const includeGarbageWipers = options.includeGarbageWipers === true;
  const sourceByArticle = new Map<string, ContainerPlannerSourceRow>();
  const plannedByArticle = new Map<string, { productName: string; plannedQty: number; lockedQty: number }>();

  for (const row of rows) {
    if (!row.articleCode) continue;
    sourceByArticle.set(row.articleCode, row);
  }

  for (const container of containers) {
    for (const line of container.lines) {
      const qty = asNonNegativeInteger(line.plannedQty);
      if (qty <= 0 || !line.articleCode) continue;
      const existing = plannedByArticle.get(line.articleCode);
      plannedByArticle.set(line.articleCode, {
        productName: line.productName || existing?.productName || line.articleCode,
        plannedQty: (existing?.plannedQty ?? 0) + qty,
        lockedQty: (existing?.lockedQty ?? 0) + (container.isLocked ? qty : 0),
      });
    }
  }

  const articleCodes = new Set<string>([...sourceByArticle.keys(), ...plannedByArticle.keys()]);
  const products: ContainerPlannerReconciliationProduct[] = [];

  let currentStockTotal = 0;
  let currentCommittedTotal = 0;
  let currentLoadingTotal = 0;
  let currentPlannableTotal = 0;
  let stockShortageTotal = 0;
  let excludedCurrentFreeTotal = 0;

  for (const row of rows) {
    currentStockTotal += asNonNegativeInteger(row.stockAvailable);
    currentCommittedTotal += asNonNegativeInteger(row.expectedToLoad);
    currentLoadingTotal += asNonNegativeInteger(row.totalLoaded);
    if (Number.isFinite(row.freeToPromise) && row.freeToPromise < 0) {
      stockShortageTotal += Math.abs(Math.trunc(row.freeToPromise));
    }
    const freeQty = asNonNegativeInteger(row.freeToPromise);
    if (!includeGarbageWipers && row.isGarbageOrWipers === true) {
      excludedCurrentFreeTotal += freeQty;
    } else {
      currentPlannableTotal += freeQty;
    }
  }

  for (const articleCode of articleCodes) {
    const source = sourceByArticle.get(articleCode);
    const planned = plannedByArticle.get(articleCode);
    const excluded = !includeGarbageWipers && source?.isGarbageOrWipers === true;
    const currentPlannableQty = excluded ? 0 : asNonNegativeInteger(source?.freeToPromise ?? 0);
    const plannedQty = planned?.plannedQty ?? 0;
    const lockedQty = planned?.lockedQty ?? 0;
    const deltaQty = currentPlannableQty - plannedQty;
    const unplannedQty = Math.max(deltaQty, 0);
    const overplannedQty = Math.max(-deltaQty, 0);
    const lockedConflictQty = Math.max(lockedQty - currentPlannableQty, 0);

    if (plannedQty === 0 && currentPlannableQty === 0 && lockedConflictQty === 0) continue;

    products.push({
      articleCode,
      productName: source?.productName || planned?.productName || articleCode,
      plannedQty,
      lockedQty,
      currentPlannableQty,
      deltaQty,
      unplannedQty,
      overplannedQty,
      lockedConflictQty,
    });
  }

  products.sort((a, b) => a.productName.localeCompare(b.productName) || a.articleCode.localeCompare(b.articleCode));

  const plannedTotal = products.reduce((sum, product) => sum + product.plannedQty, 0);
  const unplannedTotal = products.reduce((sum, product) => sum + product.unplannedQty, 0);
  const overplannedTotal = products.reduce((sum, product) => sum + product.overplannedQty, 0);
  const lockedConflictTotal = products.reduce((sum, product) => sum + product.lockedConflictQty, 0);

  return {
    status:
      lockedConflictTotal > 0 ? "LOCKED_CONFLICT" : unplannedTotal > 0 || overplannedTotal > 0 ? "DRIFT" : "IN_SYNC",
    currentStockTotal,
    currentCommittedTotal,
    currentLoadingTotal,
    currentPlannableTotal,
    stockShortageTotal,
    excludedCurrentFreeTotal,
    plannedTotal,
    unplannedTotal,
    overplannedTotal,
    lockedConflictTotal,
    products,
  };
}
