import { describe, expect, it } from "vitest";
import {
  effectiveManualDiscountPercent,
  hasManualAdjustment,
  priceRetailCart,
  roundRetailMoney,
} from "./retailPricing";

const noOrder = { type: "none" as const, value: 0 };
const noTax = { enabled: false, rate: 0, inclusive: false };
const vat = { enabled: true, rate: 0.18, inclusive: false };
const vatInclusive = { enabled: true, rate: 0.18, inclusive: true };

const line = (overrides: Partial<Parameters<typeof priceRetailCart>[0][number]> = {}) => ({
  variantId: 1,
  quantity: 1,
  listUnitPrice: 10,
  ...overrides,
});

describe("retail pricing — untouched checkout keeps Wave 1 behaviour", () => {
  it("keeps exact prices with no rounding when nothing is adjusted", () => {
    const priced = priceRetailCart([line({ quantity: 3, listUnitPrice: 10.123456 })], noOrder, noTax);
    expect(priced.lines[0]).toMatchObject({
      originalUnitPrice: 10.123456,
      unitPrice: 10.123456,
      grossUnitPrice: 10.123456,
      lineDiscountAmount: 0,
      priceOverride: false,
      promotionId: null,
      taxAmount: 0,
      lineTotal: 30.370368,
      lineDiscountType: "none",
    });
    expect(priced.totalAmount).toBe(30.370368);
    expect(priced.subtotal).toBe(30.370368);
    expect(priced.discountTotal).toBe(0);
    expect(priced.taxAmount).toBe(0);
  });

  it("keeps the list price as the original price when a line discount applies", () => {
    const priced = priceRetailCart([line({ discountType: "percent", discountValue: 10 })], noOrder, noTax);
    expect(priced.lines[0].originalUnitPrice).toBe(10);
    expect(priced.lines[0].unitPrice).toBe(9);
    expect(priced.lines[0].lineDiscountAmount).toBe(1);
    expect(priced.lines[0].lineDiscountType).toBe("percent");
    expect(priced.lines[0].lineDiscountValue).toBe(10);
    expect(priced.totalAmount).toBe(9);
  });
});

describe("retail pricing — discounts", () => {
  it("applies fixed discounts per unit for the whole line quantity", () => {
    const priced = priceRetailCart(
      [line({ quantity: 4, listUnitPrice: 12.5, discountType: "fixed", discountValue: 2.5 })],
      noOrder,
      noTax
    );
    expect(priced.lines[0].unitPrice).toBe(10);
    expect(priced.lines[0].lineDiscountAmount).toBe(10);
    expect(priced.totalAmount).toBe(40);
  });

  it("never prices a line below zero", () => {
    const priced = priceRetailCart(
      [line({ quantity: 2, listUnitPrice: 5, discountType: "fixed", discountValue: 99 })],
      noOrder,
      noTax
    );
    expect(priced.lines[0].unitPrice).toBe(0);
    expect(priced.lines[0].lineDiscountAmount).toBe(10);
    expect(priced.totalAmount).toBe(0);
  });

  it("applies a whole-sale percent discount and allocates it so line discounts sum exactly", () => {
    const priced = priceRetailCart(
      [
        line({ variantId: 1, quantity: 1, listUnitPrice: 3.33 }),
        line({ variantId: 2, quantity: 1, listUnitPrice: 3.33 }),
        line({ variantId: 3, quantity: 1, listUnitPrice: 3.34 }),
      ],
      { type: "percent", value: 10 },
      noTax
    );
    const lineDiscountSum = roundRetailMoney(priced.lines.reduce((sum, entry) => sum + entry.lineDiscountAmount, 0));
    expect(lineDiscountSum).toBe(priced.discountTotal);
    expect(priced.discountTotal).toBe(1);
    expect(roundRetailMoney(priced.subtotal + priced.taxAmount)).toBe(priced.totalAmount);
    expect(roundRetailMoney(priced.listSubtotal - priced.discountTotal)).toBe(priced.subtotal);
  });

  it("allocates a fixed whole-sale discount down to the cent", () => {
    const priced = priceRetailCart(
      [
        line({ variantId: 1, quantity: 1, listUnitPrice: 1 }),
        line({ variantId: 2, quantity: 1, listUnitPrice: 1 }),
        line({ variantId: 3, quantity: 1, listUnitPrice: 1 }),
      ],
      { type: "fixed", value: 1 },
      noTax
    );
    expect(priced.orderDiscountAmount).toBe(1);
    const shares = priced.lines.map((entry) => entry.lineDiscountAmount).sort();
    expect(shares).toEqual([0.33, 0.33, 0.34]);
    expect(priced.totalAmount).toBe(2);
  });

  it("clamps a whole-sale discount to the cart value", () => {
    const priced = priceRetailCart([line({ listUnitPrice: 4 })], { type: "fixed", value: 10 }, noTax);
    expect(priced.discountTotal).toBe(4);
    expect(priced.totalAmount).toBe(0);
  });

  it("stacks a promotion, then the manual line discount, then the whole-sale discount", () => {
    const priced = priceRetailCart(
      [
        line({
          quantity: 2,
          listUnitPrice: 100,
          promotion: { id: 7, discountType: "percent", value: 10 },
          discountType: "percent",
          discountValue: 10,
        }),
      ],
      { type: "percent", value: 10 },
      noTax
    );
    // 100 → promotion 90 → line 10% → 81 → sale 10% → 72.9
    expect(priced.lines[0].unitPrice).toBe(72.9);
    expect(priced.lines[0].promotionId).toBe(7);
    expect(priced.lines[0].promotionAmount).toBe(20);
    expect(priced.lines[0].lineDiscountType).toBe("percent");
    expect(priced.lines[0].lineDiscountAmount).toBe(54.2);
    expect(priced.totalAmount).toBe(145.8);
  });

  it("records a price override separately from the original price", () => {
    const priced = priceRetailCart([line({ quantity: 2, listUnitPrice: 25, priceOverride: 19.99 })], noOrder, noTax);
    expect(priced.lines[0].originalUnitPrice).toBe(25);
    expect(priced.lines[0].unitPrice).toBe(19.99);
    expect(priced.lines[0].priceOverride).toBe(true);
    expect(priced.lines[0].lineDiscountType).toBe("override");
    expect(priced.lines[0].lineDiscountAmount).toBe(10.02);
    expect(priced.totalAmount).toBe(39.98);
  });

  it("rejects unsafe input instead of persisting nonsense", () => {
    expect(() => priceRetailCart([line({ quantity: 0 })], noOrder, noTax)).toThrow(/Quantity/);
    expect(() => priceRetailCart([line({ discountType: "percent", discountValue: 120 })], noOrder, noTax)).toThrow(
      /exceed 100/
    );
    expect(() =>
      priceRetailCart([line({ priceOverride: 5, discountType: "percent", discountValue: 10 })], noOrder, noTax)
    ).toThrow(/cannot be combined/);
    expect(() => priceRetailCart([line({ listUnitPrice: -1 })], noOrder, noTax)).toThrow(/negative/);
    expect(() => priceRetailCart([], noOrder, noTax)).toThrow(/At least one line/);
  });
});

