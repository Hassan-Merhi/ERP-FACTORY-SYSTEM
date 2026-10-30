import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Production Bonuses dedicated page and audited Daybook deletion", () => {
  it("moves compensation controls off the daily Production Targets table", () => {
    const targets = source("client/src/pages/factory/FactoryProductionTargets.tsx");
    const routes = source("client/src/components/FactoryRoutes.tsx");
    const workspace = source("client/src/pages/factory/FactoryProductionBonuses.tsx");
    expect(targets).toContain('data-testid="button-open-production-bonuses"');
    expect(targets).toContain('navigate("/factory/production-bonuses?date=" + referenceDate)');
    expect(targets).not.toContain("<ProductionTargetBonusPaymentsPanel");
    expect(routes).toContain('path="/factory/production-bonuses"');
    expect(routes).toContain('user?.role === "Admin" || user?.role === "Owner"');
    for (const tab of ["setup", "review", "pay", "history"]) {
      expect(workspace).toContain(`key: "${tab}"`);
    }
    expect(workspace).toContain("<ProductionBonusWeeklyMethodPanel");
    expect(workspace).toContain("<ProductionBonusCategoryRatesPanel");
    expect(workspace).toContain("<ProductionBonusesPanel");
    expect(workspace).toContain("<ProductionTargetBonusPaymentsPanel");
  });

  it("shows the reviewed calculation, USD account and explicit Pay action", () => {
    const daily = source("client/src/pages/factory/productiontargets/ProductionTargetBonusPaymentsPanel.tsx");
    const weekly = source("client/src/pages/factory/productiontargets/ProductionTargetWeeklyBonusPaymentsPanel.tsx");
    const server = source("server/routes/factory/factoryTargetBonusPaymentRoutes.ts");
    expect(server).toContain('rv.target_bales::text AS "targetBales"');
    expect(server).toContain('rv.extra_bales::text AS "extraBales"');
    expect(server).toContain('rv.rate_per_bale::text AS "ratePerBale"');
    expect(daily).toContain('data-testid={`pay-daily-production-bonus-${row.reviewId}`}');
    expect(daily).toContain("Verified calculation · approved daily review");
    expect(daily).toContain("Confirm daily bonus paying account");
    expect(daily).toContain("Approved to pay:");
    expect(weekly).toContain('"pay-weekly-production-bonus-"');
    expect(weekly).toContain("Approved weekly calculation");
    expect(weekly).toContain("Confirm weekly bonus paying account");
    expect(weekly).toContain("Approve Payment & Pay");
  });

  it("routes Daybook deletion of daily and weekly claims through accounting reversal", () => {
    const edit = source("server/routes/factory/docs-users/daybookEditRoutes.ts");
    expect(edit).toContain('table === "factory_target_bonus_payments"');
    expect(edit).toContain('table === "factory_target_bonus_weekly_payments"');
    expect(edit).toContain("reverseTargetBonusPayment(companyId");
    expect(edit).toContain("reverseWeeklyBonusPayment(companyId");
    expect(edit).toContain("const bonus = bonusSource(entry.referenceTable, entry.referenceId)");
    expect(edit).toContain("if (bonusVoucher.length)");
    expect(edit).toContain("if (entry.txType === \"PRODUCTION_TARGET_BONUS_REVERSAL\"");
    expect(edit).toContain("retainedAudit:true");
    expect(edit).toContain("Posted bonus Daybook entries cannot be edited");
    expect(edit).toContain("res.status(errorStatus(error))");
    const daily = source("server/services/factory/targetBonusPaymentService.ts");
    const weekly = source("server/services/factory/weeklyBonusPaymentService.ts");
    for (const service of [daily,weekly]) {
      expect(service).toContain("pg_advisory_xact_lock(84023");
      expect(service).toContain('status=\'REVERSED\'');
      expect(service).toContain('voucherType: "Receipt"');
    }
  });

  it("hides both reversal sides from active Daybook so net deleted total is zero", () => {
    const legacy = source("server/routes/factory/factoryDaybookRoutes.ts");
    const paged = source("server/routes/factory/factoryDaybookPaginationRoutes.ts");
    for (const file of [legacy, paged]) {
      expect(file).toContain("PRODUCTION_TARGET_BONUS_PAYMENT','PRODUCTION_TARGET_BONUS_REVERSAL");
      expect(file).toContain("PRODUCTION_TARGET_WEEKLY_BONUS_PAYMENT','PRODUCTION_TARGET_WEEKLY_BONUS_REVERSAL");
      expect(file).toContain("payment_voucher_id");
      expect(file).toContain("reversal_voucher_id");
    }
    const integrity = source("server/services/factory/daybookSourceIntegrity.ts");
    expect(integrity).toContain('sourceTable: "factory_target_bonus_payments"');
    expect(integrity).toContain('sourceTable: "factory_target_bonus_weekly_payments"');
    const dialog = source("client/src/pages/factory/daybook/FactoryDaybookDialogs.tsx");
    expect(dialog).toContain("Reverse & Remove");
    expect(dialog).toContain("retained for audit");
  });
});
