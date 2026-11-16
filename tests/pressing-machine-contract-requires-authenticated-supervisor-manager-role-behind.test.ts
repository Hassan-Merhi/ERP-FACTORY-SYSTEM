import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const correction = read("server/routes/factory/factoryPressingCorrectionRoutes.ts");
const confirm = read("server/routes/factory/factoryPressingConfirmationRoutes.ts");
const report = read("server/routes/factory/factoryPressingReportRoutes.ts");
const ui = read("client/src/pages/factory/PressingCorrectionReview.tsx");
const history = read("client/src/pages/factory/PressingHistoryReport.tsx");
const queue = read("client/src/pages/factory/PressingOfflineQueueStatus.tsx");
const routes = read("server/routes/factoryRoutes.ts");
const ddl = read("migrations/20261027_001_factory_pressing_machine_tracking.sql");
const contract = read("shared/schema/factory/pressing-machine-tracking.ts");

describe("Pressing Machines Phase 8 correction and audit controls", () => {
  it("requires authenticated supervisor/manager role behind Factory page access", () => {
    expect(routes).toContain('registerFactoryPressingCorrectionRoutes(app)');
    expect(routes.indexOf('app.use("/api/factory", enforceFactoryBackendAccess)'))
      .toBeLessThan(routes.indexOf('registerFactoryPressingCorrectionRoutes(app)'));
    expect(correction).toContain('"/api/factory/pressing-machines/confirmations/:id/void"');
    expect(correction).toContain("requireAuth");
    expect(correction).toContain("requireSupervisor(req)");
    expect(correction).toContain("getActiveCompanyPermissionContext(req)");
    expect(correction).toContain("!SUPERVISORS.has(ctx.role) || ctx.posViewOnly");
  });

  it("requires no typed explanation for X and refuses double voids", () => {
    expect(correction).toContain("reason: z.string().trim().max(1000).optional()");
    expect(correction).toContain("correctionRequest.parse(req.body ?? {})");
    expect(correction).toContain("Deleted from active pressing scans by supervisor");
    expect(correction).toContain("PRESSING_ALREADY_VOIDED");
    expect(correction).toContain('reason: { old: null, new: reason }');
  });

  it("locks correct tenant/machine/bale/confirmation before mutation", () => {
    expect(correction).toContain("eq(factoryPressingConfirmations.companyId, ctx.companyId)");
    expect(correction).toContain("eq(factoryPressingMachines.companyId, ctx.companyId)");
    expect(correction).toContain("eq(factoryBales.companyId, ctx.companyId)");
    expect(correction).toContain("eq(factoryBales.id, target.baleId)");
    expect(correction).toContain('eq(factoryPressingConfirmations.id, confirmationId))).for("update")');
    expect(correction).toContain("db.transaction(async tx =>");
  });

  it("appends correction BEFORE the sole permitted voided_at/voided_by change", () => {
    const insert = correction.indexOf("tx.insert(factoryPressingCorrections)");
    const update = correction.indexOf("tx.update(factoryPressingConfirmations)");
    expect(insert).toBeGreaterThan(0);
    expect(update).toBeGreaterThan(insert);
    expect(correction).toContain('action: "VOID"');
    expect(correction).toContain("voidedAt: now");
    expect(correction).toContain("voidedBy: ctx.userId");
    expect(correction).toContain('action: "void"');
    expect(correction).toContain("}, tx)");
    expect(ddl).toContain("factory_pressing_corrections_immutable_trg");
    expect(ddl).toContain("BEFORE UPDATE OR DELETE ON factory_pressing_corrections");
    expect(ddl).toContain("factory_pressing_confirmations_protect_trg");
    expect(ddl).toContain("A supervisor correction event must be recorded before voiding");
  });

  it("keeps the original request and prevents rescan duplicates across machines", () => {
    expect(contract).toContain("factory_pressing_confirmations_one_active_bale_uk");
    expect(contract).toContain("factory_pressing_confirmations_request_uk");
    expect(confirm).toContain("PRESSING_CONFIRMATION_VOIDED");
    expect(confirm).toContain("PRESSING_ALREADY_CONFIRMED");
    expect(confirm).toContain("if (prior.voidedAt)");
    expect(confirm).toContain('action: "RECONFIRM"');
    expect(confirm).toContain("replacementConfirmationId: created.id");
    expect(confirm).toContain("voidedPrior.voidedBy");
    expect(confirm).toContain("tx.insert(factoryPressingCorrections)");
  });

  it("excludes voids from permanent production and machine analytics", () => {
    expect(report).toContain("COUNT(*) FILTER (WHERE c.voided_at IS NULL)");
    expect(report).toContain("SUM(c.weight_kg) FILTER (WHERE c.voided_at IS NULL)");
    expect(routes).not.toContain("registerFactoryPressingOperationsRoutes(app)");
    expect(report).toContain('"c.voided_at IS NOT NULL"');
    expect(report).toContain('AND active.voided_at IS NULL');
    expect(report).toContain('AS "canReturn"');
    expect(ui).toContain('row.canReturn !== false');
    expect(report).toContain('c.voided_at AS "voidedAt"');
    expect(queue).toContain("supervisors may subsequently void them");
  });

  it("shows immediate X and Return buttons with immutable correction history", () => {
    expect(history).toContain("canSeeEveryone");
    expect(history).toContain("showCorrections");
    expect(history).toContain("<PressingCorrectionReview");
    expect(ui).toContain('action: "void"');
    expect(ui).toContain('action: "restore"');
    expect(ui).toContain('aria-label={"Delete pressing scan "');
    expect(ui).toContain('aria-label={"Return voided bale "');
    expect(ui).not.toContain("confirmationText");
    expect(ui).not.toContain("Mandatory explanation");
    expect(ui).toContain("/corrections?");
    expect(ui).toContain("Original #");
    expect(ui).toContain("Replacement #");
    expect(ui).toContain('queryKey: [ROOT, "data", companyId, userId]');
    expect(ui).toContain("queryClient.invalidateQueries");
  });

  it("returns a voided scan without rescan, preserving its operator and original production time", () => {
    expect(correction).toContain('"/api/factory/pressing-machines/confirmations/:id/restore"');
    expect(correction).toContain("requireSupervisor(req)");
    expect(correction).toContain("PRESSING_NOT_VOIDED");
    expect(correction).toContain("PRESSING_ALREADY_CONFIRMED");
    expect(correction).toContain("isNull(factoryPressingConfirmations.voidedAt)");
    expect(correction).toContain("requestId: \"supervisor-restore-\" + randomUUID()");
    expect(correction).toContain("userId: original.userId");
    expect(correction).toContain("weightKg: original.weightKg");
    expect(correction).toContain("confirmedAt: original.confirmedAt");
    expect(correction).toContain("productionDate: original.productionDate");
    expect(correction).toContain('action: "RECONFIRM"');
    expect(correction).toContain("replacementConfirmationId: restored.id");
    expect(correction).toContain('action: "restore"');
    expect(correction).toContain("}, tx)");
  });

  it("has no accounting, stock, mix or Factory finalize side effects", () => {
    for (const source of [correction, confirm]) {
      expect(source).not.toMatch(/tx\.(?:update|insert|delete)\(factoryBales\)/);
      expect(source).not.toContain("adjustInventory");
      expect(source).not.toContain("writeDaybookEntry");
      expect(source).not.toContain("postStockMovementTx");
      expect(source).not.toContain("/api/factory/finalize");
    }
  });
});
