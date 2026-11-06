import type { ApiAllocatedRow, ApiAllocStatus, EnrichedContainerApi } from "./types";

/**
 * GET /api/git/containers paginates at 50 rows per page by default. The GIT
 * report tabs aggregate over the whole fleet — shop groupings, "on the road"
 * counts, totals — so a first page silently truncates them (58 containers on
 * the road rendered as 50). `all=true` asks the server for the complete
 * filtered listing instead of one page.
 */
export function gitContainersUrl(
  { allCompanies = false, includeOffloaded = false }: { allCompanies?: boolean; includeOffloaded?: boolean } = {}
): string {
  const params = new URLSearchParams({ all: "true" });
  if (allCompanies) params.set("allCompanies", "true");
  if (includeOffloaded) params.set("includeOffloaded", "true");
  return `/api/git/containers?${params.toString()}`;
}

export function fmt(n: number, decimals = 0) {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtD(d: string | null) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y.slice(2)}`;
}

export const parseNum = (v: string | null | undefined): number => parseFloat(v ?? "0") || 0;

export const COMPANY_COLORS: { bg: string; text: string }[] = [
  { bg: "bg-yellow-400", text: "text-yellow-950" },
  { bg: "bg-orange-400", text: "text-orange-950" },
  { bg: "bg-teal-600", text: "text-white" },
  { bg: "bg-green-600", text: "text-white" },
  { bg: "bg-purple-600", text: "text-white" },
  { bg: "bg-cyan-600", text: "text-white" },
  { bg: "bg-red-600", text: "text-white" },
  { bg: "bg-blue-600", text: "text-white" },
  { bg: "bg-indigo-600", text: "text-white" },
];

export function getRealRowBg(r: EnrichedContainerApi): string {
  // Keep the row-state palette consistent with the workbook legend in both themes.
  if (r.isOverdue) return "bg-red-50 dark:bg-red-500/10";
  if (r.status === "At Port" && !r.docReceived) return "bg-rose-50 dark:bg-rose-500/10";
  if (r.docsReadyNotSent) return "bg-amber-50 dark:bg-amber-500/10";
  if (r.daysDelayed !== null && r.daysDelayed > 0) return "bg-orange-50 dark:bg-orange-500/10";
  if (!r.docReceived && r.eta) {
    const eta = Date.parse(`${r.eta}T12:00:00Z`);
    const daysUntilEta = (eta - Date.now()) / 86_400_000;
    if (Number.isFinite(daysUntilEta) && daysUntilEta >= 0 && daysUntilEta <= 14) {
      return "bg-yellow-50 dark:bg-yellow-500/10";
    }
  }
  return "";
}

export function groupBySupplier(rows: EnrichedContainerApi[]) {
  const groups: Array<{ name: string; rows: EnrichedContainerApi[] }> = [];
  for (const r of rows) {
    const key = r.supplierName ?? "Unknown";
    const existing = groups.find((g) => g.name === key);
    if (existing) existing.rows.push(r);
    else groups.push({ name: key, rows: [r] });
  }
  groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return groups;
}

export function clientReallocate(orderedRows: ApiAllocatedRow[], toConsume: number): ApiAllocatedRow[] {
  let rem = toConsume;
  return orderedRows.map((row) => {
    if (rem >= row.dutyFee) {
      rem -= row.dutyFee;
      return { ...row, clearedAmount: row.dutyFee, remainingAmount: 0, allocationStatus: "Cleared" as ApiAllocStatus };
    } else if (rem > 0) {
      const cl = rem;
      rem = 0;
      return {
        ...row,
        clearedAmount: cl,
        remainingAmount: row.dutyFee - cl,
        allocationStatus: "Partially Cleared" as ApiAllocStatus,
      };
    } else {
      return { ...row, clearedAmount: 0, remainingAmount: row.dutyFee, allocationStatus: "Open" as ApiAllocStatus };
    }
  });
}
