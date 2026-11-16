import { describe, expect, it } from "vitest";

describe("god-files Wave 6 import compatibility", () => {
  it("preserves the original StockTransferForm named export path", async () => {
    const stockTransferFormModule = await import("@/pages/vouchers/StockTransferForm");

    expect(stockTransferFormModule.StockTransferForm).toBeTypeOf("function");
  });

  it("preserves the original StockAdjustmentForm named export path", async () => {
    const stockAdjustmentFormModule = await import("@/pages/vouchers/StockAdjustmentForm");

    expect(stockAdjustmentFormModule.StockAdjustmentForm).toBeTypeOf("function");
  });

  it("preserves the original StockTransferOrder default export path", async () => {
    const stockTransferOrderModule = await import("@/pages/StockTransferOrder");

    expect(stockTransferOrderModule.default).toBeTypeOf("function");
  });

  it("preserves the original JournalForm named export path", async () => {
    const journalFormModule = await import("@/pages/vouchers/JournalForm");

    expect(journalFormModule.JournalForm).toBeTypeOf("function");
  });
});
