import type { Express } from "express";

const GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE = "gc_owner_withdrawal_clearing";
const GC_OWNER_WITHDRAWAL_CLEARING_CODE = "GC-OWCLR";
const GC_OWNER_WITHDRAWAL_CLEARING_NAME = "GC Owner Withdrawal Clearing";
const ACCOUNT_MIGRATION_CLEARING_SUBTYPE = "account_migration_clearing";

function isSystemOnlyAccount(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const subType = String(row.subType ?? row.sub_type ?? "");

  return (
    subType === ACCOUNT_MIGRATION_CLEARING_SUBTYPE ||
    subType === GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE ||
    String(row.code ?? "") === GC_OWNER_WITHDRAWAL_CLEARING_CODE ||
    String(row.name ?? "").trim().toLowerCase() === GC_OWNER_WITHDRAWAL_CLEARING_NAME.toLowerCase()
  );
}

function filterSystemOnlyAccounts(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.filter((row) => !isSystemOnlyAccount(row));
  }

  if (body && typeof body === "object") {
    const envelope = body as Record<string, unknown>;
    if (Array.isArray(envelope.accounts)) {
      return {
        ...envelope,
        accounts: envelope.accounts.filter((row) => !isSystemOnlyAccount(row)),
      };
    }
  }

  return body;
}

/**
 * System-only balancing accounts must remain in the ledger for double-entry
 * integrity, but they are not user-facing accounts. Keep them out of account
 * lists and selectors while preserving their accounting entries.
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
    res.json = ((body: unknown) => originalJson(filterSystemOnlyAccounts(body))) as typeof res.json;

    return next();
  });
}
