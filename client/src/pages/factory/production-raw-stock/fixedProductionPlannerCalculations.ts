/** Calculation rules transcribed from the 05 Oct 2026 production-planning workbook.
 * In the workbook: E=G*15/20, F=G*17.5/20, H=IFERROR(D/F,0),
 * I=IFERROR(B/F,0), J=F*26/20000.
 */
export const PLANNER_WORKING_DAYS = 26;
export const PLANNER_CONTAINER_CAPACITY_KG = 20000;
export const PLANNER_OTW_STATUSES = new Set(["PENDING", "IN_TRANSIT", "ARRIVED"]);

export interface FixedPlanSupplier {
  id: number;
  name: string;
  supplierCategoryId?: number | null;
}

export interface FixedPlanCategory {
  id: number;
  name: string;
}
export interface FixedPlanRawStock {
  supplierId: number | null;
  categoryId?: number | null;
  categoryName?: string | null;
  freeKg?: string;
  remainingKg: string;
}
export interface FixedPlanContainer {
  supplierId: number | null;
  totalKg: string | null;
  status: string;
}

export interface FixedProductionPlanRow {
  id: string;
  name: string;
  inHand: number;
  otw: number;
  total: number;
  allocation15: number;
  allocation175: number;
  allocation20: number;
  withOtwDays: number;
  withoutOtwDays: number;
  containersToOrder: number;
}

export type FixedProductionPlanTotals = Omit<FixedProductionPlanRow, "id" | "name">;

