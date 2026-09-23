/**
 * Pure helpers and lookup tables for the StockEntryHistory page.
 *
 * Extracted from StockEntryHistory.tsx during the Phase 4 god-file split.
 */

import type { GroupRow, MatrixRow, StockEntryHistoryPage, WorkerMatrix } from "./types";

export const STATUS_OPTIONS = [
  "PENDING_PRESSING",
  "LABEL_PRINTED",
  "PRESSED",
  "FINALIZED",
  "IN_STOCK",
  "RESERVED",
  "RESERVED_FOR_ORDER",
  "SOLD",
  "REPACKED",
  "DISPATCHED",
  "DELETED",
];

export const STATUS_COLORS: Record<string, string> = {
  IN_STOCK: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  FINALIZED: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  SOLD: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  REMOVED: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  DELETED: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  DISPATCHED: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  RESERVED: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  RESERVED_FOR_ORDER: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
};

export /** Fetches all pages of a stock-entry-history query using limit=250 per page.
 *  Safety cap: 100 pages. Use only for actions requiring every matching row
 *  (exports, bulk ops, print). Never use for the normal paginated screen list. */
async function fetchAllStockEntryHistoryPages(baseParams: URLSearchParams): Promise<GroupRow[]> {
  const p = new URLSearchParams(baseParams);
  p.set("page", "1");
  p.set("limit", "250");
  const r = await fetch(`/api/factory/bales/stock-entry-history?${p.toString()}`, { credentials: "include" });
  if (!r.ok) throw new Error(`Stock entry history request failed: ${r.status}`);
  const firstData: StockEntryHistoryPage = await r.json();
  if (!Array.isArray(firstData.items)) {
    throw new Error("Invalid response from stock entry history endpoint");
  }
  const allItems: GroupRow[] = [...firstData.items];
  const totalPages = Math.min(firstData.totalPages, 100); // hard safety cap: 100 pages max
  // Fetch remaining pages with concurrency limit of 2
  for (let batchStart = 2; batchStart <= totalPages; batchStart += 2) {
    const pageNums = [batchStart, batchStart + 1].filter((n) => n <= totalPages);
    const results = await Promise.all(
      pageNums.map(async (pageNum) => {
        const pp = new URLSearchParams(baseParams);
        pp.set("page", String(pageNum));
        pp.set("limit", "250");
        const res = await fetch(`/api/factory/bales/stock-entry-history?${pp.toString()}`, { credentials: "include" });
        if (!res.ok) throw new Error(`Stock entry history page ${pageNum} failed: ${res.status}`);
        const data: StockEntryHistoryPage = await res.json();
        if (!Array.isArray(data.items)) throw new Error(`Invalid response for page ${pageNum}`);
        return data.items;
      })
    );
    for (const pageItems of results) allItems.push(...pageItems);
  }
  return allItems;
}

export function buildWorkerMatrix(filteredGroups: GroupRow[]): WorkerMatrix {
  const workerSet = new Set<string>();
  const productMap = new Map<string, Record<string, number>>();

  for (const g of filteredGroups) {
    for (const b of g.bales) {
      const productLabel = b.productName
        ? b.articleCode
          ? `${b.productName} (${b.articleCode})`
          : b.productName
        : "—";
      const workerKey = b.workerName || "Unassigned";

      workerSet.add(workerKey);

      if (!productMap.has(productLabel)) productMap.set(productLabel, {});
      const row = productMap.get(productLabel)!;
      row[workerKey] = (row[workerKey] || 0) + 1;
    }
  }

  const named: string[] = [];
  let hasUnassigned = false;
  for (const w of workerSet) {
    if (w === "Unassigned") hasUnassigned = true;
    else named.push(w);
  }
  named.sort((a, b) => a.localeCompare(b));
  const workers = hasUnassigned ? [...named, "Unassigned"] : named;

  const rows: MatrixRow[] = Array.from(productMap.entries())
    .map(([productLabel, counts]) => ({
      productLabel,
      counts,
      total: Object.values(counts).reduce((s, v) => s + v, 0),
    }))
    .sort((a, b) => a.productLabel.localeCompare(b.productLabel));

  const workerTotals: Record<string, number> = {};
  for (const w of workers) workerTotals[w] = 0;
  for (const row of rows) {
    for (const w of workers) {
      workerTotals[w] = (workerTotals[w] || 0) + (row.counts[w] || 0);
    }
  }

  const grandTotal = rows.reduce((s, r) => s + r.total, 0);

  return { workers, rows, workerTotals, grandTotal };
}

export function formatDailyNum(val: number): string {
  if (val === 0) return "0";
  return val % 1 === 0 ? val.toFixed(0) : parseFloat(val.toFixed(3)).toString();
}

function normalizeHistoryTimestamp(iso: string): string {
  const trimmed = iso.trim();
  if (!trimmed) return trimmed;
  return /(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(trimmed) ? trimmed : `${trimmed}Z`;
}

export function formatHistoryDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(normalizeHistoryTimestamp(iso));
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function formatHistoryTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(normalizeHistoryTimestamp(iso));
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
