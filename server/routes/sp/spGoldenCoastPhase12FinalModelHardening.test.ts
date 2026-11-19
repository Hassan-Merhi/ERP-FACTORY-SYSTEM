import { describe, expect, it } from "vitest";
import { readModuleFamily } from "../../../scripts/lib/readModuleFamily.mjs";

const phase6RouteSource = readModuleFamily(new URL("./spGoldenCoastPosSaleDeductionsRoutes.ts", import.meta.url));
const phase6AutoHadiSource = readModuleFamily(new URL("./goldenCoastAutoHadi.ts", import.meta.url));
const phase7RouteSource = readModuleFamily(new URL("./spGoldenCoastHadiTransferRoutes.ts", import.meta.url));
const phase7ServiceSource = readModuleFamily(
  new URL("../../services/accounting/goldenCoastHadiTransfer.ts", import.meta.url)
);
const phase10RouteSource = readModuleFamily(new URL("./spGoldenCoastSalesCashSettlementRoutes.ts", import.meta.url));
const phase11RouteSource = readModuleFamily(new URL("./spGoldenCoastMonthlyCloseRoutes.ts", import.meta.url));
const legacySalesGuardSource = readModuleFamily(new URL("./spGoldenCoastLegacySalesGuard.ts", import.meta.url));
const posMutationsSource = readModuleFamily(
  new URL("../../../client/src/pages/pos/hooks/usePosMutations.ts", import.meta.url)
);
const spIndexSource = readModuleFamily(new URL("./index.ts", import.meta.url));

describe("Golden Coast Phase 12 final accounting-model hardening", () => {
  it("forces every production Golden Coast sale through canonical GC Sales Cash", () => {
    expect(phase6RouteSource).toContain("GC_PHASE6_SALE_SIDE_OVERRIDE_RETIRED");
    expect(phase6RouteSource).toContain("saleSideAccount overrides are retired for Golden Coast");
    expect(phase6RouteSource).toContain(
      'const saleSideAccount = { kind: "ledger" as const, id: accounts.gcSalesCashAccountId };'
    );
  });

  it("atomically routes each Phase 6 sale into HADI and creates the Phase 15 credit payable", () => {
    expect(phase6RouteSource).toContain("postGoldenCoastAutomaticHadiCollectionTx");
    expect(phase6RouteSource).toContain("hadi_collection_${item.role}");
    expect(phase6AutoHadiSource).toContain('operation: "collect_via_hadi"');
    expect(phase6AutoHadiSource).toContain("buildGoldenCoastPhase7TransferPostings");
    expect(phase6AutoHadiSource).toContain("buildGoldenCoastPhase15SalesPayablePosting");
  });

  it("routes the live Supplier Partner POS to Phase 6 when Golden Coast setup is present", () => {
    expect(posMutationsSource).toContain("GOLDEN_COAST_PHASE6_READINESS");
    expect(posMutationsSource).toContain("GOLDEN_COAST_PHASE6_SALE");
    expect(posMutationsSource).toContain("targetCompanyId=");
    expect(posMutationsSource).toContain("clientRequestId: String(saleData.clientSaleId)");
  });

  it("fails closed against stale clients that try the generic SP sale route for Golden Coast", () => {
    expect(legacySalesGuardSource).toContain("GC_PHASE6_CANONICAL_POS_REQUIRED");
    expect(spIndexSource.indexOf("registerSpGoldenCoastLegacySalesGuard(app)")).toBeLessThan(
      spIndexSource.indexOf("registerSpSalesRoutes(app)")
    );
  });

  it("keeps physical cash collection on the existing HADI cash-only intercompany path", () => {
    expect(phase7ServiceSource).toContain('operation !== "collect_via_hadi"');
    expect(phase7ServiceSource).toContain("gcSalesCashDebitBalanceUsd");
    expect(phase7RouteSource).toContain("resolveCompanyPair");
    expect(phase7RouteSource).toContain("postBalancedVoucherTx");
  });

  it("keeps direct bank/cash settlement separate from POS sale recognition", () => {
    expect(phase10RouteSource).toContain("gcSalesCashDebitBalanceUsd");
    expect(phase10RouteSource).toContain("validatePaymentAccount");
    expect(phase10RouteSource).toContain("postBalancedVoucherTx");
  });

  it("keeps the finalized-month freeze after the 50/50 monthly close", () => {
    expect(phase11RouteSource).toContain("Profit Pending Distribution");
    expect(phase11RouteSource).toContain("spProfitSplits");
  });

  it("keeps retired Phase 1 and Phase 5 mutation registrars off the production composition root", () => {
    expect(spIndexSource).not.toContain("registerSpGoldenCoastPhase1PostingRoutes(app)");
    expect(spIndexSource).not.toContain("registerSpGoldenCoastPhase5PosSaleRoutes(app)");
    expect(spIndexSource).toContain("registerSpGoldenCoastPhase6PosSaleRoutes(app)");
  });
});
