import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path:string) => readFileSync(resolve(process.cwd(),path),"utf8");

/** Static wiring safety gate; real SQL and voucher-posting integration must run separately. */
describe("Phase 16 weekly bonus end-to-end source wiring",()=>{
  it("ensures unconditional startup installs weekly review before one-time payment claims",()=>{
    const index=source("server/index.ts");
    const staff=source("server/startup/factoryStaffTrackingSchema.ts");
    const payment=source("server/startup/ensureFactoryTargetBonusPaymentSchema.ts");
    expect(index.indexOf("await ensureFactoryStaffTrackingSchema(pool)"))
      .toBeLessThan(index.indexOf("await ensureFactoryTargetBonusPaymentSchema(pool)"));
    expect(staff).toContain("await database.query(FACTORY_BONUS_WEEKLY_REVIEW_SQL)");
    expect(payment).toContain("factory_target_bonus_weekly_payments");
    expect(payment).toContain("UNIQUE (company_id, week_start, worker_id)");
  });
  it("routes approvals, payments and reconciliation behind company and role checks",()=>{
    const routes=source("server/routes/factory/factoryStaffTrackingRoutes.ts");
    expect(routes).toContain("registerProductionTargetBonusWeeklyReviewRoutes(app)");
    expect(routes).toContain("registerProductionTargetBonusWeeklyPaymentRoutes(app)");
    expect(routes).toContain("registerProductionTargetBonusWeeklyReconciliationRoutes(app)");
    for(const file of ["productionTargetBonusWeeklyReviewRoutes.ts",
      "productionTargetBonusWeeklyPaymentRoutes.ts",
      "productionTargetBonusWeeklyReconciliationRoutes.ts"]){
      const body=source("server/routes/factory/"+file);
      expect(body).toContain("requireAuth");
      expect(body).toContain("hide_tab_stockentry_production_targets");
      expect(body).toContain("factoryCompanyId");
      expect(body).toContain("Admin");
      expect(body).toContain("Owner");
    }
  });
  it("serializes daily and weekly claims on one company-wide advisory lock",()=>{
    for(const file of ["factoryTargetBonusRoutes.ts","productionBonusCategoryReviewRoutes.ts",
      "productionTargetBonusWeeklyReviewRoutes.ts"]){
      expect(source("server/routes/factory/"+file)).toContain("pg_advisory_xact_lock(84023");
    }
    for(const file of ["targetBonusPaymentService.ts","weeklyBonusPaymentService.ts"]){
      expect(source("server/services/factory/"+file)).toContain("pg_advisory_xact_lock(84023");
    }
    expect(source("server/services/factory/targetBonusPaymentService.ts"))
      .toContain("factory_target_bonus_weekly_reviews");
    expect(source("server/services/factory/weeklyBonusPaymentService.ts"))
      .toContain("factory_target_bonus_reviews");
  });
  it("uses the approved immutable amount and balanced account posting",()=>{
    const payment=source("server/services/factory/weeklyBonusPaymentService.ts");
    expect(payment).toContain("weeklyBonusReviewToken(saved)");
    expect(payment).toContain("payingAccountTx(tx, companyId");
    expect(payment).toContain("expenseAccountTx(tx, companyId)");
    expect(payment).toContain("ledgerAccountId: expenseId, debit: review.amount");
    expect(payment).toContain("ledgerAccountId: cashId, credit: review.amount");
    expect(payment).toContain("ledgerAccountId: Number(row.cashAccountId), debit: amount");
    expect(payment).toContain("ledgerAccountId: Number(row.expenseAccountId), credit: amount");
    expect(payment).toContain("PRODUCTION_TARGET_WEEKLY_BONUS_PAYMENT");
    expect(payment).toContain("PRODUCTION_TARGET_WEEKLY_BONUS_REVERSAL");
    const integrity=source("server/services/factory/daybookSourceIntegrity.ts");
    expect(integrity).toContain('sourceTable: "factory_target_bonus_weekly_payments"');
  });
  it("has separate admin UI approval, payment, reversal and downloadable Excel",()=>{
    const review=source("client/src/pages/factory/productiontargets/ProductionBonusWeeklyPreviewPanel.tsx");
    const payment=source("client/src/pages/factory/productiontargets/ProductionTargetWeeklyBonusPaymentsPanel.tsx");
    expect(review).toContain("Confirm decision");
    expect(payment).toContain("Approve Payment & Pay");
    expect(payment).toContain("Verify accounting");
    expect(payment).toContain("Confirm Reversal");
    expect(payment).toContain("Export Excel");
    expect(source("client/src/pages/factory/productiontargets/weeklyBonusPaymentsExcel.ts"))
      .toContain("Worker Totals");
  });
});