describe("retail pricing — tax", () => {
  it("adds exclusive tax on top of the discounted net", () => {
    const priced = priceRetailCart(
      [line({ quantity: 2, listUnitPrice: 50, discountType: "percent", discountValue: 10 })],
      noOrder,
      vat
    );
    expect(priced.subtotal).toBe(90);
    expect(priced.discountTotal).toBe(10);
    expect(priced.taxAmount).toBe(16.2);
    expect(priced.totalAmount).toBe(106.2);
    expect(priced.lines[0].unitPrice).toBe(45);
    expect(priced.lines[0].grossUnitPrice).toBe(53.1);
    expect(roundRetailMoney(priced.subtotal + priced.taxAmount)).toBe(priced.totalAmount);
    expect(roundRetailMoney(priced.listSubtotal - priced.discountTotal)).toBe(priced.subtotal);
  });

  it("carves inclusive tax out of the discounted price the customer pays", () => {
    const priced = priceRetailCart([line({ quantity: 1, listUnitPrice: 118 })], noOrder, vatInclusive);
    expect(priced.totalAmount).toBe(118);
    expect(priced.subtotal).toBe(100);
    expect(priced.taxAmount).toBe(18);
    expect(priced.lines[0].grossUnitPrice).toBe(118);
    expect(priced.lines[0].unitPrice).toBe(100);
    expect(priced.lines[0].taxAmount).toBe(18);
    expect(roundRetailMoney(priced.subtotal + priced.taxAmount)).toBe(priced.totalAmount);
  });

  it("treats an inclusive discount as a reduction of the tax-inclusive price", () => {
    const priced = priceRetailCart(
      [line({ quantity: 1, listUnitPrice: 118, discountType: "percent", discountValue: 50 })],
      noOrder,
      vatInclusive
    );
    expect(priced.totalAmount).toBe(59);
    expect(priced.subtotal).toBe(50);
    expect(priced.taxAmount).toBe(9);
    expect(priced.discountTotal).toBe(50);
    expect(roundRetailMoney(priced.listSubtotal - priced.discountTotal)).toBe(priced.subtotal);
  });

  it("keeps tax off when the company has not enabled it", () => {
    const priced = priceRetailCart([line({ listUnitPrice: 118 })], noOrder, {
      enabled: false,
      rate: 0.18,
      inclusive: true,
    });
    expect(priced.taxAmount).toBe(0);
    expect(priced.totalAmount).toBe(118);
  });
});

describe("retail pricing — approval helpers", () => {
  it("reports the effective manual discount without counting promotions", () => {
    const priced = priceRetailCart(
      [
        line({
          quantity: 1,
          listUnitPrice: 100,
          promotion: { id: 1, discountType: "percent", value: 20 },
          discountType: "percent",
          discountValue: 10,
        }),
        line({ variantId: 2, quantity: 1, listUnitPrice: 100 }),
      ],
      noOrder,
      noTax
    );
    // 20 promotion + 8 manual discount over 200 list value = 4%
    expect(roundRetailMoney(effectiveManualDiscountPercent(priced))).toBe(4);
    expect(hasManualAdjustment(priced, noOrder)).toEqual({ hasLine: true, hasOrder: false, any: true });
  });

  it("detects order discounts and overrides", () => {
    const overridden = priceRetailCart([line({ priceOverride: 5 })], noOrder, noTax);
    expect(hasManualAdjustment(overridden, noOrder).any).toBe(true);
    const promoOnly = priceRetailCart(
      [line({ promotion: { id: 2, discountType: "percent", value: 5 } })],
      noOrder,
      noTax
    );
    expect(hasManualAdjustment(promoOnly, noOrder).any).toBe(false);
    expect(hasManualAdjustment(promoOnly, { type: "fixed", value: 1 }).hasOrder).toBe(true);
  });
});
