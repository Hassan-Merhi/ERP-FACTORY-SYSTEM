/**
 * TALAL's directory is an operational settlement view, not a mutation
 * of historical posted USD or native-currency voucher balances.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sumMoney, toMoney } from "../server/lib/money";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("TALAL ANAKYKLOS CYPRUS inside/outside balance parity", () => {
  it("reproduces negative EUR 2609 settlement from goods, freight and FX", () => {
    const goods = toMoney("90655.20");
    const freight = toMoney("25600.00");
    const fxSettlements = sumMoney([
      "21411.00",
      "20392.60",
      "43887.00",
      "16586.80",
      "16586.80",
    ]);
    expect(fxSettlements.toFixed(2)).toBe("118864.20");
    const netPayable = goods.plus(freight).minus(fxSettlements);
    expect(netPayable.toFixed(2)).toBe("-2609.00");
    expect(netPayable.times("1.18").toFixed(2)).toBe("-3078.62");
  });

  it("keeps the old EUR -8519 ledger separate from the settlement display", () => {
    expect(toMoney("-8519.00").eq("-2609.00")).toBe(false);
    const route = read("server/routes/factory/suppliers/balance/with-balances.ts");
    expect(route).toContain(
      's.name.trim().toUpperCase() === "TALAL ANAKYKLOS CYPRUS"',
    );
    expect(route).toContain(
      "usePortugalSettlementDisplay || useTalalSettlementDisplay",
    );
    expect(route).toContain('displayBalanceBasis: "operational-statement"');
    expect(route).toContain(
      "usdEquivalentBalance: own.fxUnresolved ? null : own.balance.toFixed(3)",
    );
    expect(route).toContain("...ledgerFields(s.id)");
  });

  it("renders TALAL's overpayment green with CR, preserving Portugal precision", () => {
    const directory = read(
      "client/src/pages/factory/factory-suppliers/FactorySuppliersDirectory.tsx",
    );
    expect(directory).toContain(
      'supplier.displayBalanceBasis === "operational-statement"',
    );
    expect(directory).toContain("const isTalalSettlement =");
    expect(directory).toContain(
      "isOperationalSettlement && balance.balance > 0.005",
    );
    expect(directory).toContain(
      'balanceValue < 0 && !isTalalSettlement ? " DR" : " CR"',
    );
    expect(directory).toContain(
      'balance.balance < 0 && !isTalalSettlement ? " DR" : " CR"',
    );
    expect(directory).toContain(
      "const balanceDigits = isPortugalSaadSettlement ? 3 : 2",
    );
    expect(directory).toContain('"text-green-600 dark:text-green-400"');
  });
});