function numberOrZero(input: string | number | null | undefined): number {
  const n = Number(input ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function calculateFixedProductionRows(
  suppliers: FixedPlanSupplier[],
  stock: FixedPlanRawStock[],
  containers: FixedPlanContainer[],
  allocations20t: Record<string, number | string>,
): FixedProductionPlanRow[] {
  const inHand = new Map<number, number>();
  for (const row of stock) {
    if (row.supplierId == null) continue;
    inHand.set(row.supplierId,
      (inHand.get(row.supplierId) ?? 0) + numberOrZero(row.freeKg ?? row.remainingKg));
  }

  const otw = new Map<number, number>();
  for (const container of containers) {
    if (container.supplierId == null || !PLANNER_OTW_STATUSES.has(container.status)) continue;
    otw.set(container.supplierId,
      (otw.get(container.supplierId) ?? 0) + numberOrZero(container.totalKg));
  }

  return [...suppliers].sort((a, b) => a.name.localeCompare(b.name)).map((supplier) => {
    const id = String(supplier.id);
    const stockKg = inHand.get(supplier.id) ?? 0;
    const otwKg = otw.get(supplier.id) ?? 0;
    const totalKg = stockKg + otwKg;
    const allocation20 = numberOrZero(allocations20t[id]);
    const allocation15 = allocation20 * 15 / 20;
    const allocation175 = allocation20 * 17.5 / 20;
    return {
      id,
      name: supplier.name,
      inHand: stockKg,
      otw: otwKg,
      total: totalKg,
      allocation15,
      allocation175,
      allocation20,
      // Excel IFERROR(...,0): a blank or zero daily allocation returns zero days.
      withOtwDays: allocation175 > 0 ? totalKg / allocation175 : 0,
      withoutOtwDays: allocation175 > 0 ? stockKg / allocation175 : 0,
      // Fractional count is intentional; Excel did not round up to whole containers.
      containersToOrder: (allocation175 * PLANNER_WORKING_DAYS) / PLANNER_CONTAINER_CAPACITY_KG,
    };
  });
}

/**
 * The planner operates on exactly the same supplier-category IDs that Raw
 * Materials uses for its accordion. Supplier IDs remain the source of stock
 * and incoming container kg, but allocations are saved with a category
 * namespace: "cat:<categoryId>".
 *
 * The original supplier-level values are retained in the stored JSONB so a
 * first category-level view can default to their sum without rewriting
 * history. Once a category allocation is saved, it takes precedence.
 */
export function calculateFixedProductionCategoryRows(
  categories: FixedPlanCategory[],
  suppliers: FixedPlanSupplier[],
  stock: FixedPlanRawStock[],
  containers: FixedPlanContainer[],
  allocations20t: Record<string, number | string>,
): FixedProductionPlanRow[] {
  const supplierCategory = new Map(suppliers.map(s => [s.id, s.supplierCategoryId ?? null]));
  const inHand = new Map<string, number>();
  for (const row of stock) {
    const catId = row.categoryId ?? (row.supplierId != null ? supplierCategory.get(row.supplierId) : null);
    const key = catId == null ? "cat:uncategorized" : `cat:${catId}`;
    inHand.set(key, (inHand.get(key) ?? 0) + numberOrZero(row.freeKg ?? row.remainingKg));
  }
  const otw = new Map<string, number>();
  for (const container of containers) {
    if (container.supplierId == null || !PLANNER_OTW_STATUSES.has(container.status)) continue;
    const catId = supplierCategory.get(container.supplierId);
    const key = catId == null ? "cat:uncategorized" : `cat:${catId}`;
    otw.set(key, (otw.get(key) ?? 0) + numberOrZero(container.totalKg));
  }

  // Include Uncategorized only if there is actually stock/OTW in that bucket;
  // all named categories are filtered by visibleFixedProductionRows below.
  const hasUncategorized = inHand.has("cat:uncategorized") || otw.has("cat:uncategorized");
  const categoryRows = [
    ...categories.map(category => ({ id: `cat:${category.id}`, name: category.name, categoryId: category.id })),
    ...(hasUncategorized ? [{ id: "cat:uncategorized", name: "Uncategorized", categoryId: null }] : []),
  ];
  return categoryRows.sort((a, b) => a.name.localeCompare(b.name)).map(category => {
    const stockKg = inHand.get(category.id) ?? 0;
    const otwKg = otw.get(category.id) ?? 0;
    const totalKg = stockKg + otwKg;
    const legacyTotal = suppliers
      .filter(s => (s.supplierCategoryId ?? null) === category.categoryId)
      .reduce((sum, s) => sum + numberOrZero(allocations20t[String(s.id)]), 0);
    const allocation20 = Object.prototype.hasOwnProperty.call(allocations20t, category.id)
      ? numberOrZero(allocations20t[category.id])
      : legacyTotal;
    const allocation15 = allocation20 * 15 / 20;
    const allocation175 = allocation20 * 17.5 / 20;
    return {
      id: category.id,
      name: category.name,
      inHand: stockKg,
      otw: otwKg,
      total: totalKg,
      allocation15,
      allocation175,
      allocation20,
      withOtwDays: allocation175 > 0 ? totalKg / allocation175 : 0,
      withoutOtwDays: allocation175 > 0 ? stockKg / allocation175 : 0,
      containersToOrder: allocation175 * PLANNER_WORKING_DAYS / PLANNER_CONTAINER_CAPACITY_KG,
    };
  });
}

/**
 * A supplier with no combined stock (neither in hand nor in transit) is not
 * part of the current production plan, even if it has a historic saved 20t
 * allocation. Preserve the allocation in storage separately so it comes back
 * if this supplier has stock again.
 *
 * Compare at the same three-decimal kg precision used in the popup.
 */
export function visibleFixedProductionRows(
  rows: FixedProductionPlanRow[],
): FixedProductionPlanRow[] {
  return rows.filter((row) => Math.abs(row.total) >= 0.0005);
}

export function sumFixedProductionRows(rows: FixedProductionPlanRow[]): FixedProductionPlanTotals {
  return rows.reduce<FixedProductionPlanTotals>((totals, row) => ({
    inHand: totals.inHand + row.inHand,
    otw: totals.otw + row.otw,
    total: totals.total + row.total,
    allocation15: totals.allocation15 + row.allocation15,
    allocation175: totals.allocation175 + row.allocation175,
    allocation20: totals.allocation20 + row.allocation20,
    withOtwDays: totals.withOtwDays + row.withOtwDays,
    withoutOtwDays: totals.withoutOtwDays + row.withoutOtwDays,
    containersToOrder: totals.containersToOrder + row.containersToOrder,
  }), {
    inHand: 0, otw: 0, total: 0,
    allocation15: 0, allocation175: 0, allocation20: 0,
    withOtwDays: 0, withoutOtwDays: 0, containersToOrder: 0,
  });
}
