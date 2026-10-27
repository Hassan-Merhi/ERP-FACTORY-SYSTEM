import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { costRowFlags, type CostRow } from "../scripts/audit-erp-supplier-inventory-cost";

const item = (overrides: Partial<CostRow>): CostRow => ({
  id: 7453,
  code: "HMD12579",
  name: "HMD12579",
  opening_qty: "0",
  opening_value: "0",
  qty_received: "9",
  landed: "557.52",
  qty_sold: "0",
  sales: "0",
  cogs: "0",
  historical_profit: "0",
  missing_sale_relief: 0,
  qty_stock: "9",
  stock_value: "719.79",
  stock_at_rate: "719.82",
  adj_qty: "0",
  adj_value: "0",
  transfer_lines: 2,
  transfer_value_missing: 2,
  blocked_sales: 0,
  blocker: null,
  ...overrides,
});

describe("read-only supplier inventory cost repair workpaper", () => {
  it("flags missing original transfer value even for an unsold quantity-balanced stock code", () => {
    expect(costRowFlags(item({}))).toContain("TRANSFER_SOURCE_VALUE_UNPROVEN");
    expect(costRowFlags(item({}))).toContain("UNSOLD_TRANSFER_VALUE_DIFFERENCE");
    expect(costRowFlags(item({}))).toContain("COST_GAP_AFTER_RECORDED_ADJUSTMENTS");
  });

  it("explains unchanged-stock cost differences with signed adjustment values", () => {
    const removed = costRowFlags(
      item({
        code: "HMD12059",
        qty_received: "17",
        qty_stock: "16",
        stock_value: "1189.67",
        landed: "1262.66",
        adj_qty: "-1",
        adj_value: "-72.99",
        transfer_lines: 0,
        transfer_value_missing: 0,
      })
    );
    expect(removed).toContain("COST_EXPLAINED_BY_ADJUSTMENT");
    expect(removed).not.toContain("COST_GAP_AFTER_RECORDED_ADJUSTMENTS");
  });

  it("does not mistake a logged quantity correction for unproven quantity", () => {
    const flags = costRowFlags(item({ qty_received: "10", qty_stock: "9", adj_qty: "-1" }));
    expect(flags).toContain("QUANTITY_GAP");
    expect(flags).not.toContain("QUANTITY_UNRESOLVED_AFTER_ADJUSTMENTS");
  });

  it("requires external evidence for blocked historical sale costs", () => {
    const flags = costRowFlags(item({ qty_sold: "1", qty_stock: "8", blocked_sales: 14, missing_sale_relief: 14 }));
    expect(flags).toContain("HISTORICAL_COST_PROOF_BLOCKED");
    expect(flags).toContain("LEGACY_SALE_RELIEF_MISSING");
  });

  it("has no financial write or apply route", () => {
    const source = readFileSync(path.resolve(process.cwd(), "scripts/audit-erp-supplier-inventory-cost.ts"), "utf8");
    expect(source).toContain("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(source).toContain('if (process.argv.includes("--apply"))');
    expect(source).not.toMatch(/\b(?:UPDATE|DELETE FROM|INSERT INTO|TRUNCATE)\s+(?:inventory|sales_items|vouchers)\b/i);
  });

  it("reproduces the two valuation views without writing off the gap", () => {
    const purchaseCost = 372853.7;
    const cogs = 303022.84;
    const savedStock = 69909.72;
    const stockAtRate = 69909.75;
    expect(Number((purchaseCost - cogs - savedStock).toFixed(2))).toBe(-78.86);
    expect(Number((purchaseCost - cogs - stockAtRate).toFixed(2))).toBe(-78.89);
  });
});
