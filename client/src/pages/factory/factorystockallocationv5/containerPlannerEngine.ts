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

function asNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export function normalizeContainerCapacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONTAINER_CAPACITY;
  return Math.min(MAX_CONTAINER_CAPACITY, Math.max(1, Math.trunc(value)));
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
    (sum, row) => sum + (Number.isFinite(row.freeToPromise) && row.freeToPromise < 0 ? Math.abs(Math.trunc(row.freeToPromise)) : 0),
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

  const containerTotals = Array<number>(containerCount).fill(0);
  const products: ContainerPlannerProductPlan[] = [];

  for (const row of plannableRows) {
    const baseQty = Math.floor(row.plannableQty / containerCount);
    const remainder = row.plannableQty % containerCount;
    const allocations = Array<number>(containerCount).fill(baseQty);

    if (baseQty > 0) {
      for (let index = 0; index < containerCount; index += 1) {
        containerTotals[index] += baseQty;
      }
    }

    // Give each remainder bale to the currently lightest containers. Re-sorting
    // per product keeps total container loads within one bale of each other while
    // also spreading every SKU across the plan as evenly as integer quantities allow.
    const lightestFirst = Array.from({ length: containerCount }, (_, index) => index).sort(
      (a, b) => containerTotals[a] - containerTotals[b] || a - b
    );

    for (let i = 0; i < remainder; i += 1) {
      const containerIndex = lightestFirst[i];
      allocations[containerIndex] += 1;
      containerTotals[containerIndex] += 1;
    }

    products.push({
      articleCode: row.articleCode,
      productName: row.productName,
      plannableQty: row.plannableQty,
      allocations,
    });
  }

  const containers = containerTotals.map((totalBales, index) => ({
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
    products,
    containers,
  };
}
