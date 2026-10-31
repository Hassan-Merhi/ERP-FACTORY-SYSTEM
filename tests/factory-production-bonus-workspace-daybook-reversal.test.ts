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

describe("Production Bonuses dedicated page and audited Daybook deletion", () => {
  it("moves compensation controls off the daily Production Targets table", () => {
    const targets = source("client/src/pages/factory/FactoryProductionTargets.tsx");
    const routes = source("client/src/components/FactoryRoutes.tsx");
    const workspace = source("client/src/pages/factory/FactoryProductionBonuses.tsx");
    expectCode(targets, 'data-testid="button-open-production-bonuses"');
    expectCode(targets, 'navigate("/factory/production-bonuses?date=" + referenceDate)');
    expectNoCode(targets, "<ProductionTargetBonusPaymentsPanel");
    expectCode(routes, 'path="/factory/production-bonuses"');
    expectCode(routes, 'user?.role === "Admin" || user?.role === "Owner"');
    expectCode(workspace, "<ProductionBonusCheckoutPanel");
    expectCode(workspace, "<ProductionBonusHistoryPanel");
    expectNoCode(workspace, "<ProductionBonusesPanel");
    expectNoCode(workspace, "<ProductionTargetBonusPaymentsPanel");
    const checkout = source("client/src/pages/factory/productiontargets/ProductionBonusCheckoutPanel.tsx");
    expectCode(checkout, "<ProductionBonusCategoryRatesPanel");
    expectCode(checkout, 't("reviewPay")');
    expectCode(checkout, "/checkout");
    expectCode(checkout, '<SelectItem value="category">');
    expectCode(workspace, "/factory/stock-entry?tab=production-targets");
    expectCode(source("client/src/pages/factory/BaleStockEntry.tsx"), 'get("tab") === "production-targets"');
  });

  it("only offers categories defined in Production Targets and omits unnecessary evidence panels", () => {
    const rates = source("server/routes/factory/productionTargetBonusCategoryRateRoutes.ts");
    const editor = source("client/src/pages/factory/productiontargets/ProductionBonusCategoryRatesPanel.tsx");
    const page = source("client/src/pages/factory/FactoryProductionBonuses.tsx");
    expectCode(rates, "FROM factory_worker_production_target_defaults");
    expectCode(rates, "JOIN factory_staff_tracking_entries e");
    expectCode(rates, "latest_defaults");
    expectNoCode(rates, "SELECT name AS category FROM factory_worker_categories");
    expectCode(rates, "Select an existing category from Production Targets");
    expectCode(editor, 'aria-label="Production Targets category"');
    expectCode(editor, "data?.categories.some");
    expectNoCode(page, "<ProductionBonusCategoryEvidencePanel");
    expectNoCode(page, "<ProductionBonusCategoryPreviewPanel");
  });

  it("shows the reviewed calculation, USD account and explicit Pay action", () => {
    const daily = source("client/src/pages/factory/productiontargets/ProductionTargetBonusPaymentsPanel.tsx");
    const weekly = source("client/src/pages/factory/productiontargets/ProductionTargetWeeklyBonusPaymentsPanel.tsx");
    const server = source("server/routes/factory/factoryTargetBonusPaymentRoutes.ts");
    expectCode(server, 'rv.target_bales::text AS "targetBales"');
    expectCode(server, 'rv.extra_bales::text AS "extraBales"');
    expectCode(server, 'rv.rate_per_bale::text AS "ratePerBale"');
    expectCode(daily, "data-testid={`pay-daily-production-bonus-${row.reviewId}`}");
    expectCode(daily, "Verified calculation · approved daily review");
    expectCode(daily, "Confirm daily bonus paying account");
    expectCode(daily, "Approved to pay:");
    expectCode(weekly, '"pay-weekly-production-bonus-"');
    expectCode(weekly, "Approved weekly calculation");
    expectCode(weekly, "Confirm weekly bonus paying account");
    expectCode(weekly, "Approve Payment & Pay");
  });

  it("routes Daybook deletion of daily and weekly claims through accounting reversal", () => {
    // Bonus reversal helpers live in daybookEditPolicy.ts next to the route.
    const edit =
      source("server/routes/factory/docs-users/daybookEditRoutes.ts") +
      source("server/routes/factory/docs-users/daybookEditPolicy.ts");
    expectCode(edit, 'table === "factory_target_bonus_payments"');
    expectCode(edit, 'table === "factory_target_bonus_weekly_payments"');
    expectCode(edit, "reverseTargetBonusPayment(companyId");
    expectCode(edit, "reverseWeeklyBonusPayment(companyId");
    expectCode(edit, "const bonus = bonusSource(entry.referenceTable, entry.referenceId)");
    expectCode(edit, "if (bonusVoucher.length)");
    expect(edit).toMatch(/if \(\s*entry\.txType === "PRODUCTION_TARGET_BONUS_REVERSAL"/);
    expectCode(edit, "retainedAudit:true");
    expectCode(edit, "Posted bonus Daybook entries cannot be edited");
    expectCode(edit, "res.status(errorStatus(error))");
    const daily = source("server/services/factory/targetBonusPaymentService.ts");
    const weekly = source("server/services/factory/weeklyBonusPaymentService.ts");
    for (const service of [daily, weekly]) {
      expectCode(service, "pg_advisory_xact_lock(84023");
      expectCode(service, "status='REVERSED'");
      expectCode(service, 'voucherType: "Receipt"');
    }
  });

  it("hides both reversal sides from active Daybook so net deleted total is zero", () => {
    const legacy = source("server/routes/factory/factoryDaybookRoutes.ts");
    const paged = source("server/routes/factory/factoryDaybookPaginationRoutes.ts");
    for (const file of [legacy, paged]) {
      expectCode(file, "PRODUCTION_TARGET_BONUS_PAYMENT','PRODUCTION_TARGET_BONUS_REVERSAL");
      expectCode(file, "PRODUCTION_TARGET_WEEKLY_BONUS_PAYMENT','PRODUCTION_TARGET_WEEKLY_BONUS_REVERSAL");
      expectCode(file, "payment_voucher_id");
      expectCode(file, "reversal_voucher_id");
    }
    const integrity = source("server/services/factory/daybookSourceIntegrity.ts");
    expectCode(integrity, 'sourceTable: "factory_target_bonus_payments"');
    expectCode(integrity, 'sourceTable: "factory_target_bonus_weekly_payments"');
    const dialog = source("client/src/pages/factory/daybook/FactoryDaybookDialogs.tsx");
    expectCode(dialog, "Reverse & Remove");
    expectCode(dialog, "retained for audit");
  });
});
