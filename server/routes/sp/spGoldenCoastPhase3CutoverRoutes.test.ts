import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(new URL("./spGoldenCoastCutoverRoutes.ts", import.meta.url), "utf8");
const spIndexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const accessControlSource = readFileSync(new URL("./spAccessControl.ts", import.meta.url), "utf8");

describe("Golden Coast Phase 3 cutover route surface hardened by Phase 13", () => {
  it("registers status, preview and cutover inside Supplier Partner routes", () => {
    expect(routeSource).toContain('"/api/sp/golden-coast/phase3/status"');
    expect(routeSource).toContain('"/api/sp/golden-coast/phase3/preview"');
    expect(routeSource).toContain('"/api/sp/golden-coast/phase3/cutover"');
    expect(spIndexSource).toContain("registerSpGoldenCoastPhase3CutoverRoutes(app);");
  });

  it("restricts Phase 3 handlers to authenticated Admins on the SP company", () => {
    expect(routeSource).toContain("requireAuth");
    expect(routeSource).toContain('requireRole("Admin")');
    expect(routeSource).toContain("requireSpCompany(req, res)");
  });

  it("rate limits every endpoint and caps preview and cutover request bodies", () => {
    expect(routeSource).toContain("privilegedMutationRateLimit");
    expect(routeSource).toContain("privilegedReadRateLimit");
    expect(routeSource).toContain("phase3RequestBudget");
  });

  it("keeps cutover behind the existing migration confirmation and idempotency guard", () => {
    expect(accessControlSource).toContain('path.includes("cutover")');
    expect(accessControlSource).toContain('confirmation: "RUN SP MIGRATION"');
    expect(accessControlSource).toContain('req.header("Idempotency-Key")');
  });

  it("uses one database transaction for the posting operation", () => {
    expect(routeSource).toContain("db.transaction(async (tx)");
    expect(routeSource).toContain("postBalancedVoucherTx(tx");
  });

  it("validates the selected cash or bank target during preview and posting", () => {
    expect(routeSource.match(/validateCashAccountTx\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(routeSource).toContain("eq(bankAccounts.companyId, companyId)");
    expect(routeSource).toContain("eq(ledgerAccounts.companyId, companyId)");
    expect(routeSource).toContain("eq(bankAccounts.active, true)");
    expect(routeSource).toContain("eq(ledgerAccounts.active, true)");
  });

  it("accepts the Fresh Start contribution split in both preview and posting", () => {
    expect(
      routeSource.match(/freshStartContributedStockOtwUsd: req\.body\?\.freshStartContributedStockOtwUsd/g)?.length
    ).toBe(2);
    expect(
      routeSource.match(/freshStartContributedStockInHandUsd: req\.body\?\.freshStartContributedStockInHandUsd/g)
        ?.length
    ).toBe(2);
    expect(routeSource).toContain('freshStartContributedInventory: "Excluded from Hassan funding usage"');
    expect(routeSource).toContain('cashFundedInventory: "Consumes Hassan funding"');
    expect(routeSource).toContain("Automatic residual of Hassan's $100,000 opening funding balance");
  });

  it("refuses a fresh opening journal over stored opening balances or voucher history", () => {
    expect(routeSource).toContain("canonicalPreCutoverBalances");
    expect(routeSource).toContain("ledgerAccounts.openingBalance");
    expect(routeSource).toContain("ledgerAccounts.openingBalanceSide");
    expect(routeSource).toContain("opening or ledger balances");
    expect(routeSource).toContain("Phase 3 refuses to layer a fresh opening journal on top of historical balances");
  });

  it("uses the trusted server clock rather than a caller-controlled client date", () => {
    expect(routeSource).toContain("new Date().toISOString().slice(0, 10)");
    expect(routeSource).not.toContain('req.header("X-Client-Date")');
    expect(routeSource).toContain("requestDate < GOLDEN_COAST_PHASE3_CUTOVER_DATE");
    expect(routeSource).toContain("GC_PHASE3_CUTOVER_NOT_OPEN");
  });

  it("namespaces the cutover voucher identity by company", () => {
    expect(routeSource).toContain("goldenCoastPhase3VoucherNumber(companyId)");
    expect(routeSource).toContain("companyId: selectedCompany");
    expect(routeSource).toContain("voucherNumber: plan.voucherNumber");
  });

  it("treats the existing-position carry-forward as a valid completed opening state", () => {
    expect(routeSource).toContain("existingPositionCarryForwardVoucher");
    expect(routeSource).toContain("openingMode: existingPositionCarryForwardVoucher");
    expect(routeSource).toContain("!existingPositionCarryForwardVoucher");
  });
});
