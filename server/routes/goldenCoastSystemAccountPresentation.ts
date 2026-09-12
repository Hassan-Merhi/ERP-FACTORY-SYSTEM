import type { Express } from "express";

const GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE = "gc_owner_withdrawal_clearing";
const GC_OWNER_WITHDRAWAL_CLEARING_CODE = "GC-OWCLR";
const GC_OWNER_WITHDRAWAL_CLEARING_NAME = "GC Owner Withdrawal Clearing";

function isOwnerWithdrawalClearingAccount(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    String(row.subType ?? row.sub_type ?? "") === GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE ||
    String(row.code ?? "") === GC_OWNER_WITHDRAWAL_CLEARING_CODE ||
    String(row.name ?? "").trim().toLowerCase() === GC_OWNER_WITHDRAWAL_CLEARING_NAME.toLowerCase()
  );
}

/**
 * GC Owner Withdrawal Clearing is a system-only balancing account. It must
 * remain in the ledger for double-entry integrity, but it is not a user account
 * and should never appear in account lists, selectors, or hidden-account views.
 */
export function registerGoldenCoastSystemAccountPresentation(app: Express): void {
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();

    const path = req.path;
    const shouldFilter =
      path === "/api/ledger-accounts" ||
      path === "/api/accounts/all" ||
      path === "/api/accounts/all-ledger" ||
      path === "/api/accounts/voucher-sidebar";

    if (!shouldFilter) return next();

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (!Array.isArray(body)) return originalJson(body);
      return originalJson(body.filter((row) => !isOwnerWithdrawalClearingAccount(row)));
    }) as typeof res.json;

    return next();
  });
}
