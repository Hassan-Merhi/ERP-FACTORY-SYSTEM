/**
 * TALAL's directory is an operational settlement view, not a mutation
 * of historical posted USD or native-currency voucher balances.
 */
import { describe, expect, it } from "vitest";
import { sumMoney, toMoney } from "../server/lib/money";

describe("TALAL ANAKYKLOS CYPRUS inside/outside balance parity", () => {
  it("reproduces negative EUR 2609 settlement from goods, freight and FX", () => {
    const goods = toMoney("90655.20");
    const freight = toMoney("25600.00");
    const fxSettlements = sumMoney(["21411.00", "20392.60", "43887.00", "16586.80", "16586.80"]);
    expect(fxSettlements.toFixed(2)).toBe("118864.20");
    const netPayable = goods.plus(freight).minus(fxSettlements);
    expect(netPayable.toFixed(2)).toBe("-2609.00");
    expect(netPayable.times("1.18").toFixed(2)).toBe("-3078.62");
  });
});
