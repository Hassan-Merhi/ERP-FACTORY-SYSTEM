export type VoucherRequestPayload = Record<string, unknown>;

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalizedPath(pathname: string): string {
  return pathname.split("?")[0] || pathname;
}

export function isVoucherRequestPayload(value: unknown): value is VoucherRequestPayload {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Phase 5 is intentionally family-scoped. These are the remaining operational
 * voucher-producing families from config/voucher-write-evidence-review.json.
 * Sibling mutations inside a protected family may receive the same retry guard;
 * that is safe and prevents a future accounting branch from silently escaping.
 */
export function isPhase5OperationalVoucherRequest(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  if (!STATE_CHANGING_METHODS.has(verb)) return false;
  const path = normalizedPath(pathname);

  if (verb === "POST" && /^\/api\/containers\/[^/]+\/offload$/.test(path)) return true;
  if (verb === "POST" && path === "/api/credit-notes") return true;

  // Factory container lifecycle: create/edit/offload reversal/charge sync.
  if (path === "/api/factory/containers" && verb === "POST") return true;
  if (/^\/api\/factory\/containers\/[^/]+$/.test(path) && (verb === "PATCH" || verb === "DELETE")) return true;
  if (/^\/api\/factory\/containers\/[^/]+\/(?:other-charges\/sync|reverse-offload)$/.test(path) && verb === "POST") {
    return true;
  }

  // Raw-stock receipts, corrections and reversals all share one accounting family.
  if (path.startsWith("/api/factory/raw-stock/") && STATE_CHANGING_METHODS.has(verb)) return true;

  if (/^\/api\/factory\/customer-orders\/[^/]+\/charges(?:\/relink-vouchers)?$/.test(path) && verb === "POST") {
    return true;
  }
  if (/^\/api\/factory\/transporters\/[^/]+\/(?:charges|payments)$/.test(path) && verb === "POST") return true;

  // Factory worker advance creation/repayment accounting. Phase 4's
  // cash-adjustment/repay-by-month endpoints intentionally remain outside this
  // matcher so one request is not claimed by two boundaries.
  if (path === "/api/factory/advances/bulk" && verb === "POST") return true;
  if (path.startsWith("/api/factory/advance-repayments") && STATE_CHANGING_METHODS.has(verb)) return true;
  if (/^\/api\/factory\/workers\/[^/]+\/advances(?:\/.*)?$/.test(path) && STATE_CHANGING_METHODS.has(verb)) return true;

  // All three rental shells use the same shared accounting implementation.
  if (
    path.startsWith("/api/erp/rental/") ||
    path.startsWith("/api/properties/rental/") ||
    path.startsWith("/api/factory/rental/")
  ) {
    return true;
  }

  // Supplier Partner operational writes. Migration/cutover routes are Phase 6
  // and deliberately excluded from browser-generated request identity.
  if (path.startsWith("/api/sp/") && !path.startsWith("/api/sp/migration/")) return true;

  return false;
}

export const PHASE6_DETERMINISTIC_SPECIAL_PATHS = {
  "/api/fix-old-po-credits": "repair:old-po-credits",
  "/api/credit-sales-import/import": "import:credit-sales",
  "/api/exchange-rates": "repair:exchange-rate-revaluation",
  "/api/pos-import/import": "import:pos-sales",
  "/api/stock-transfer-import/import": "import:stock-transfer",
  "/api/sp/migration/opening-balance": "migration:sp-opening-balance",
} as const;

export function phase6DeterministicSourcePrefix(method: string, pathname: string): string | null {
  if (method.toUpperCase() !== "POST") return null;
  const path = normalizedPath(pathname) as keyof typeof PHASE6_DETERMINISTIC_SPECIAL_PATHS;
  return PHASE6_DETERMINISTIC_SPECIAL_PATHS[path] ?? null;
}

export function isPhase6DeterministicSpecialRequest(method: string, pathname: string): boolean {
  return phase6DeterministicSourcePrefix(method, pathname) !== null;
}

/**
 * The other five Phase 6 writers are intrinsically rerun-safe by durable
 * business state (empty-target import guard, existing-voucher/backfill guard,
 * migration state checks, rental repair state checks, or transaction-scoped
 * balance/advisory locking). Keeping this list explicit prevents a future
 * source change from silently turning an intrinsic exemption into an escape.
 */
export const PHASE6_INTRINSIC_REPLAY_SAFE_WRITERS = [
  "server/routes/erp-payroll/runs-migration.ts",
  "server/routes/factory/docs-users/companyImportRoutes.ts",
  "server/routes/payroll/worker-statement/backfill.ts",
  "server/routes/rental/rentalAccrualConfigRoutes.ts",
] as const;
