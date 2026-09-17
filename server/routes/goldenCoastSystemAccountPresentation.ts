import type { Express } from "express";
import { isSystemOnlyLedgerAccount } from "../lib/systemOnlyLedgerAccounts";

function filterSystemOnlyAccounts(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.filter((row) => !isSystemOnlyLedgerAccount(row));
  }

  if (body && typeof body === "object") {
    const envelope = body as Record<string, unknown>;
    if (Array.isArray(envelope.accounts)) {
      return {
        ...envelope,
        accounts: envelope.accounts.filter((row) => !isSystemOnlyLedgerAccount(row)),
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
