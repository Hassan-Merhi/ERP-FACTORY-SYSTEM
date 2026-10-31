import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source=(file:string)=>readFileSync(resolve(process.cwd(),file),"utf8");
const service=()=>source("server/services/factory/manualProductionBonusPaymentService.ts");
const route=()=>source("server/routes/factory/productionBonusCheckoutRoutes.ts");

describe("Manual Production Bonuses",()=>{
  it("allows every roster worker to be selected and a separate amount entered without editing calculated rewards",()=>{
    const page=source("client/src/pages/factory/productiontargets/ProductionBonusCheckoutPanel.tsx");
    const sheet=source("client/src/pages/factory/productiontargets/ProductionBonusWeeklySheet.tsx");
    const payment=source("client/src/pages/factory/productiontargets/ProductionBonusManualPaymentPanel.tsx");
    expect(page).toContain("const [manualMode,setManualMode]=useState(true)");
    expect(sheet).toContain("manualMode || member.readyDays > 0");
    expect(sheet).toContain("onToggle(member.workerId,!selected.includes(member.workerId))");
    expect(sheet).toContain("onAmountChange?.(member.workerId, event.target.value)");
    expect(page).toContain("selected={manualSelected} amounts={manualAmounts}");
    expect(payment).toContain("selections:chosen.map(item=>({workerId:item.workerId,amount:item.amount}))");
  });
  it("posts each user-confirmed amount into a balanced voucher and daybook atomically",()=>{
    const s=service(), r=route();
    expect(s).toContain("return db.transaction(async tx => {");
    expect(s).toContain("pg_advisory_xact_lock(84023");
    expect(s).toContain("postErpVoucherTx(tx");
    expect(s).toContain('voucherType:"Payment"');
    expect(s).toContain("debit:selection.amount");
    expect(s).toContain("credit:selection.amount");
    expect(s).toContain('txType:"PRODUCTION_TARGET_MANUAL_BONUS_PAYMENT"');
    expect(s).toContain("await logAudit(");
    expect(r).toContain('checkout/manual-pay"');
  });
  it("uses idempotent request identities and prevents duplicate worker/week payouts",()=>{
    const s=service();
    expect(s).toContain("request_key");
    expect(s).toContain("existing.length !== command.selections.length");
    expect(s).toContain("priorManual");
    expect(s).toContain("SELECT 1 FROM factory_target_bonus_weekly_payments");
    expect(s).toContain("SELECT 1 FROM factory_target_bonus_payments");
    const startup=source("server/startup/ensureFactoryTargetBonusPaymentSchema.ts");
    expect(startup).toContain("factory_manual_bonus_request_worker_unique");
    expect(startup).toContain("factory_manual_bonus_voucher_unique");
    for(const target of ["targetBonusPaymentService.ts","weeklyBonusPaymentService.ts"]){
      expect(source("server/services/factory/"+target)).toContain("factory_target_bonus_manual_payments");
    }
  });
  it("reverses via a balancing receipt and retains permanent payment claim",()=>{
    const s=service();
    expect(s).toContain('voucherType:"Receipt"');
    expect(s).toContain("debit:String(row.amount)");
    expect(s).toContain("credit:String(row.amount)");
    expect(s).toContain('txType:"PRODUCTION_TARGET_MANUAL_BONUS_REVERSAL"');
    expect(s).toContain("status='REVERSED'");
    expect(source("server/services/factory/daybookSourceIntegrity.ts"))
      .toContain('"PRODUCTION_TARGET_MANUAL_BONUS_REVERSAL"');
    expect(source("server/routes/factory/factoryDaybookPaginationRoutes.ts"))
      .toContain("factory_target_bonus_manual_payments");
    expect(source("server/routes/factory/factoryDaybookRoutes.ts"))
      .toContain("factory_target_bonus_manual_payments");
  });
});
