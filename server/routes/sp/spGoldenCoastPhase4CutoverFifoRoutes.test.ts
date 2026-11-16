import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(new URL("./spGoldenCoastCutoverFifoRoutes.ts", import.meta.url), "utf8");
const spIndexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const accessControlSource = readFileSync(new URL("./spAccessControl.ts", import.meta.url), "utf8");
const legacyRetirementSource = readFileSync(
  new URL("../goldenCoastLegacyPostingRetirement.ts", import.meta.url),
  "utf8"
);
const applicationRoutesSource = readFileSync(new URL("../applicationRoutes.ts", import.meta.url), "utf8");

describe("Golden Coast Phase 4 cutover hardening route surface", () => {
  it("registers the FIFO bridge before legacy Supplier Partner mutation routes", () => {
    const phase4Index = spIndexSource.indexOf("registerSpGoldenCoastPhase4CutoverFifoRoutes(app);");
    const containerIndex = spIndexSource.indexOf("registerSpContainerRoutes(app);");
    const salesIndex = spIndexSource.indexOf("registerSpSalesRoutes(app);");
    const openingIndex = spIndexSource.indexOf("registerSpOpeningStockRoutes(app);");

    expect(phase4Index).toBeGreaterThan(-1);
    expect(phase4Index).toBeLessThan(containerIndex);
    expect(phase4Index).toBeLessThan(salesIndex);
    expect(phase4Index).toBeLessThan(openingIndex);
  });

  it("retires superseded Golden Coast financial mutation paths without shadow route registrations", () => {
    for (const pattern of [
      "/^\\/opening-stock\\/?$/",
      "/^\\/sales\\/?$/",
      "/^\\/sales\\/[^/]+\\/reverse\\/?$/",
      "/^\\/offload\\/?$/",
      "/^\\/offload\\/[^/]+\\/reverse\\/?$/",
      "/^\\/prepaid\\/?$/",
      "/^\\/containers\\/?$/",
      "/^\\/containers\\/[^/]+\\/?$/",
      "/^\\/containers\\/[^/]+\\/cancel\\/?$/",
    ]) {
      expect(routeSource).toContain(pattern);
    }
    expect(routeSource).toContain('app.use("/api/sp"');
    expect(routeSource).toContain("GC_LEGACY_POSTING_RETIRED");
    expect(routeSource).toContain("isGoldenCoastCompany");
    expect(routeSource).toContain("next();");
    expect(routeSource).not.toContain('app.post("/api/sp/sales"');
    expect(routeSource).not.toContain('app.post("/api/sp/offload"');
    expect(routeSource).not.toContain('app.post("/api/sp/containers"');
  });

  it("retires top-level Phase 1 posting before the old route registrar without duplicate app.post routes", () => {
    expect(legacyRetirementSource).toContain('app.use("/api/golden-coast/accounting/phase1"');
    expect(legacyRetirementSource).toContain('req.path === "/setup-accounts"');
    expect(legacyRetirementSource).toContain('req.path === "/post"');
    expect(legacyRetirementSource).toContain("privilegedMutationRateLimit");
    expect(legacyRetirementSource).toContain("GC_PHASE1_POSTING_RETIRED");
    expect(legacyRetirementSource).not.toContain("app.post(");
    expect(applicationRoutesSource.indexOf("registerGoldenCoastLegacyPostingRetirement(app);")).toBeLessThan(
      applicationRoutesSource.indexOf("registerGoldenCoastAccountingRoutes(app);")
    );
  });

  it("keeps the FIFO mutation behind SP migration confirmation and concurrency-safe idempotency controls", () => {
    expect(routeSource).toContain('"/api/sp/golden-coast/phase4/cutover-fifo"');
    expect(accessControlSource).toContain('path.includes("cutover")');
    expect(accessControlSource).toContain('confirmation: "RUN SP MIGRATION"');
    expect(accessControlSource).toContain('req.header("Idempotency-Key")');
    expect(routeSource).toContain("pg_advisory_xact_lock");
    expect(routeSource).toContain("golden-coast-phase4-cutover:${companyId}");
  });

  it("does not post accounting or adjust ERP inventory during the FIFO bridge", () => {
    expect(routeSource).toContain("tx.insert(spStockMovements)");
    expect(routeSource).not.toContain("voucherEntries");
    expect(routeSource).not.toContain("postBalancedVoucherTx");
    expect(routeSource).not.toContain("adjustSpInventoryAtomic");
  });

  it("requires Phase 3, exact Stock in Hand reconciliation, company scoping and the cutover date", () => {
    expect(routeSource).toContain("phase3VoucherNumber(companyId)");
    expect(routeSource).toContain("stock_in_hand_opening");
    expect(routeSource).toContain("buildGoldenCoastCutoverFifoPlan");
    expect(routeSource).toContain("inv.company_id = ${companyId}");
    expect(routeSource).toContain("loc.company_id = ${companyId}");
    expect(routeSource).toContain("new Date().toISOString().slice(0, 10) < GOLDEN_COAST_CUTOVER_DATE");
  });

  it("recognizes the existing-position carry-forward as the alternate opening marker", () => {
    expect(routeSource).toContain("goldenCoastExistingPositionCarryForwardVoucherNumber(companyId)");
    expect(routeSource).toContain("openingVoucherRow");
    expect(routeSource).toContain("carryForwardPosted");
  });
});
