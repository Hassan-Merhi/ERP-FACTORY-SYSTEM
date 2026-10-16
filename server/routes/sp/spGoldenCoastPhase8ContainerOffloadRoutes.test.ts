import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(new URL("./spGoldenCoastPhase8ContainerOffloadRoutes.ts", import.meta.url), "utf8");
const spIndexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const accessControlSource = readFileSync(new URL("./spAccessControl.ts", import.meta.url), "utf8");
const phase4RouteSource = readFileSync(new URL("./spGoldenCoastPhase4CutoverFifoRoutes.ts", import.meta.url), "utf8");
const phase4ServiceSource = readFileSync(
  new URL("../../services/accounting/goldenCoastPhase4CutoverFifo.ts", import.meta.url),
  "utf8"
);
const migrationReconcileSource = readFileSync(new URL("./spMigrationPhase4Reconcile.ts", import.meta.url), "utf8");
const phase8ServiceSource = readFileSync(
  new URL("../../services/accounting/goldenCoastPhase8ContainerOffload.ts", import.meta.url),
  "utf8"
);
const phase5ServiceSource = readFileSync(
  new URL("../../services/accounting/goldenCoastPhase5PosSale.ts", import.meta.url),
  "utf8"
);

describe("Golden Coast Phase 8 container/offload route", () => {
  it("is mounted as the Golden Coast container funding and offload surface", () => {
    expect(spIndexSource).toContain("registerSpGoldenCoastPhase8ContainerOffloadRoutes(app);");
    expect(routeSource).toContain('"/api/sp/golden-coast/phase8/containers"');
    expect(routeSource).toContain('"/api/sp/golden-coast/phase8/offload"');
    expect(routeSource).toContain('"/api/sp/golden-coast/phase8/container-offload/readiness"');
  });

  it("guards both mutations behind SP permissions and privileged endpoint security", () => {
    expect(accessControlSource).toContain('path === "/golden-coast/phase8/offload"');
    // Funding posts to /golden-coast/phase8/containers, which the existing
    // container classifier already routes to sp_container_manage.
    expect(accessControlSource).toContain(
      'if (path.includes("container") && method !== "GET") return "sp_container_manage";'
    );
    expect(routeSource).toContain("privilegedMutationRateLimit");
    expect(routeSource).toContain("privilegedReadRateLimit");
    expect(routeSource).toContain("phase8RequestBudget");
    expect(routeSource).toContain("requireAuth");
  });

  it("keeps funding and offload posting inside one serialized transaction", () => {
    expect(routeSource).toContain("db.transaction(async (tx) =>");
    expect(routeSource).toContain("pg_advisory_xact_lock");
    expect(routeSource).toContain("postBalancedVoucherTx");
    expect(routeSource).toContain("adjustSpInventoryAtomic");
  });

  it("does not require a cutover before container activity", () => {
    expect(routeSource).toContain("GC_PHASE8_NOT_CONFIGURED");
    expect(routeSource).toContain("Container activity is available as soon as Golden Coast accounts are");
    expect(routeSource).not.toContain("cutoverVoucherNumber");
  });

  it("still admits a company that carried no stock in hand across the cutover", () => {
    // Phase 4 skips zero-quantity inventory; Phase 8 no longer depends on it.
    expect(phase4ServiceSource).toContain("if (quantity.isZero()) continue;");
    expect(routeSource).not.toContain("pending_count");
  });

  it("resolves every posting account from the canonical Golden Coast role definitions", () => {
    for (const role of ["stock_otw", "stock_in_hand", "container_reserve", "hassan_equity", "hassan_savings"]) {
      expect(routeSource).toContain(`"${role}"`);
    }
    expect(routeSource).toContain("getGoldenCoastAccountDefinition");
    expect(routeSource).toContain("definition.acceptedAccountTypes.includes(String(row.accountType))");
    expect(routeSource).toContain("GC_PHASE8_ROLES_INVALID");
  });

  it("re-derives the funded container from its own voucher rather than trusting the request", () => {
    expect(routeSource).toContain("loadFundedContainer");
    expect(routeSource).toContain('.for("update")');
    expect(routeSource).toContain("GC_PHASE8_CONTAINER_NOT_FUNDED");
    expect(routeSource).toContain("GC_PHASE8_FUNDING_CORRUPT");
    expect(routeSource).toContain("Container lines no longer reconcile to the funded Stock OTW amount");
  });

  it("validates every foreign key against the selected company", () => {
    expect(routeSource).toContain("GC_PHASE8_FUNDING_ACCOUNT_INVALID");
    expect(routeSource).toContain("GC_PHASE8_STOCK_ITEM_INVALID");
    expect(routeSource).toContain("GC_PHASE8_SUPPLIER_INVALID");
    expect(routeSource).toContain("GC_PHASE8_LOCATION_INVALID");
    expect(routeSource).toContain("requireSpCompany");
  });

  it("binds replay to the container and offload source documents", () => {
    expect(routeSource).toContain("GOLDEN_COAST_PHASE8_SOURCE_TYPE");
    expect(routeSource).toContain("GC_PHASE8_IDEMPOTENCY_CORRUPT");
    expect(routeSource).toContain("GC_PHASE8_IDEMPOTENCY_CONFLICT");
    expect(routeSource).toContain("posted.replayed");
  });

  it("writes offload lots under the Phase 8 FIFO provenance that sales can consume", () => {
    expect(routeSource).toContain("sourceType: GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE");
    expect(phase5ServiceSource).toContain("GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE,");
    // The consumable-source list is static so a sale cannot depend on route
    // registration order to see post-cutover lots.
    expect(spIndexSource).not.toContain("GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES");
  });

  it("records offload totals with the same column meanings as the legacy offload route", () => {
    expect(routeSource).toContain("totalBaseCostUsd: plan.goodsCostUsd");
    expect(routeSource).toContain("totalLandedCostUsd: plan.actualChargesUsd");
    expect(routeSource).toContain("totalFinalCostUsd: plan.totalFinalCostUsd");
    expect(routeSource).toContain("landedUnitCostUsd: line.landedUnitCostUsd");
  });

  it("bridges containers the migration carried across the cutover", () => {
    // Phase 4 retires POST /api/sp/offload for Golden Coast companies, so a
    // cutover container with no Phase 8 marker would otherwise have no offload
    // path at all.
    expect(phase4RouteSource).toContain('{ method: "POST", pattern: /^\\/offload\\/?$/ }');
    expect(migrationReconcileSource).toContain("`GC-OTW-${targetId}-${sourceContainerId}`");
    expect(routeSource).toContain("source_module = 'SP_MIGRATION'");
    expect(routeSource).toContain('origin = "cutover"');
    expect(routeSource).toContain("GC_PHASE8_CONTAINER_NOT_FUNDED");
  });

  it("keeps the cutover clearing credit out of the funding-account check", () => {
    // The GC-OTW credit is the migration's OTW clearing account, not a
    // Cash/Bank account, and nothing debits it back at offload.
    expect(routeSource).toContain(
      'if (origin === "phase8") {\n    await validateFundingAccount(tx, companyId, fundingAccount);'
    );
    expect(routeSource).toContain("A migration cutover container cannot carry a Phase 8 container reserve");
  });

  it("settles cutover charges against a validated caller-named funding account", () => {
    expect(routeSource).toContain("GC_PHASE8_CHARGE_FUNDING_UNEXPECTED");
    expect(routeSource).toContain(
      "await validateFundingAccount(tx, selectedCompany, offloadInput.chargeFundingAccount)"
    );
    expect(phase8ServiceSource).toContain("GC_PHASE8_CHARGE_FUNDING_REQUIRED");
    // The reserve ceiling and the Hassan Savings sweep are Phase 8-only; cutover
    // and Fresh Start Excel containers never funded a reserve to sweep.
    expect(phase8ServiceSource).toContain(
      'const unused = funded.origin === "cutover" || funded.origin === "fresh_start_excel" ? new Decimal(0) : reserve.minus(actual);'
    );
  });

  it("closes the container once it is offloaded", () => {
    expect(routeSource).toContain('.set({ status: "offloaded" })');
    expect(routeSource).toContain("GC_PHASE8_CONTAINER_CLOSED");
  });
});
