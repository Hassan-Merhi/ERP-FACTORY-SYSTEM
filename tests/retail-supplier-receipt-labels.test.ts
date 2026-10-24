import { describe, expect, it } from "vitest";
import {
  buildRetailSupplierReceiptLabelItems,
  planRetailReceiptLabelJob,
  RETAIL_RECEIPT_LABEL_JOB_LIMIT,
} from "../client/src/pages/retail/retailSupplierReceiptLabels";

const receipt = [
  { rowNumber: 2, variantId: 101, barcode: "2000000000015", quantity: 650 },
  { rowNumber: 3, variantId: 102, barcode: "2000000000022", quantity: 2 },
];
const excel = [
  { rowNumber: 2, name: "Runner", brand: "Acme", color: "Black", size: "42" },
  { rowNumber: 3, name: "Tee", brand: "Acme", color: "White", size: "M" },
];

describe("supplier receipt barcode labels", () => {
  it("uses the exact quantities, barcode and variant IDs from the posted receipt", () => {
    const target = buildRetailSupplierReceiptLabelItems(receipt, excel);
    expect(target).toMatchObject([
      { variantId: 101, barcode: "2000000000015", receivedQuantity: 650 },
      { variantId: 102, barcode: "2000000000022", receivedQuantity: 2 },
    ]);
    expect(target[0].title).toContain("Runner");
  });

  it("never substitutes lifetime inventory stock for received quantities", () => {
    const targets = buildRetailSupplierReceiptLabelItems(receipt, excel);
    expect(targets.every(item => item.stockQuantity === undefined)).toBe(true);
  });

  it("prints a max-500 batch and does not silently drop the remaining received units", () => {
    const targets = buildRetailSupplierReceiptLabelItems(receipt, excel);
    const selected = new Set([101, 102]);
    const first = planRetailReceiptLabelJob(targets, { 101: 650, 102: 2 }, selected);
    expect(first).toEqual([{ variantId: 101, copies: 500 }]);
    expect(first.reduce((sum, line) => sum + line.copies, 0)).toBe(RETAIL_RECEIPT_LABEL_JOB_LIMIT);

    const second = planRetailReceiptLabelJob(targets, { 101: 150, 102: 2 }, selected);
    expect(second).toEqual([{ variantId: 101, copies: 150 }, { variantId: 102, copies: 2 }]);
  });

  it("supports selected variants without consuming labels from unselected variants", () => {
    const targets = buildRetailSupplierReceiptLabelItems(receipt, excel);
    const job = planRetailReceiptLabelJob(targets, { 101: 650, 102: 2 }, new Set([102]));
    expect(job).toEqual([{ variantId: 102, copies: 2 }]);
  });

  it("aggregates duplicate receipt rows belonging to the same variant", () => {
    const targets = buildRetailSupplierReceiptLabelItems([
      receipt[0],
      { rowNumber: 4, variantId: 101, barcode: "2000000000015", quantity: 5 },
    ], excel);
    expect(targets).toHaveLength(1);
    expect(targets[0].receivedQuantity).toBe(655);
  });

  it("rejects inconsistent saved receipt data before opening the print flow", () => {
    expect(() => buildRetailSupplierReceiptLabelItems([
      receipt[0], { rowNumber: 4, variantId: 101, barcode: "CHANGED", quantity: 2 },
    ], excel)).toThrow(/barcode/i);
    expect(() => buildRetailSupplierReceiptLabelItems([
      { ...receipt[0], quantity: 0 },
    ], excel)).toThrow();
  });

  it("handles no selected items and refuses oversized per-job limits", () => {
    const targets = buildRetailSupplierReceiptLabelItems(receipt, excel);
    expect(planRetailReceiptLabelJob(targets, { 101: 650, 102: 2 }, new Set())).toEqual([]);
    expect(() => planRetailReceiptLabelJob(targets, { 101: 650 }, new Set([101]), 501)).toThrow();
  });
});
