import { describe, expect, it, vi } from "vitest";
import { recalculateOrderTotalsForScannedArticle } from "../server/routes/factory/customer-orders/bale-scanning/incrementalTotals";

describe("single-bale scan incremental totals", () => {
  // The scanner already holds the order row FOR UPDATE, so the helper runs one
  // statement: rebuild the scanned article's line and re-derive the totals.
  it("uses a single statement and maps the recalculated line and totals", async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          subtotal_bales: "125.50",
          freight_amount: "10.00",
          other_charges_total: "4.50",
          grand_total: "140.00",
          total_qty_bales: 3,
          updated_at: "2026-08-07T10:00:00.000Z",
          line_id: 99,
          line_order_id: 42,
          line_article_code: "ART-1",
          line_bale_name: "Article One",
          line_qty: 3,
          line_weight_per_bale: "25.000",
          line_total_weight: "75.000",
          line_price_per_bale: "41.833333",
          line_total_price: "125.50",
          line_pricing_mode: "per_kg",
          line_price_per_kg: "1.673333",
        },
      ],
    });

    const result = await recalculateOrderTotalsForScannedArticle({ execute }, 42, "ART-1");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      line: {
        id: 99,
        orderId: 42,
        articleCode: "ART-1",
        baleName: "Article One",
        qty: 3,
        weightPerBale: "25.000",
        totalWeight: "75.000",
        pricePerBale: "41.833333",
        totalPrice: "125.50",
        pricingMode: "per_kg",
        pricePerKg: "1.673333",
      },
      totals: {
        subtotalBales: "125.50",
        freightAmount: "10.00",
        otherChargesTotal: "4.50",
        grandTotal: "140.00",
        totalQtyBales: 3,
        updatedAt: "2026-08-07T10:00:00.000Z",
      },
    });
  });

  it("normalizes an empty article code and returns a null line when no article row is inserted", async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          subtotal_bales: "0",
          freight_amount: "0",
          other_charges_total: "0",
          grand_total: "0",
          total_qty_bales: 0,
          updated_at: null,
          line_id: null,
        },
      ],
    });

    const result = await recalculateOrderTotalsForScannedArticle({ execute }, 7, "");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.line).toBeNull();
    expect(result.totals).toEqual({
      subtotalBales: "0",
      freightAmount: "0",
      otherChargesTotal: "0",
      grandTotal: "0",
      totalQtyBales: 0,
      updatedAt: null,
    });
  });
});
