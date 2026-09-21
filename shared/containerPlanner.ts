export const DEFAULT_CONTAINER_CAPACITY = 600;
export const MAX_CONTAINER_CAPACITY = 5000;

export interface ContainerPlannerSourceRow {
  articleCode: string;
  productName: string;
  stockAvailable: number;
  expectedToLoad: number;
  totalLoaded: number;
  freeToPromise: number;
  isGarbageOrWipers?: boolean;
}

export interface ContainerPlannerProductPlan {
  articleCode: string;
  productName: string;
  plannableQty: number;
  allocations: number[];
}

export interface ContainerPlannerContainer {
  index: number;
  label: string;
  totalBales: number;
  fillPercent: number;
}

export interface ContainerPlannerPreview {
  capacity: number;
  containerCount: number;
  totalPlannable: number;
  averageBalesPerContainer: number;
  totalStockAvailable: number;
  customerCommitted: number;
  alreadyLoading: number;
  shortageBales: number;
  excludedFromPlan: number;
  products: ContainerPlannerProductPlan[];
  containers: ContainerPlannerContainer[];
}

export interface ContainerPlannerOptions {
  includeGarbageWipers?: boolean;
}

export interface SavedPlannerLine {
  articleCode: string;
  productName: string;
  plannedQty: number;
}

export interface SavedPlannerContainer {
  id: number;
  position: number;
  isLocked: boolean;
  lines: SavedPlannerLine[];
}

export interface RebalancedUnlockedContainer {
  containerId: number;
  lines: SavedPlannerLine[];
}

export type ContainerPlannerReconciliationStatus = "IN_SYNC" | "DRIFT" | "LOCKED_CONFLICT";

export interface ContainerPlannerReconciliationProduct {
  articleCode: string;
  productName: string;
  plannedQty: number;
  lockedQty: number;
  currentPlannableQty: number;
  deltaQty: number;
  unplannedQty: number;
  overplannedQty: number;
  lockedConflictQty: number;
}

export interface ContainerPlannerReconciliation {
  status: ContainerPlannerReconciliationStatus;
  currentStockTotal: number;
  currentCommittedTotal: number;
  currentLoadingTotal: number;
  currentPlannableTotal: number;
  stockShortageTotal: number;
  excludedCurrentFreeTotal: number;
  plannedTotal: number;
  unplannedTotal: number;
  overplannedTotal: number;
  lockedConflictTotal: number;
  products: ContainerPlannerReconciliationProduct[];
}

function asNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function normalizeContainerCapacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONTAINER_CAPACITY;
  return Math.min(MAX_CONTAINER_CAPACITY, Math.max(1, Math.trunc(value)));
}

export function distributeContainerPlannerProducts(
  products: Array<{ articleCode: string; productName: string; qty: number }>,
  containerCount: number
): { totals: number[]; products: ContainerPlannerProductPlan[] } {
  if (containerCount <= 0) {
    return { totals: [], products: [] };
  }

  const containerTotals = Array<number>(containerCount).fill(0);
  const plannedProducts: ContainerPlannerProductPlan[] = [];

  for (const row of products) {
    const qty = asNonNegativeInteger(row.qty);
    if (qty <= 0) continue;

    const baseQty = Math.floor(qty / containerCount);
    const remainder = qty % containerCount;
    const allocations = Array<number>(containerCount).fill(baseQty);

    if (baseQty > 0) {
      for (let index = 0; index < containerCount; index += 1) {
        containerTotals[index] += baseQty;
      }
    }

    const lightestFirst = Array.from({ length: containerCount }, (_, index) => index).sort(
      (a, b) => containerTotals[a] - containerTotals[b] || a - b
    );

    for (let i = 0; i < remainder; i += 1) {
      const containerIndex = lightestFirst[i];
      allocations[containerIndex] += 1;
      containerTotals[containerIndex] += 1;
    }

    plannedProducts.push({
      articleCode: row.articleCode,
      productName: row.productName,
      plannableQty: qty,
      allocations,
    });
  }

  return { totals: containerTotals, products: plannedProducts };
}

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
 * Rebalances only unlocked saved containers while preserving every locked
 * container byte-for-byte. Product totals across the whole plan stay unchanged.
 */
export function rebalanceUnlockedContainerPlan(
  containers: SavedPlannerContainer[],
  requestedCapacity: number
): RebalancedUnlockedContainer[] {
  const capacity = normalizeContainerCapacity(requestedCapacity);
  const unlocked = containers
    .filter((container) => !container.isLocked)
    .sort((a, b) => a.position - b.position || a.id - b.id);

  const totalByProduct = new Map<string, { productName: string; qty: number }>();
  const lockedByProduct = new Map<string, number>();

  for (const container of containers) {
    const containerTotal = container.lines.reduce((sum, line) => sum + asNonNegativeInteger(line.plannedQty), 0);
    if (containerTotal > capacity) {
      throw new Error(`Container ${container.position + 1} exceeds the ${capacity}-bale capacity.`);
    }

    for (const line of container.lines) {
      const qty = asNonNegativeInteger(line.plannedQty);
      const existing = totalByProduct.get(line.articleCode);
      totalByProduct.set(line.articleCode, {
        productName: line.productName || line.articleCode,
        qty: (existing?.qty ?? 0) + qty,
      });
      if (container.isLocked) {
        lockedByProduct.set(line.articleCode, (lockedByProduct.get(line.articleCode) ?? 0) + qty);
      }
    }
  }

  const remainingProducts = Array.from(totalByProduct.entries())
    .map(([articleCode, total]) => ({
      articleCode,
      productName: total.productName,
      qty: Math.max(total.qty - (lockedByProduct.get(articleCode) ?? 0), 0),
    }))
    .filter((row) => row.qty > 0)
    .sort((a, b) => a.productName.localeCompare(b.productName) || a.articleCode.localeCompare(b.articleCode));

  const totalRemaining = remainingProducts.reduce((sum, row) => sum + row.qty, 0);
  if (totalRemaining === 0) {
    return unlocked.map((container) => ({ containerId: container.id, lines: [] }));
  }
  if (unlocked.length === 0) {
    throw new Error("All containers are locked. Unlock at least one container before rebalancing.");
  }

  const unlockedCapacity = unlocked.length * capacity;
  if (totalRemaining > unlockedCapacity) {
    throw new Error(
      `Unlocked containers can hold ${unlockedCapacity.toLocaleString()} bales, but ${totalRemaining.toLocaleString()} bales still need placement. Unlock more containers first.`
    );
  }

  const distributed = distributeContainerPlannerProducts(remainingProducts, unlocked.length);
  if (distributed.totals.some((total) => total > capacity)) {
    throw new Error("The remaining plan cannot fit inside the unlocked container capacity.");
  }

  return unlocked.map((container, containerIndex) => ({
    containerId: container.id,
    lines: distributed.products
      .map((product) => ({
        articleCode: product.articleCode,
        productName: product.productName,
        plannedQty: product.allocations[containerIndex] ?? 0,
      }))
      .filter((line) => line.plannedQty > 0),
  }));
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
