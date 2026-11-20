/**
 * server/chat/erpContextStep2.ts: sales summaries, per-item and per-group
 * profitability, pricing health and low-stock alerts built from step 1's
 * rows plus this company's sales lines. Runs against a company that lives
 * only inside one rolled-back transaction.
 */
import { describe, expect, it } from "vitest";

import { erpContextStep2 } from "../server/chat/erpContextStep2";
import type { erpContextStep } from "../server/chat/erpContextStep";
import { withRolledBackPool } from "./helpers/routedPoolClient";

type Step1 = Awaited<ReturnType<typeof erpContextStep>>;

const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;

function step1(overrides: Partial<Step1>): Step1 {
  return {
    todayStr: today,
    monthStartStr: monthStart,
    todaysSalesRaw: [],
    thisMonthSalesRaw: [],
    itemProfitabilityRaw: [],
    stockItems: [],
    stockGroups: [],
    inventory: [],
    ...overrides,
  } as unknown as Step1;
}

describe("erpContextStep2", () => {
  it("returns zeroed summaries and empty reports for a company with no data", async () => {
    await withRolledBackPool(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO companies (code, name) VALUES ('ECS2E' || floor(random()*1e6)::text, 'ctx empty') RETURNING id`
      );
      const result = await erpContextStep2({ erc1: step1({}), companyId: rows[0].id });
      expect(result.todaysSales).toMatchObject({ revenue: 0, transactionCount: 0, margin: "0" });
      expect(result.thisMonthSales).toMatchObject({ revenue: 0, margin: "0" });
      expect(result.itemProfitabilityReport).toEqual([]);
      expect(result.salesByGroup).toEqual([]);
      expect(result.pricingHealthReport).toEqual([]);
      expect(result.lowStockAlerts).toEqual([]);
      expect(result.supplierIds).toEqual([]);
    });
  });

  it("classifies items, groups, prices and stock levels from real sales lines", async () => {
    await withRolledBackPool(async (client) => {
      const one = async (text: string, params: unknown[] = []) => (await client.query(text, params)).rows[0].id;
      const companyId = await one(
        `INSERT INTO companies (code, name) VALUES ('ECS2F' || floor(random()*1e6)::text, 'ctx full') RETURNING id`
      );
      const groupId = await one(
        `INSERT INTO stock_groups (company_id, code, name) VALUES ($1, 'G1', 'Shirts') RETURNING id`,
        [companyId]
      );
      const ghostGroupId = await one(
        `INSERT INTO stock_groups (company_id, code, name) VALUES ($1, 'G2', 'Ghost') RETURNING id`,
        [companyId]
      );
      const winner = await one(
        `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id) VALUES ($1, 'W', 'Winner', 'pcs', $2) RETURNING id`,
        [companyId, groupId]
      );
      const loser = await one(
        `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id) VALUES ($1, 'L', 'Loser', 'pcs', $2) RETURNING id`,
        [companyId, ghostGroupId]
      );
      const loose = await one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, 'N', 'Loose', 'pcs') RETURNING id`,
        [companyId]
      );
      const addSale = async (date: string, number: string, item: number, sales: string, cost: string) => {
        const voucherId = await one(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
           VALUES ($1, $2, 'Sales', $3, $4) RETURNING id`,
          [companyId, number, date, sales]
        );
        await client.query(
          `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
           VALUES ($1, $2, 2, $3, $4, $3, $4, $3::numeric - $4::numeric)`,
          [voucherId, item, sales, cost]
        );
      };
      await addSale(today, "S-T1", winner, "100", "40");
      await addSale(today, "S-T2", loose, "30", "10");
      await addSale("2000-01-15", "S-OLD", loser, "50", "80");

      // The ghost group is in the DB but not in step 1's group list, so its
      // name falls back to "Unknown Group"; the loose item is "Uncategorized".
      const erc1 = step1({
        todaysSalesRaw: [{ revenue: "130", cost: "50", profit: "80", transactionCount: 2, unitsSold: "4" }],
        thisMonthSalesRaw: [{ revenue: "200", cost: "150", profit: "50", transactionCount: 3, unitsSold: "6" }],
        itemProfitabilityRaw: [
          {
            stockItemId: winner,
            totalQty: "2",
            totalRevenue: "100",
            totalCost: "40",
            totalProfit: "60",
            avgConfiguredPrice: "50",
            avgCostPrice: "20",
          },
          {
            stockItemId: loser,
            totalQty: "0",
            totalRevenue: "0",
            totalCost: "30",
            totalProfit: "-30",
            avgConfiguredPrice: "10",
            avgCostPrice: "15",
          },
          {
            stockItemId: 999999999,
            totalQty: "1",
            totalRevenue: "5",
            totalCost: "5",
            totalProfit: "0",
            avgConfiguredPrice: "5",
            avgCostPrice: "5",
          },
        ],
        stockItems: [
          { id: winner, code: "W", name: "Winner", stockGroupId: groupId, sellingPrice: "50", reorderLevel: "5" },
          { id: loser, code: "L", name: "Loser", stockGroupId: ghostGroupId, sellingPrice: "10", reorderLevel: "3" },
          { id: loose, code: "", name: "Loose", stockGroupId: null, sellingPrice: "8", reorderLevel: "0" },
        ],
        stockGroups: [{ id: groupId, code: "G1", name: "Shirts" }],
        inventory: [
          { stockItemId: winner, locationId: 1, quantity: "0", averageRate: "20", totalValue: "0" },
          { stockItemId: loser, locationId: 1, quantity: "2", averageRate: "15", totalValue: "30" },
          { stockItemId: loose, locationId: 1, quantity: "4", averageRate: "8", totalValue: "32" },
        ],
      } as unknown as Partial<Step1>);

      const result = await erpContextStep2({ erc1, companyId });

      expect(result.todaysSales).toMatchObject({ revenue: 130, profit: 80, margin: "61.5", transactionCount: 2 });
      expect(result.thisMonthSales).toMatchObject({ revenue: 200, margin: "25.0" });

      const [first, , last] = result.itemProfitabilityReport;
      expect(first).toMatchObject({
        itemName: "Loser",
        isLosing: true,
        lossAmount: "30.00",
        profitMargin: "0%",
        profitPerUnit: "0",
      });
      expect(last).toMatchObject({
        itemName: "Winner",
        isLosing: false,
        profitMargin: "60.0%",
        profitPerUnit: "30.00",
      });
      expect(result.itemProfitabilityReport[1]).toMatchObject({ itemName: "Unknown", itemCode: "" });

      expect(result.salesByGroup.map((g) => g.groupName)).toEqual(["Unknown Group", "Uncategorized", "Shirts"]);
      expect(result.salesByGroup[0]).toMatchObject({ isLosing: true, totalProfit: "-30.00" });
      expect(result.salesByGroupToday.map((g) => g.groupName)).toEqual(["Shirts", "Uncategorized"]);
      expect(result.salesByGroupThisMonth.map((g) => g.groupName)).toEqual(["Shirts", "Uncategorized"]);

      expect(result.pricingHealthReport.map((p) => [p.itemName, p.status, p.potentialLoss])).toEqual([
        ["Loser", "LOSING", "10.00"],
        ["Loose", "BREAK_EVEN", "0"],
        ["Winner", "PROFITABLE", "0"],
      ]);
      expect(result.lowStockAlerts).toEqual([
        { itemId: winner, itemCode: "W", itemName: "Winner", currentQty: 0, reorderLevel: 5, status: "OUT_OF_STOCK" },
        { itemId: loser, itemCode: "L", itemName: "Loser", currentQty: 2, reorderLevel: 3, status: "LOW_STOCK" },
      ]);
      expect(result.inventoryMap.get(loose)?.quantity).toBe("4");
    });
  });
});
