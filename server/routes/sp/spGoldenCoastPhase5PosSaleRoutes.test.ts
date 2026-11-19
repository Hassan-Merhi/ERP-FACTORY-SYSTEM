import { describe, expect, it } from "vitest";
import { readModuleFamily } from "../../../scripts/lib/readModuleFamily.mjs";

const routeSource = readModuleFamily(new URL("./spGoldenCoastPosSalePostingRoutes.ts", import.meta.url));
const spIndexSource = readModuleFamily(new URL("./index.ts", import.meta.url));
const phase6RouteSource = readModuleFamily(new URL("./spGoldenCoastPosSaleDeductionsRoutes.ts", import.meta.url));
const legacySalesSource = readModuleFamily(new URL("./spSalesRoutes.ts", import.meta.url));
const saleServiceSource = readModuleFamily(new URL("../../services/accounting/goldenCoastPosSale.ts", import.meta.url));

describe("Golden Coast Phase 5 POS sale retirement", () => {
  it("keeps the Phase 5 implementation in source history but no longer mounts it", () => {
    expect(routeSource).toContain("registerSpGoldenCoastPhase5PosSaleRoutes");
    expect(routeSource).toContain('"/api/sp/golden-coast/phase5/pos-sale"');
    expect(spIndexSource).not.toContain('from "./spGoldenCoastPosSalePostingRoutes"');
    expect(spIndexSource).not.toContain("registerSpGoldenCoastPhase5PosSaleRoutes(app);");
  });

  it("mounts Phase 6 in the same protected position before legacy Supplier Partner sale routes", () => {
    const phase4Index = spIndexSource.indexOf("registerSpGoldenCoastPhase4CutoverFifoRoutes(app);");
    const phase6Index = spIndexSource.indexOf("registerSpGoldenCoastPhase6PosSaleRoutes(app);");
    const legacySalesIndex = spIndexSource.indexOf("registerSpSalesRoutes(app);");
    expect(phase6Index).toBeGreaterThan(phase4Index);
    expect(phase6Index).toBeLessThan(legacySalesIndex);
  });

  it("preserves the audited Phase 5 FIFO and posting implementation for Phase 6 reuse", () => {
    expect(saleServiceSource).toContain("planGoldenCoastPhase5Sale");
    expect(saleServiceSource).toContain("buildGoldenCoastPhase5SalePostings");
    expect(saleServiceSource).toContain("GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES");
    expect(phase6RouteSource).toContain("planGoldenCoastPhase5Sale");
    expect(phase6RouteSource).toContain("buildGoldenCoastPhase5SalePostings");
  });

  it("does not alter the legacy sale handler for non-Golden-Coast Supplier Partner companies", () => {
    expect(legacySalesSource).toContain('app.post("/api/sp/sales"');
    expect(legacySalesSource).toContain("sp_payable");
    expect(phase6RouteSource).not.toContain('app.post("/api/sp/sales"');
  });

  it("keeps pre-cutover and legacy posting paths out of the canonical Phase 6 sale", () => {
    expect(phase6RouteSource).not.toContain("goldenCoastPosting");
    expect(phase6RouteSource).not.toContain("buildGoldenCoastPhase1PostingBatch");
    expect(phase6RouteSource).toContain("GOLDEN_COAST_CURRENT_INVENTORY_FIFO_SOURCE");
  });
});
