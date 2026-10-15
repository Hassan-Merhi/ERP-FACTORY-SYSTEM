/**
 * Non-financial presentation only. Batch costs are the saved historical source
 * values. Never reprice sources from current raw materials or touch the ledger.
 */
export type MixBatchTargetTons = 15 | 17.5 | 20;
export const MIX_BATCH_TARGET_OPTIONS: readonly MixBatchTargetTons[] = [15, 17.5, 20] as const;

/** Round up to the next plan tier (user examples: 16t -> 17.5t, 18.1t -> 20t).
 * Above 20 tonnes, the largest tier remains selected and actual overweight
 * is visible in the variance column.
 */
export function selectMixBatchTarget(weightKg: number): MixBatchTargetTons {
  if (weightKg <= 15000) return 15;
  if (weightKg <= 17500) return 17.5;
  return 20;
}

export interface MixBatchReportSource {
  id: number;
  sourceName: string;
  weightKg: number;
  totalCost: number;
  categoryId?: number | null;
  categoryName?: string | null;
  supplierId?: number | null;
  sourceBatchId?: number | null;
}

export interface MixBatchSupplierCategory {
  id: number;
  name: string;
  displayOrder?: number;
}

export interface MixBatchSupplierCategoryLink {
  id: number;
  supplierCategoryId?: number | null;
}

export interface MixBatchCategoryReportRow {
  id: string;
  name: string;
  weightKg: number;
  totalCost: number;
  averageCostPerKg: number;
  targetKg: number | null;
  differenceKg: number | null;
}

const num = (value: number | string | null | undefined): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function mixBatchCategoryTargetKg(
  categoryId: number | "uncategorized",
  selectedTons: MixBatchTargetTons,
  allocations: Record<string, number>,
  suppliers: MixBatchSupplierCategoryLink[],
): number | null {
  const key = `cat:${categoryId}`;
  // A saved category allocation of exactly zero is a legitimate plan target.
  const base20 = Object.prototype.hasOwnProperty.call(allocations, key)
    ? num(allocations[key])
    : suppliers
      .filter(s => categoryId === "uncategorized"
        ? s.supplierCategoryId == null
        : s.supplierCategoryId === categoryId)
      .reduce((sum, s) => sum + num(allocations[String(s.id)]), 0);
  return base20 * selectedTons / 20;
}

/**
 * Combine supplier-origin source rows in their current Raw Materials category.
 * Include categories with planned weight but no material opened, so a missing
 * target is visible in red. Unknown/existing-batch sources are kept in a
 * clearly labeled unmapped row with no invented category target.
 */
export function buildMixBatchCategoryReport(
  sources: MixBatchReportSource[],
  categories: MixBatchSupplierCategory[],
  allocations: Record<string, number> | null,
  suppliers: MixBatchSupplierCategoryLink[],
  selectedTons: MixBatchTargetTons,
): MixBatchCategoryReportRow[] {
  const grouped = new Map<string, { id: string; name: string; weightKg: number; totalCost: number }>();
  const known = new Map(categories.map(c => [c.id, c.name]));
  for (const s of sources) {
    const cat = s.categoryId !== null && s.categoryId !== undefined && known.has(s.categoryId)
      ? s.categoryId : null;
    // Source batches cannot be safely attributed to a supplier category.
    // A supplier source without an assigned category belongs to the saved
    // Fixed Production Planner's "cat:uncategorized" pool instead.
    const isUncategorizedSupplier = cat === null && s.sourceBatchId == null && s.supplierId != null;
    const id = cat !== null ? `cat:${cat}`
      : isUncategorizedSupplier ? "cat:uncategorized" : "unmapped";
    const name = cat !== null ? known.get(cat)!
      : isUncategorizedSupplier ? "Uncategorized" : "Existing Batch / Unmapped";
    const row = grouped.get(id) ?? { id, name, weightKg: 0, totalCost: 0 };
    row.weightKg += num(s.weightKg);
    row.totalCost += num(s.totalCost);
    grouped.set(id, row);
  }
  if (allocations !== null) {
    const uncategorizedTarget = mixBatchCategoryTargetKg("uncategorized", selectedTons, allocations, suppliers);
    if (uncategorizedTarget !== null && uncategorizedTarget > 0 && !grouped.has("cat:uncategorized")) {
      grouped.set("cat:uncategorized", { id: "cat:uncategorized", name: "Uncategorized", weightKg: 0, totalCost: 0 });
    }
    for (const cat of categories) {
      const target = mixBatchCategoryTargetKg(cat.id, selectedTons, allocations, suppliers);
      if (target && target > 0 && !grouped.has(`cat:${cat.id}`)) {
        grouped.set(`cat:${cat.id}`, { id: `cat:${cat.id}`, name: cat.name, weightKg: 0, totalCost: 0 });
      }
    }
  }
  const categoryOrder = new Map([...categories]
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.name.localeCompare(b.name))
    .map((c, i) => [`cat:${c.id}`, i]));
  return [...grouped.values()]
    .sort((a, b) => (categoryOrder.get(a.id) ?? 99999) - (categoryOrder.get(b.id) ?? 99999) || a.name.localeCompare(b.name))
    .map(row => {
      const categoryId = row.id === "cat:uncategorized" ? "uncategorized"
        : row.id.startsWith("cat:") ? Number(row.id.slice(4)) : null;
      const targetKg = allocations !== null && categoryId !== null
        ? mixBatchCategoryTargetKg(categoryId, selectedTons, allocations, suppliers) : null;
      return {
        ...row,
        averageCostPerKg: row.weightKg > 0 ? row.totalCost / row.weightKg : 0,
        targetKg,
        differenceKg: targetKg === null ? null : row.weightKg - targetKg,
      };
    });
}
