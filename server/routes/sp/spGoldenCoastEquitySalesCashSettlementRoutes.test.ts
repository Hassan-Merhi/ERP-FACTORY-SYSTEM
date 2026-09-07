/**
 * Route surface for settling GC Sales Cash out of Hassan Dakik Equity.
 *
 * The journal itself is proven behaviourally in the service suite. What only
 * the route source can show is that this path reuses the same access controls,
 * canonical account resolution, balance semantics and serialization as the
 * cash-funded Phase 10 payment it sits beside.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(new URL("./spGoldenCoastEquitySalesCashSettlementRoutes.ts", import.meta.url), "utf8");
const spIndexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const serviceSource = readFileSync(
  new URL("../../services/accounting/goldenCoastEquitySalesCashSettlement.ts", import.meta.url),
  "utf8"
);
const panelSource = readFileSync(
  new URL("../../../client/src/pages/sp/golden-coast/EquitySalesCashPanel.tsx", import.meta.url),
  "utf8"
);

describe("Golden Coast equity-funded GC Sales Cash settlement route surface", () => {
  it("registers alongside the other Golden Coast accounting routes and before legacy SP sales", () => {
    const equityIndex = spIndexSource.indexOf("registerSpGoldenCoastEquitySalesCashSettlementRoutes(app);");
    const phase10Index = spIndexSource.indexOf("registerSpGoldenCoastPhase10SalesCashSettlementRoutes(app);");
    const legacySalesIndex = spIndexSource.indexOf("registerSpSalesRoutes(app);");

    expect(equityIndex).toBeGreaterThan(phase10Index);
    expect(equityIndex).toBeLessThan(legacySalesIndex);
  });

  it("keeps the settlement out of POS-role sessions and applies privileged endpoint controls", () => {
    expect(routeSource).toContain("requireNonPOS");
    expect(routeSource).toContain("privilegedReadRateLimit");
    expect(routeSource).toContain("privilegedMutationRateLimit");
    expect(routeSource).toContain("equitySalesCashRequestBudget");
  });

  it("resolves all three roles canonically by sub type and rejects duplicates", () => {
    expect(routeSource).toContain("eq(ledgerAccounts.subType, definition.subType)");
    expect(routeSource).toContain(".limit(2)");
    expect(routeSource).toContain("is ambiguous; repair duplicate canonical accounts before settling");
    // Never by display name — a renamed account must not silently reroute equity.
    expect(routeSource).not.toContain('ledgerAccounts.name,\n        "Hassan');
  });

  it("refuses to post when two of the three roles resolve to the same account", () => {
    expect(routeSource).toContain("must resolve to three distinct accounts");
    expect(serviceSource).toContain("must resolve to three distinct accounts");
  });

  it("caps the amount against both credit-normal balances, not just the payable", () => {
    expect(serviceSource).toContain("GC_EQUITY_SALES_CASH_EXCEEDS_PAYABLE");
    expect(serviceSource).toContain("GC_EQUITY_SALES_CASH_EXCEEDS_EQUITY");
    expect(routeSource).toContain("conservativePayable");
    expect(routeSource).toContain("hassanEquityCreditBalanceUsd");
  });

  it("reads the payable as conservatively as the cash-funded path does", () => {
    expect(routeSource).toContain("gcSalesCashConservativePayable");
    expect(routeSource).toContain("gcSalesCashSettleablePayable");
  });

  it("detects an exact replay before the mutable balance cap", () => {
    const replayIndex = routeSource.indexOf("findReplayedSettlement(tx");
    const capIndex = routeSource.indexOf("planGoldenCoastEquitySalesCashSettlement({");
    expect(replayIndex).toBeGreaterThan(-1);
    expect(replayIndex).toBeLessThan(capIndex);
  });

  it("serializes against the same company locks the other payable writers take", () => {
    expect(routeSource).toContain("golden-coast-phase7:${companyId}");
    expect(routeSource).toContain("golden-coast-phase10:${companyId}");
    expect(routeSource).toContain("LOCK TABLE voucher_entries IN SHARE ROW EXCLUSIVE MODE");
  });

  it("posts through the central engine and never writes voucher tables directly", () => {
    expect(routeSource).toContain("postBalancedVoucherTx");
    expect(routeSource).not.toContain("insert(vouchers)");
    expect(routeSource).not.toContain("insert(voucherEntries)");
  });

  it("moves no cash or bank account, so it never resolves a payment target", () => {
    expect(routeSource).not.toContain("bankAccounts");
    expect(routeSource).not.toContain("listPaymentAccounts");
    expect(serviceSource).not.toContain("bankAccountId");
  });

  it("emits every readiness field the panel reads", () => {
    const readFields = [...panelSource.matchAll(/readiness[.?]{1,2}\.?(\w+)/g)]
      .map((match) => match[1])
      .filter((field) => !["data", "ready", "isLoading", "error", "mutate", "isPending"].includes(field));

    expect(readFields.length).toBeGreaterThan(0);
    for (const field of new Set(readFields)) {
      const emitted = new RegExp(`\\b${field}\\s*[:,]`).test(routeSource);
      expect(emitted, `readiness payload is missing ${field}`).toBe(true);
    }
  });
});
