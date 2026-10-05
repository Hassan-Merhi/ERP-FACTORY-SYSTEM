import { describe, expect, it } from "vitest";
import {
  allocateRetailRefund,
  calculateRetailReturnAmounts,
  calculateRetailSaleAmounts,
  finalizeRetailTender,
  retailCheckoutFingerprint,
} from "../server/services/retail/retailFinancialMath";

describe("Retail Wave 1 financial math", () => {
  it("allocates discounts and tax once and reconciles split tenders with cash change", () => {
    const sale = calculateRetailSaleAmounts(
      [
        { variantId: 8, quantity: 1, unitPrice: 10, unitCost: 4 },
        { variantId: 9, quantity: 1, unitPrice: 10, unitCost: 5 },
      ],
      "1.01",
      "0.50"
    );
    expect(sale.subtotalAmount).toBe("20.00");
    expect(sale.discountAmount).toBe("1.01");
    expect(sale.taxAmount).toBe("0.50");
    expect(sale.totalAmount).toBe("19.49");
    expect(sale.lines.reduce((sum, line) => sum + Number(line.totalAmount), 0)).toBeCloseTo(19.49, 2);

    const payments = finalizeRetailTender(sale.totalAmount, [
      { method: "cash", amount: "9.49", amountTendered: "10.00" },
      { method: "card", amount: "10.00", reference: "terminal-0001" },
    ]);
    expect(payments).toEqual([
      expect.objectContaining({ amount: "9.49", amountTendered: "10.00", changeDue: "0.51" }),
      expect.objectContaining({ method: "card", amount: "10.00", reference: "terminal-0001" }),
    ]);
    expect(() => finalizeRetailTender(sale.totalAmount, [{ method: "cash", amount: "19.48" }])).toThrow(
      "Payments must equal the sale total"
    );
  });

  it("uses cumulative snapshots for partial returns and keeps payment references", () => {
    const first = calculateRetailReturnAmounts({
      soldQuantity: 3,
      returnedBefore: 0,
      returnQuantity: 1,
      grossAmount: "10.00",
      discountAmount: "0.02",
      taxAmount: "0.01",
      unitCost: "2.00",
    });
    const middle = calculateRetailReturnAmounts({
      soldQuantity: 3,
      returnedBefore: 1,
      returnQuantity: 1,
      grossAmount: "10.00",
      discountAmount: "0.02",
      taxAmount: "0.01",
      unitCost: "2.00",
    });
    const last = calculateRetailReturnAmounts({
      soldQuantity: 3,
      returnedBefore: 2,
      returnQuantity: 1,
      grossAmount: "10.00",
      discountAmount: "0.02",
      taxAmount: "0.01",
      unitCost: "2.00",
    });
    expect(Number(first.totalAmount) + Number(middle.totalAmount) + Number(last.totalAmount)).toBeCloseTo(9.99, 2);
    expect(last.cogsAmount).toBe("2.00");

    const refunds = allocateRetailRefund("7.00", [
      { method: "cash", availableAmount: "5.00", reference: "drawer-1" },
      { method: "card", availableAmount: "10.00", reference: "auth-9" },
    ]);
    expect(refunds.map((line) => line.amount)).toEqual(["-2.33", "-4.67"]);
    expect(refunds.map((line) => line.reference)).toEqual(["drawer-1", "auth-9"]);
    expect(allocateRetailRefund("1.25", [], "store_credit")).toEqual([
      { method: "store_credit", amount: "-1.25", reference: null },
    ]);
  });

  it("fingerprints checkout payment details so retries cannot change tender rails", () => {
    const base = {
      locationId: 2,
      items: [{ variantId: 5, quantity: 1 }],
      payments: [{ method: "cash", amount: "10.00" }],
    };
    expect(retailCheckoutFingerprint(base)).toBe(retailCheckoutFingerprint(base));
    expect(retailCheckoutFingerprint(base)).not.toBe(
      retailCheckoutFingerprint({ ...base, payments: [{ method: "card", amount: "10.00" }] })
    );
  });
});
