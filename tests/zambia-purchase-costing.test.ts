/**
 * Phase 8 regression tests for Claude's independent verification run.
 * Source committed only; NOT executed by this implementation session.
 */
import { describe, expect, it } from "vitest";
import {
  historicalUsdFromNativeZmw,
  valueZmwPurchaseAtLockedRate,
} from "../server/services/accounting/zambiaPurchaseCosting";
import { isUnsupportedNativeZmwPurchase } from "../server/services/accounting/zambiaPurchaseCurrencyGuard";
import { applyExplicitImportCurrency } from "../server/routes/import/poImportCurrency";

describe("Zambia Phase 8 purchase historical inventory basis", () => {
  it("stores native price and landed charges separately from locked USD base", () => {
    const valued = valueZmwPurchaseAtLockedRate({
      date: "2026-10-20",
      historicalRate: "25",
      lines: [{ quantity: "2", rate: "125.00" }],
      charges: { freight: "50.00", otherCharges: "0", discount: "0" },
    });
    expect(valued).toMatchObject({
      historicalExchangeRate: "25",
      historicalRateDate: "2026-10-20",
      nativeLineCount: 1,
      nativeItemsTotal: "250.00",
      itemsTotal: "10.00",
      nativeFreight: "50.00",
      freight: "2.00",
      nativeGrandTotal: "300.00",
      grandTotal: "12.00",
    });
    expect(valued.lines[0]).toMatchObject({
      quantity: "2.000",
      nativeRate: "125.00",
      rate: "5.00",
      nativeLineTotal: "250.00",
      lineTotal: "10.00",
    });
  });

  it("retains the purchase's stored FX on edits after an unrelated rate change", () => {
    const old = historicalUsdFromNativeZmw("250.00", "25");
    const current = historicalUsdFromNativeZmw("250.00", "28");
    expect(old).toBe("10.00");
    expect(current).not.toBe(old);
    const edited = valueZmwPurchaseAtLockedRate({
      date: "2026-10-20",
      historicalRate: "25",
      lines: [{ quantity: "1", rate: "250.00" }],
      charges: {},
    });
    expect(edited.itemsTotal).toBe(old);
  });

  it("allows independent line-cent rounding but keeps exact native total", () => {
    const value = valueZmwPurchaseAtLockedRate({
      date: "2026-10-20",
      historicalRate: "27",
      lines: [
        { quantity: "1", rate: "1.00" },
        { quantity: "1", rate: "1.00" },
      ],
      charges: {},
    });
    expect(value.nativeItemsTotal).toBe("2.00");
    expect(value.itemsTotal).toBe("0.08");
    expect(value.lines).toHaveLength(2);
  });

  it("rejects invalid rates, negative native charges, and fractional-unit quantities", () => {
    expect(() => historicalUsdFromNativeZmw("5", "0")).toThrow();
    expect(() => historicalUsdFromNativeZmw("-1", "25")).toThrow();
    expect(() =>
      valueZmwPurchaseAtLockedRate({
        date: "2026-10-20",
        historicalRate: "25",
        lines: [{ quantity: "1.0001", rate: "5" }],
        charges: {},
      })
    ).toThrow();
  });
});

describe("Zambia Phase 8 explicit purchase-import currency", () => {
  const zambia = { baseCurrency: "USD", displayCurrency: "ZMW" };
  const mali = { baseCurrency: "USD", displayCurrency: "CFA" };
  const line = (currency?: string) => ({
    poNumber: "PO-1",
    barcode: "B1",
    itemName: "Item",
    quantity: 1,
    rate: 250,
    lineTotal: 250,
    ...(currency ? { currency } : {}),
  });

  it("fails closed when a Kwacha-enabled company does not state the invoice currency", () => {
    const items = [line()];
    expect(applyExplicitImportCurrency(items, undefined, zambia)).toEqual([
      expect.stringContaining("Select the invoice currency"),
    ]);
    // Nothing was relabelled: an unlabelled line is NOT silently USD.
    expect(items[0].currency).toBeUndefined();
  });

  it("stamps the selected currency on every unlabelled line and keeps agreeing labels", () => {
    const items = [line(), line("zmw")];
    expect(applyExplicitImportCurrency(items, "ZMW", zambia)).toEqual([]);
    expect(items.map((item) => item.currency)).toEqual(["ZMW", "ZMW"]);
    expect(isUnsupportedNativeZmwPurchase(items[0].currency)).toBe(true);
  });

  it("refuses a sheet whose Currency column contradicts the selection", () => {
    const items = [line("USD")];
    expect(applyExplicitImportCurrency(items, "ZMW", zambia)).toEqual([
      expect.stringContaining("says USD but ZMW was selected"),
    ]);
    expect(items[0].currency).toBe("USD");
  });

  it("refuses ZMW for a company that is not configured USD/ZMW and unknown codes", () => {
    expect(applyExplicitImportCurrency([line()], "ZMW", mali)).toEqual([
      expect.stringContaining("configured USD base / ZMW display"),
    ]);
    expect(applyExplicitImportCurrency([line()], "EUR", zambia)).toEqual([
      expect.stringContaining("Unsupported import currency"),
    ]);
  });

  it("leaves Mali and other companies on the sheet-driven labels", () => {
    const items = [line(), line("USD")];
    expect(applyExplicitImportCurrency(items, undefined, mali)).toEqual([]);
    expect(applyExplicitImportCurrency(items, null, null)).toEqual([]);
    expect(items[0].currency).toBeUndefined();
    expect(items[1].currency).toBe("USD");
  });
});
