/**
 * Types and pure helpers for the Phase 12 cost-center accounting page
 * (CostCenterAccounting.tsx), kept separate so the page stays under the
 * repository's 900-line file cap.
 */
export type Category = "income" | "cost_of_sales" | "expense";
export type Module = "ERP" | "FACTORY" | "PROPERTIES" | "SHARED";
export type Status = {
  actualUsd: string;
  approvedBudgetUsd: string;
  draftBudgetUsd: string;
  favorableVarianceUsd: string;
  remainingBudgetUsd: string;
  utilizationPercent: string | null;
};
export type Categories = Record<Category, Status>;
export type Center = {
  id: number;
  code: string;
  name: string;
  module: Module;
  parent_id: number | null;
  sort_order: number;
  active: boolean;
  note: string | null;
  direct: Categories;
  rolledUp: Categories;
  descendantCount: number;
};
export type Report = {
  fromDate: string;
  asOfDate: string;
  companyId: number;
  currency: "USD";
  centers: Center[];
  months: Array<{ centerId: number; monthStart: string; categories: Categories }>;
  unallocated: Categories;
  totals: Categories;
  budgetCount: number;
  warnings: string[];
  quality: { overallocatedSourceEntries: number; staleAllocations: number };
  semantics: Record<string, string>;
  certified: false;
};
export type CenterBase = Pick<
  Center,
  "id" | "code" | "name" | "module" | "parent_id" | "sort_order" | "active" | "note"
>;
export type CenterList = { centers: CenterBase[] };
export type Entry = {
  id: number;
  voucherId: number;
  voucherNumber: string;
  bookedOn: string;
  accountCode: string;
  category: Category;
  bookedSignedUsd: string;
  assignedUsd: string;
  availableUsd: string;
};
export type Entries = { entries: Entry[] };
export type Allocation = {
  id: number;
  cost_center_id: number;
  voucher_entry_id: number;
  amount_usd: string;
  voucher_number: string;
  booked_on: string;
  source_active: boolean;
  note: string | null;
};
export type Budget = {
  id: number;
  cost_center_id: number;
  month_start: string;
  category: Category;
  planned_usd: string;
  state: "DRAFT" | "APPROVED" | "ARCHIVED";
  notes: string | null;
};
export const KEYS: Category[] = ["income", "cost_of_sales", "expense"];
export const label = (s: string) => s.replaceAll("_", " ").replace(/\b\w/g, (k) => k.toUpperCase());
export const money = (v: string) =>
  Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const defaultDate = () => new Date().toISOString().slice(0, 10);
export function escapedCsv(rows: string[][]) {
  const quoted = rows
    .map((row) =>
      row
        .map((x) => {
          const str = String(x);
          const numeric = /^-?\d+(?:\.\d+)?$/.test(str);
          const safe = /^[=+@]/.test(str) || (str.startsWith("-") && !numeric) ? "'" + str : str;
          return '"' + safe.replaceAll('"', '""') + '"';
        })
        .join(",")
    )
    .join("\r\n");
  const url = URL.createObjectURL(new Blob(["\ufeff", quoted], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "cost-centers-budget-actual.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
export async function read<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message ?? "Cost-center accounting not available");
  return body as T;
}
