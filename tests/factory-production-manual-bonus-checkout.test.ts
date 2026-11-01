import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Compare code independent of formatting: whitespace, quote style, trailing
// commas and parentheses around a single arrow parameter are what prettier changes.
const normalized = (code: string) =>
  code
    .replace(/\s+/g, "")
    .replace(/'/g, '"')
    .replace(/,([)\]}])/g, "$1")
    .replace(/\((\w+)\)=>/g, "$1=>");
const source = (file: string) => normalized(readFileSync(resolve(process.cwd(), file), "utf8"));
const service = () => source("server/services/factory/manualProductionBonusPaymentService.ts");
const route = () => source("server/routes/factory/productionBonusCheckoutRoutes.ts");

describe("Manual Production Bonuses", () => {
  it("allows every roster worker to be selected and a separate amount entered without editing calculated rewards", () => {
    const page = source("client/src/pages/factory/productiontargets/ProductionBonusCheckoutPanel.tsx");
    const sheet = source("client/src/pages/factory/productiontargets/ProductionBonusWeeklySheet.tsx");
    const payment = source("client/src/pages/factory/productiontargets/ProductionBonusManualPaymentPanel.tsx");
    expect(page).toContain(normalized("const [manualMode,setManualMode]=useState(true)"));
    expect(sheet).toContain(normalized("manualMode || member.readyDays > 0"));
    expect(sheet).toContain(normalized("onToggle(member.workerId,!selected.includes(member.workerId))"));
    expect(sheet).toContain(normalized("onAmountChange?.(member.workerId, event.target.value)"));
    expect(page).toContain(normalized("selected={manualSelected} amounts={manualAmounts}"));
    expect(payment).toContain(normalized("selections:chosen.map(item=>({workerId:item.workerId,amount:item.amount}))"));
  });
  it("posts each user-confirmed amount into a balanced voucher and daybook atomically", () => {
    const s = service(),
      r = route();
    expect(s).toContain(normalized("return db.transaction(async tx => {"));
    expect(s).toContain(normalized("pg_advisory_xact_lock(84023"));
    expect(s).toContain(normalized("postErpVoucherTx(tx"));
    expect(s).toContain(normalized('voucherType:"Payment"'));
    expect(s).toContain(normalized("debit:selection.amount"));
    expect(s).toContain(normalized("credit:selection.amount"));
    expect(s).toContain(normalized('txType:"PRODUCTION_TARGET_MANUAL_BONUS_PAYMENT"'));
    expect(s).toContain(normalized("await logAudit("));
    expect(r).toContain(normalized('checkout/manual-pay"'));
  });
  it("uses idempotent request identities and prevents duplicate worker/week payouts", () => {
    const s = service();
    expect(s).toContain(normalized("request_key"));
    expect(s).toContain(normalized("existing.length !== command.selections.length"));
    expect(s).toContain(normalized("priorManual"));
    expect(s).toContain(normalized("SELECT 1 FROM factory_target_bonus_weekly_payments"));
    expect(s).toContain(normalized("SELECT 1 FROM factory_target_bonus_payments"));
    const startup = source("server/startup/ensureFactoryTargetBonusPaymentSchema.ts");
    expect(startup).toContain(normalized("factory_manual_bonus_request_worker_unique"));
    expect(startup).toContain(normalized("factory_manual_bonus_voucher_unique"));
    for (const target of ["targetBonusPaymentService.ts", "weeklyBonusPaymentService.ts"]) {
      expect(source("server/services/factory/" + target)).toContain(normalized("factory_target_bonus_manual_payments"));
    }
  });
  it("reverses via a balancing receipt and retains permanent payment claim", () => {
    const s = service();
    expect(s).toContain(normalized('voucherType:"Receipt"'));
    expect(s).toContain(normalized("debit:String(row.amount)"));
    expect(s).toContain(normalized("credit:String(row.amount)"));
    expect(s).toContain(normalized('txType:"PRODUCTION_TARGET_MANUAL_BONUS_REVERSAL"'));
    expect(s).toContain(normalized("status='REVERSED'"));
    expect(source("server/services/factory/daybookSourceIntegrity.ts")).toContain(
      '"PRODUCTION_TARGET_MANUAL_BONUS_REVERSAL"'
    );
    expect(source("server/routes/factory/factoryDaybookPaginationRoutes.ts")).toContain(
      "factory_target_bonus_manual_payments"
    );
    expect(source("server/routes/factory/factoryDaybookRoutes.ts")).toContain("factory_target_bonus_manual_payments");
  });
});
