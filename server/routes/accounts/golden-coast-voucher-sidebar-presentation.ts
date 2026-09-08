import type { Express } from "express";

function normal(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/**
 * GC Sales Cash is a credit-normal settlement ledger underneath, but Golden
 * Coast Net Position intentionally presents it as cash under What We Have.
 * The manual journal picker must use that same presentation sign so a user can
 * enter the economic owner-withdrawal intent naturally:
 *
 *   Dr Hassan Dakik Equity
 *   Cr GC Sales Cash
 *
 * The central journal route converts that exact pair to the balanced internal
 * posting that reduces both underlying balances without touching Fresh Start.
 */
export function registerGoldenCoastVoucherSidebarPresentation(app: Express): void {
  app.get("/api/accounts/voucher-sidebar", (_req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = ((body: unknown) => {
      if (!Array.isArray(body)) return originalJson(body);

      const hasFreshStart = body.some((account) => normal(account?.name) === "fresh start fz equity");
      const hasHassan = body.some((account) => normal(account?.name) === "hassan dakik equity");
      const hasGcSalesCash = body.some((account) => normal(account?.name) === "gc sales cash");
      if (!hasFreshStart || !hasHassan || !hasGcSalesCash) return originalJson(body);

      return originalJson(
        body.map((account) => {
          if (normal(account?.name) !== "gc sales cash") return account;
          const signedLedgerBalance = Number(account?.balance ?? 0);
          if (!Number.isFinite(signedLedgerBalance)) return account;
          return {
            ...account,
            // Net Position shows the inverse of the credit-normal payable sign.
            balance: -signedLedgerBalance,
          };
        })
      );
    }) as typeof res.json;

    next();
  });
}
