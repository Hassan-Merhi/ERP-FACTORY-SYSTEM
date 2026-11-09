import { describe, expect, it } from "vitest";
import { planPosJnahPrepaidMonths, type PosJnahMonth } from "../server/startup/posJnahPrepaidPlan";

function snapshot(): PosJnahMonth[] {
  return Array.from({ length: 12 }, (_, i) => ({
    id: 701216 + i,
    contract_id: 36,
    unit_id: 59,
    year: i < 5 ? 2026 : 2027,
    month: (7 + i) % 12 + 1,
    expected_amount: "2500.00",
    paid_amount: "2500.00",
    accrual_voucher_id: i === 1 ? 13142 : i === 2 ? 15041 : null,
    used_prepaid_account: i === 1 || i === 2,
    used_advance_account: false,
  }));
}

describe("POS Jnah prepaid annual rent repair plan", () => {
  it("marks only eight future months for Dec 2026–Jul 2027 recognition", () => {
    expect(planPosJnahPrepaidMonths(snapshot())).toEqual([
      701220, 701221, 701222, 701223, 701224, 701225, 701226, 701227,
    ]);
  });
  it("refuses extra or missing months", () => {
    expect(() => planPosJnahPrepaidMonths(snapshot().slice(1))).toThrow("MONTH_COUNT_CHANGED");
  });
  it("refuses changed payments and pre-existing future accruals", () => {
    const alteredPayment = snapshot(); alteredPayment[7].paid_amount = "0.00";
    expect(() => planPosJnahPrepaidMonths(alteredPayment)).toThrow("MONTH_SNAPSHOT_CHANGED");
    const alreadyAccrued = snapshot(); alreadyAccrued[5].accrual_voucher_id = 22222;
    expect(() => planPosJnahPrepaidMonths(alreadyAccrued)).toThrow("MONTH_SNAPSHOT_CHANGED");
    const alreadyPrepaid = snapshot(); alreadyPrepaid[11].used_prepaid_account = true;
    expect(() => planPosJnahPrepaidMonths(alreadyPrepaid)).toThrow("MONTH_SNAPSHOT_CHANGED");
  });
  it("refuses a drifted earlier recognition or another contract", () => {
    const oldAccrual = snapshot(); oldAccrual[1].accrual_voucher_id = null;
    expect(() => planPosJnahPrepaidMonths(oldAccrual)).toThrow("MONTH_SNAPSHOT_CHANGED");
    const contract = snapshot(); contract[0].contract_id = 99;
    expect(() => planPosJnahPrepaidMonths(contract)).toThrow("MONTH_SNAPSHOT_CHANGED");
  });
});
