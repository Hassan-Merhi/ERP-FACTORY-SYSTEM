/**
 * Production value report, stage 2: bales are bucketed into products,
 * categories and wipers/garbage (by product or article code), workers are
 * tallied by id or name, missing catalog prices are counted for the active
 * valuation mode, and the period's mix batches give the blended rate and the
 * material still on the pressing table. Runs against a company that lives only
 * inside a rolled-back transaction.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { productionValueReportStep2 } from "../server/routes/factory/bale-exports/productionValueReportStep2";
import { withRolledBackPool } from "./helpers/routedPoolClient";

type Pvr1 = Parameters<typeof productionValueReportStep2>[0]["pvr1"];

const bale = (over: Record<string, unknown>) => ({
  articleCode: "A1",
  productName: "Shirts",
  categoryName: "Clothing",
  weightKg: "45",
  productionPrice: "20",
  sellingPrice: "30",
  workerFullName: null,
  baleWorkerName: null,
  finalizedBy: null,
  mixBatchId: null,
  catalogArticleCode: null,
  catalogProductName: null,
  productId: null,
  ...over,
});

function pvr1(companyId: number, valuationMode: string, baleRows: unknown[], mixBatchRows: unknown[]): Pvr1 {
  return {
    done: false,
    baleRows,
    valuationMode,
    isWiperOrGarbage: (name: string) => /wiper|garbage|rags/i.test(name),
    wgMap: new Map(),
    wgProductMap: new Map(),
    productMap: new Map(),
    categoryMap: new Map(),
    mixBatchRows,
    companyId,
    to: "2026-12-31",
    totalSellingValue: 0,
    totalProductionCostValue: 0,
  } as unknown as Pvr1;
}

async function company(client: PoolClient) {
  const tag = `PVR${Date.now().toString(36)}`.toUpperCase();
  const id = (
    await client.query<{ id: number }>(
      `INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`,
      [tag]
    )
  ).rows[0].id;
  const supplier = (
    await client.query<{ id: number }>(
      `INSERT INTO factory_suppliers (company_id, name, current_raw_material_cost_per_kg_usd) VALUES ($1, $2, 0.4) RETURNING id`,
      [id, `${tag} S`]
    )
  ).rows[0].id;
  const batch = (
    await client.query<{ id: number }>(
      `INSERT INTO factory_mix_batches (company_id, batch_code, status, total_weight_kg, used_kg, total_cost)
       VALUES ($1, $2, 'ACTIVE', 100, 60, 40) RETURNING id`,
      [id, `${tag}MB`]
    )
  ).rows[0].id;
  await client.query(
    `INSERT INTO factory_mix_batch_sources (mix_batch_id, supplier_id, weight_kg, cost_per_kg, total_cost) VALUES ($1, $2, 100, 0.4, 40)`,
    [batch, supplier]
  );
  return { id, supplier, batch };
}

describe("productionValueReportStep2", () => {
  it("buckets bales, tallies workers and values the period's batches at cost", async () => {
    await withRolledBackPool(async (client) => {
      const { id, supplier, batch } = await company(client);
      const input = pvr1(
        id,
        "cost",
        [
          bale({ mixBatchId: batch, finalizedBy: 7, workerFullName: " Ann " }),
          bale({ mixBatchId: batch, finalizedBy: 7, workerFullName: "Ann" }),
          bale({ baleWorkerName: "Bob", productionPrice: "0", sellingPrice: null }),
          bale({ articleCode: null, productName: null, categoryName: null, weightKg: "10" }),
          bale({ categoryName: "Wipers", productId: 3, catalogArticleCode: "W1", catalogProductName: "Wipe" }),
          bale({ categoryName: "Wipers", productId: 3 }),
          bale({ categoryName: "Garbage", articleCode: "G1", productName: "Junk" }),
          bale({ categoryName: "Rags" }),
        ],
        [
          { id: batch, status: "ACTIVE", totalWeightKg: "100", usedKg: "60", totalCost: "40" },
          { id: batch + 100000, status: "COMPLETED", totalWeightKg: "50", usedKg: "50", totalCost: "10" },
          { id: batch + 100001, status: null, totalWeightKg: "5", usedKg: "9", totalCost: null },
        ]
      );
      const out = await productionValueReportStep2({ pvr1: input });

      expect(out.productRows.map((r) => [r.articleCode, r.qty, r.totalValue, r.mixBatchIds])).toEqual([
        ["A1", 3, 40, [batch]],
        ["UNKNOWN", 1, 20, []],
      ]);
      expect(out.productRows[0].workers).toEqual([
        { id: 7, name: "Ann", qty: 2 },
        { id: null, name: "Bob", qty: 1 },
      ]);
      expect(out.productRows[1]).toMatchObject({ productName: "UNKNOWN", categoryName: "Uncategorized" });
      expect(out.categoryRows.map((r) => [r.categoryName, r.qty])).toEqual([
        ["Clothing", 3],
        ["Uncategorized", 1],
      ]);
      expect([out.missingSelectedPriceBales, out.missingCostPriceBales, out.missingSellingPriceBales]).toEqual([
        1, 1, 1,
      ]);
      expect(input.totalSellingValue).toBe(90);
      expect(input.totalProductionCostValue).toBe(60);
      expect(out.totalBales).toBe(4);

      expect(out.wgRows.map((r) => [r.categoryName, r.subType, r.qty])).toEqual([
        ["Wipers", "wiper", 2],
        ["Garbage", "garbage", 1],
        ["Rags", "other", 1],
      ]);
      expect(out.wgProductRows.map((r) => [r.articleCode, r.productName, r.qty])).toEqual([
        ["G1", "Junk", 1],
        ["A1", "Shirts", 1],
        ["W1", "Wipe", 2],
      ]);
      expect([out.totalWipersQty, out.totalGarbageQty, out.totalWgWeightKg]).toEqual([2, 2, 180]);

      expect(out.reportSupplierIds).toEqual([supplier]);
      expect(out.reportSourcesByBatch.get(batch)).toHaveLength(1);
      expect([out.totalMixWeightKg, out.totalMixCost, out.periodOnTableKg]).toEqual([155, 50, 40]);
      expect(out.blendedCostPerKg).toBeCloseTo(50 / 155, 8);
      expect(typeof out.balanceValue).toBe("number");
    });
  });

  it("values at selling price and handles a period without batches", async () => {
    await withRolledBackPool(async (client) => {
      const { id } = await company(client);
      const out = await productionValueReportStep2({
        pvr1: pvr1(id, "selling", [bale({}), bale({ sellingPrice: "0" })], []),
      });
      expect(out.totalProductionValue).toBe(30);
      expect(out.missingSelectedPriceBales).toBe(1);
      expect(out.mixSourceRows).toEqual([]);
      expect(out.blendedCostPerKg).toBe(0);
      expect(out.productRows[0].workers).toEqual([]);
    });
  });
});
