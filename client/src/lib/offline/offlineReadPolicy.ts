/**
 * Phase 2 read policy. No auth/session endpoint is ever returned from disk.
 * Exact URLs only: query parameters can change access and data meaning.
 */
const SUPPORTED_READS = new Set([
  "/api/company-settings",
  "/api/my-erp-pages",
  "/api/exchange-rates",
  "/api/locations",
  "/api/ledger-accounts",
  "/api/suppliers",
  "/api/customers",
  "/api/stock-items/light",
  "/api/inventory",
  "/api/pos/drafts",
  "/api/bale-products",
  "/api/employees",
  "/api/factory/suppliers",
  "/api/factory/categories",
  "/api/factory/bale-products",
  "/api/factory/containers",
  "/api/factory/raw-stock",
  "/api/factory/suppliers/with-balances",
  "/api/factory/daybook",
  "/api/factory/fx-rates",
]);

export function normalizeOfflineReadUrl(input: string): string | null {
  if (!input.startsWith("/api/") || input.startsWith("//") || input.includes("?") || input.includes("#")) return null;
  return SUPPORTED_READS.has(input) ? input : null;
}

export function offlineReadKey(companyId: number, userId: string, url: string): string {
  return JSON.stringify([companyId, userId, url]);
}

export function offlineReadinessKey(companyId: number, userId: string): string {
  return JSON.stringify([companyId, userId]);
}

export function classifyOfflineReadFallback(
  method: string,
  url: string,
  reason: number | "network" | "sw-offline"
): boolean {
  return method.toUpperCase() === "GET" &&
    normalizeOfflineReadUrl(url) !== null &&
    (reason === "network" || reason === "sw-offline");
}

type JsonRecord = Record<string, unknown>;
export type PageField = "data" | "array" | "object";
export interface PaginationPlan {
  field: PageField;
  total: number;
  totalPages: number;
  pageSize: number;
}

function intOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

const MAX_OFFLINE_PAGES = 1000;

export function readPaginationPlan(payload: unknown, headers: Headers): PaginationPlan {
  if (Array.isArray(payload)) {
    const total = headers.has("X-Total-Count")
      ? intOrZero(headers.get("X-Total-Count"))
      : payload.length;
    const totalPages = headers.has("X-Total-Pages")
      ? intOrZero(headers.get("X-Total-Pages"))
      : 1;
    const pageSize = headers.has("X-Page-Size")
      ? intOrZero(headers.get("X-Page-Size"))
      : Math.max(1, payload.length);
    if (!totalPages || totalPages > MAX_OFFLINE_PAGES || !pageSize || total < payload.length) {
      throw new Error("OFFLINE_PAGINATION_UNBOUNDED");
    }
    return { totalPages, total, pageSize, field: "array" };
  }

  if (!payload || typeof payload !== "object") throw new Error("OFFLINE_RESPONSE_SHAPE_INVALID");
  const record = payload as JsonRecord;
  if (!Array.isArray(record.data)) {
    return { field: "object", totalPages: 1, total: 1, pageSize: 1 };
  }

  const data = record.data;
  const total = intOrZero(record.total ?? data.length);
  const totalPages = intOrZero(record.totalPages ?? 1);
  const pageSize = intOrZero(record.pageSize ?? data.length) || 1;
  if (!totalPages || totalPages > MAX_OFFLINE_PAGES || total < data.length) {
    throw new Error("OFFLINE_PAGINATION_UNBOUNDED");
  }
  return { totalPages, total, pageSize, field: "data" };
}

export function mergeOfflinePages(pages: unknown[], plan: PaginationPlan): unknown {
  if (pages.length !== plan.totalPages) throw new Error("OFFLINE_PAGINATION_INCOMPLETE");
  if (plan.field === "object") return pages[0];

  const rows: unknown[] = [];
  for (let i = 0; i < pages.length; i++) {
    const value = pages[i];
    const array =
      plan.field === "array"
        ? value
        : value && typeof value === "object"
          ? (value as JsonRecord).data
          : undefined;
    if (!Array.isArray(array)) throw new Error("OFFLINE_PAGINATION_INCOMPLETE");
    // In a multi-page export each intermediate page must be full.
    if (i < pages.length - 1 && array.length !== plan.pageSize) {
      throw new Error("OFFLINE_PAGINATION_INCOMPLETE");
    }
    rows.push(...array);
  }
  if (rows.length !== plan.total) throw new Error("OFFLINE_PAGINATION_INCOMPLETE");

  if (plan.field === "array") return rows;
  const first = pages[0] as JsonRecord;
  return { ...first, data: rows, page: 1, pageSize: rows.length, total: rows.length, totalPages: rows.length ? 1 : 0 };
}
