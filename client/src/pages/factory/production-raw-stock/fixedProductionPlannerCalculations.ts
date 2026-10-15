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
}
export interface FixedPlanRawStock {
  supplierId: number | null;
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
