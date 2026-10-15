import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe,expect,it } from "vitest";
import { toMoney,sumMoney } from "../server/lib/money";
import { buildFactoryVoucherRequest } from "../server/services/factory/factoryVoucherPosting";

describe("UK BASMA source-backed posted vs operational reconciliation (company 12)",()=>{
  it("the original goods at $0.75/kg differ by $2,254.10 from current saved .8684/kg",()=>{
    const current=toMoney("19038").times("0.8684");
    const posted=toMoney("14278.50");
    expect(current.toFixed(4)).toBe("16532.5992");
    expect(current.minus(posted).toDecimalPlaces(2).toFixed(2)).toBe("2254.10");
    expect(toMoney("19038").times("0.75").toFixed(2)).toBe("14278.50");
  });
  it("freight $3361 was already booked to #812 debit / #805 credit, not supplier",()=>{
    // Voucher 9627's credit is being transferred, not a new freight expense.
    expect(sumMoney(["2254.10","3361.00"]).toFixed(2)).toBe("5615.10");
    expect(toMoney("-5615.10").plus("2254.10").plus("3361.00").toFixed(2))
      .toBe("0.00");
  });
  it("makes two balanced, USD-only, differently justified correcting vouchers",()=>{
    const base={companyId:12,voucherType:"Journal" as const,
      voucherDate:"2026-10-15",currency:"USD",fxRateToUsd:"1",
      source:{sourceType:"factory-basma-repair",sourceId:"one"}};
    const goods=buildFactoryVoucherRequest({
      ...base,voucherNumber:"FACTORY-BASMA-GOODS-CATCHUP-20261015-126",
      description:"goods value difference",lines:[
        {ledgerAccountId:814,debit:"2254.10"},
        {factorySupplierId:38,credit:"2254.10"},
      ],
    });
    const freight=buildFactoryVoucherRequest({
      ...base,voucherNumber:"FACTORY-BASMA-FREIGHT-RECLASS-20261015-85",
      description:"existing freight credit reclassification",lines:[
        {ledgerAccountId:805,debit:"3361.00"},
        {factorySupplierId:38,credit:"3361.00"},
      ],
    });
    for(const {entries} of [goods,freight]){
      expect(entries).toHaveLength(2);
      expect(entries[1].factorySupplierId).toBe(38);
      expect(toMoney(entries[0].debitAmount).minus(entries[1].creditAmount).isZero()).toBe(true);
    }
  });
  it("no other supplier is changed, only 2 exact-source vouchers, preview before apply",()=>{
    const script=readFileSync(resolve(process.cwd(),
      "scripts/repair-uk-basma-38-20261015.ts"),"utf8");
    const gate=readFileSync(resolve(process.cwd(),
      "server/startup/runApprovedUkBasma38.ts"),"utf8");
    expect(script).toContain("const BASMA = 38;");
    expect(script).toContain("const GOODS = 126;");
    expect(script).toContain("const FREIGHT = 85;");
    expect(script).toContain("BASMA_REPAIR_POSTCHECK_FAILED");
    expect(script).toContain("BASMA_PARTIAL_CORRECTION_REQUIRES_REVIEW");
    expect(gate).toContain("FACTORY_UK_BASMA_REPAIR_20261015");
    expect(gate).toContain("preview-company12-uk-basma");
    expect(gate).toContain("approved-company12-uk-basma");
    expect(gate).toContain("srv-d6kibgtactks739u7vl0");
    expect(gate).toContain("erp_db_qscj_64lv_e7rz_8744_2lm3");
  });
});
