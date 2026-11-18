import { describe, expect, it } from "vitest";
import {
  buildDaybookSaleEditPayload,
  createDaybookDraftLines,
} from "../../client/src/pages/pos/posdaybook/editSalePayload";
import type { VoucherWithItems } from "../../client/src/pages/pos/posdaybook/types";

const original: VoucherWithItems = {
  id: 91,
  voucherType: "Sales",
  voucherNumber: "SV-91",
  voucherDate: "2026-11-17",
  description: "Original",
  locationId: 12,
  totalAmount: "188.68",
  currency: "ZMW",
  exchangeRate: "26.5",
  isCreditSale: false,
  createdAt: "2026-11-17T10:00:00Z",
  salesItems: [
    {
      id: 50,
      stockItemId: 17,
      stockItemName: "Shoe bale",
      quantity: "1",
      sellingPrice: "188.679245",
      costPrice: "50",
      totalSales: "188.68",
      totalCost: "50",
      profit: "138.68",
    },
  ],
};

describe("Zambia POS Daybook modal payload", () => {
  it("rehydrates the original Kwacha unit price from historical USD rate", () => {
    const lines = createDaybookDraftLines(original);
    expect(lines).toEqual([
      { id: 50, stockItemId: 17, stockItemName: "Shoe bale", quantity: "1", unitPrice: "5000.00" },
    ]);
    const payload = buildDaybookSaleEditPayload(original, lines, "Revised notes");
    expect(payload.items[0]).toMatchObject({
      id: 50, stockItemId: 17, sellingPrice: "188.679245", originalCurrencyRate: "5000.00",
    });
    expect(payload).toMatchObject({
      voucherDate: "2026-11-17", currency: "ZMW", locationId: 12, isCreditSale: false,
      description: "Revised notes",
    });
    expect(payload).not.toHaveProperty("paymentAccountId");
    expect(payload).not.toHaveProperty("paymentAccountType");
  });

  it("supports quantity, price, item-addition and note corrections without moving money accounts", () => {
    const lines = createDaybookDraftLines(original);
    lines[0].quantity = "2";
    lines[0].unitPrice = "100.05";
    lines.push({ stockItemId: 18, stockItemName: "New bale", quantity: "1", unitPrice: "20.00" });
    const payload = buildDaybookSaleEditPayload(original, lines, "Updated");
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toMatchObject({ originalCurrencyRate: "100.05", quantity: "2" });
    expect(payload.items[1]).not.toHaveProperty("id");
  });

  it("does not alter USD unit prices and does not invent a new payment account", () => {
    const usd = { ...original, currency: "USD", exchangeRate: null, isCreditSale: true };
    const payload = buildDaybookSaleEditPayload(usd, [{ ...createDaybookDraftLines(usd)[0], unitPrice: "25.75" }], "");
    expect(payload.items[0]).toMatchObject({ sellingPrice: "25.75" });
    expect(payload.items[0]).not.toHaveProperty("originalCurrencyRate");
    expect(payload.isCreditSale).toBe(true);
  });

  it("rejects empty sales, invalid quantities and sub-ngwee values", () => {
    expect(() => buildDaybookSaleEditPayload(original, [], "")).toThrow();
    expect(() => buildDaybookSaleEditPayload(original, [{ ...createDaybookDraftLines(original)[0], quantity: "0" }], "")).toThrow();
    expect(() => buildDaybookSaleEditPayload(original, [{ ...createDaybookDraftLines(original)[0], unitPrice: "0.001" }], "")).toThrow();
  });
});
