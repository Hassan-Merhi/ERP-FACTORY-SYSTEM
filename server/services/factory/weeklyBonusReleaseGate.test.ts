import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Formatting-insensitive source check: compares code tokens, not layout, so a
// Prettier reflow of the source cannot break the contract.
const normalizeCode = (code: string) =>
  code
    .replace(/\s+/g, "")
    .replace(/'/g, '"')
    .replace(/\((\w+)\)=>/g, "$1=>")
    .replace(/,([}\])])/g, "$1");
const expectCode = (code: string, expected: string) => expect(normalizeCode(code)).toContain(normalizeCode(expected));
const expectNoCode = (code: string, unexpected: string) =>
  expect(normalizeCode(code)).not.toContain(normalizeCode(unexpected));

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** Static wiring safety gate; real SQL and voucher-posting integration must run separately. */
describe("Phase 16 weekly bonus end-to-end source wiring", () => {
  it("ensures unconditional startup installs weekly review before one-time payment claims", () => {
    const index = source("server/index.ts");
    const staff = source("server/startup/factoryStaffTrackingSchema.ts");
    const payment = source("server/startup/ensureFactoryTargetBonusPaymentSchema.ts");
    expect(index.indexOf("await ensureFactoryStaffTrackingSchema(pool)")).toBeLessThan(
      index.indexOf("await ensureFactoryTargetBonusPaymentSchema(pool)")
    );
    expectCode(staff, "await database.query(FACTORY_BONUS_WEEKLY_REVIEW_SQL)");
    expectCode(payment, "factory_target_bonus_weekly_payments");
    expectCode(payment, "UNIQUE (company_id, week_start, worker_id)");
  });
  it("routes approvals, payments and reconciliation behind company and role checks", () => {
    const routes = source("server/routes/factory/factoryStaffTrackingRoutes.ts");
    expectCode(routes, "registerProductionTargetBonusWeeklyReviewRoutes(app)");
    expectCode(routes, "registerProductionTargetBonusWeeklyPaymentRoutes(app)");
    expectCode(routes, "registerProductionTargetBonusWeeklyReconciliationRoutes(app)");
    for (const file of [
      "productionTargetBonusWeeklyReviewRoutes.ts",
      "productionTargetBonusWeeklyPaymentRoutes.ts",
      "productionTargetBonusWeeklyReconciliationRoutes.ts",
    ]) {
      const body = source("server/routes/factory/" + file);
      expectCode(body, "requireAuth");
      expectCode(body, "hide_tab_stockentry_production_targets");
      expectCode(body, "factoryCompanyId");
      expectCode(body, "Admin");
      expectCode(body, "Owner");
    }
  });
  it("serializes daily and weekly claims on one company-wide advisory lock", () => {
    for (const file of [
      "factoryTargetBonusRoutes.ts",
      "productionBonusCategoryReviewRoutes.ts",
      "productionTargetBonusWeeklyReviewRoutes.ts",
    ]) {
      expectCode(source("server/routes/factory/" + file), "pg_advisory_xact_lock(84023");
    }
    for (const file of ["targetBonusPaymentService.ts", "weeklyBonusPaymentService.ts"]) {
      expectCode(source("server/services/factory/" + file), "pg_advisory_xact_lock(84023");
    }
    expectCode(source("server/services/factory/targetBonusPaymentService.ts"), "factory_target_bonus_weekly_reviews");
    expectCode(source("server/services/factory/weeklyBonusPaymentService.ts"), "factory_target_bonus_reviews");
  });
  it("uses the approved immutable amount and balanced account posting", () => {
    const payment = source("server/services/factory/weeklyBonusPaymentService.ts");
    expectCode(payment, "weeklyBonusReviewToken(saved)");
    expectCode(payment, "payingAccountTx(tx, companyId");
    expectCode(payment, "expenseAccountTx(tx, companyId)");
    expectCode(payment, "ledgerAccountId: expenseId, debit: review.amount");
    expectCode(payment, "ledgerAccountId: cashId, credit: review.amount");
    expectCode(payment, "ledgerAccountId: Number(row.cashAccountId), debit: amount");
    expectCode(payment, "ledgerAccountId: Number(row.expenseAccountId), credit: amount");
    expectCode(payment, "PRODUCTION_TARGET_WEEKLY_BONUS_PAYMENT");
    expectCode(payment, "PRODUCTION_TARGET_WEEKLY_BONUS_REVERSAL");
    const integrity = source("server/services/factory/daybookSourceIntegrity.ts");
    expectCode(integrity, 'sourceTable: "factory_target_bonus_weekly_payments"');
  });
  it("has separate admin UI approval, payment, reversal and downloadable Excel", () => {
    const review = source("client/src/pages/factory/productiontargets/ProductionBonusWeeklyPreviewPanel.tsx");
    const payment = source("client/src/pages/factory/productiontargets/ProductionTargetWeeklyBonusPaymentsPanel.tsx");
    expectCode(review, "Confirm decision");
    expectCode(payment, "Approve Payment & Pay");
    expectCode(payment, "Verify accounting");
    expectCode(payment, "Confirm Reversal");
    expectCode(payment, "Export Excel");
    expectCode(source("client/src/pages/factory/productiontargets/weeklyBonusPaymentsExcel.ts"), "Worker Totals");
  });
});
