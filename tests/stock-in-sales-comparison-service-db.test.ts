/**
 * Location-vs-location stock in/sales comparison. The per-period figures come
 * from the stock-in/sales report (mocked here); the per-item figures are
 * aggregated by this service's own SQL, which runs against a disposable
 * company in a rolled-back transaction.
 */
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const report = vi.hoisted(() => ({ byLocation: new Map<number, unknown>(), calls: [] as unknown[] }));

vi.mock("../server/services/reports/stockInSalesReportService", () => ({
  getStockInSalesReport: async (filters: { locationIds: number[] }) => {
    report.calls.push(filters);
    return report.byLocation.get(filters.locationIds[0]) ?? { rows: [], summary: metrics({}) };
  },
}));

import { getStockInSalesComparison } from "../server/services/reports/stockInSalesComparisonService";

function metrics(over: Record<string, number>) {
  return {
    openingStockQty: 0,
    openingStockValue: 0,
    stockInQty: 0,
    stockInValue: 0,
    stockInAvgRate: 0,
    stockAdjustmentQty: 0,
    stockAdjustmentValue: 0,
    totalAvailableQty: 0,
    stockOutQty: 0,
    stockOutValue: 0,
    closingStockQty: 0,
    closingStockValue: 0,
    totalSales: 0,
    costOfSales: 0,
    costProfit: 0,
    avgProfitPerBale: 0,
    ...over,
  };
}

let seq = 0;

async function id(client: PoolClient, text: string, values: unknown[]): Promise<number> {
  return Number((await client.query<{ id: number }>(text, values)).rows[0].id);
}

async function seed(client: PoolClient) {
  const tag = `SISC${process.pid}${++seq}`;
  const companyId = await id(client, "INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [tag, tag]);
  const location = (name: string) =>
    id(client, "INSERT INTO locations(company_id,code,name) VALUES($1,$2,$3) RETURNING id", [
      companyId,
      `${tag}-${++seq}`,
      name,
    ]);
  const group = (name: string) =>
    id(client, "INSERT INTO stock_groups(company_id,code,name) VALUES($1,$2,$3) RETURNING id", [
      companyId,
      `${tag}-${++seq}`,
      name,
    ]);
  const item = (code: string, name: string, groupId: number | null) =>
    id(
      client,
      "INSERT INTO stock_items(company_id,code,name,uom,stock_group_id) VALUES($1,$2,$3,'Bale',$4) RETURNING id",
      [companyId, code, name, groupId]
    );
  const supplierId = await id(
    client,
    "INSERT INTO suppliers(company_id,code,legal_name,email) VALUES($1,$2,'Vendor','v@x.test') RETURNING id",
    [companyId, `${tag}-S`]
  );

  const kolwezi = await location("Kolwezi");
  const hadi = await location("Hadi");
  const bales = await group("Bales");
  const shoes = await group("Shoes");
  const rice = await item(`${tag}-RICE`, "Rice bale", bales);
  const shoe = await item(`${tag}-SHOE`, "Shoe box", shoes);
  const loose = await item(`${tag}-LOOSE`, "Loose", null);
  const apron = await item(`${tag}-APRON`, "Apron", bales);

  async function offload(
    locationId: number,
    lines: Array<[number, number, number]>,
    o: { containerNumber?: string; offloadDate?: string | null; offloadedAt?: string; optional?: boolean } = {}
  ) {
    const containerId = await id(
      client,
      `INSERT INTO containers(company_id,container_number,supplier_id,import_date,offload_date,status)
       VALUES($1,$2,$3,'2026-01-01',$4,'OFFLOADED') RETURNING id`,
      [
        companyId,
        o.containerNumber ?? `${tag}-C${++seq}`,
        supplierId,
        o.offloadDate === undefined ? "2026-03-05" : o.offloadDate,
      ]
    );
    const offloadId = await id(
      client,
      `INSERT INTO container_offloads(container_id,location_id,total_bales,additional_cost_per_bale,offloaded_at,optional)
       VALUES($1,$2,0,0,$3,$4) RETURNING id`,
      [containerId, locationId, o.offloadedAt ?? "2026-03-05T10:00:00Z", o.optional ?? false]
    );
    for (const [stockItemId, quantity, totalValue] of lines) {
      await client.query(
        "INSERT INTO container_offload_items(offload_id,stock_item_id,quantity,rate,total_value) VALUES($1,$2,$3,0,$4)",
        [offloadId, stockItemId, quantity, totalValue]
      );
    }
  }

  async function voucher(
    type: string,
    locationId: number,
    date: string,
    v: { optional?: boolean; deleted?: boolean; number?: string } = {}
  ) {
    return id(
      client,
      `INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,total_amount,currency,optional,deleted_at,location_id,location_name)
       VALUES($1,$2,$3,$4,0,'USD',$5,$6,$7,'Shop') RETURNING id`,
      [
        companyId,
        v.number ?? `${tag}-V${++seq}`,
        type,
        date,
        v.optional ?? false,
        v.deleted ? new Date() : null,
        locationId,
      ]
    );
  }

  async function adjustment(
    locationId: number,
    type: string,
    lines: Array<[number, number, number]>,
    v: { optional?: boolean } = {}
  ) {
    const voucherId = await voucher("Stock Adjustment", locationId, "2026-03-10", v);
    const adjustmentId = await id(
      client,
      "INSERT INTO stock_adjustment_vouchers(voucher_id,location_id,adjustment_type) VALUES($1,$2,$3) RETURNING id",
      [voucherId, locationId, type]
    );
    for (const [stockItemId, quantity, totalAmount] of lines) {
      await client.query(
        "INSERT INTO stock_adjustment_items(adjustment_id,stock_item_id,quantity,rate,total_amount) VALUES($1,$2,$3,0,$4)",
        [adjustmentId, stockItemId, quantity, totalAmount]
      );
    }
  }

  async function sale(
    locationId: number,
    lines: Array<[number, number, number, number, number]>,
    v: { type?: string; deleted?: boolean; date?: string; number?: string } = {}
  ) {
    const voucherId = await voucher(v.type ?? "Sales", locationId, v.date ?? "2026-03-12", v);
    for (const [stockItemId, quantity, totalSales, totalCost, profit] of lines) {
      await client.query(
        `INSERT INTO sales_items(voucher_id,stock_item_id,quantity,selling_price,cost_price,total_sales,total_cost,profit)
         VALUES($1,$2,$3,0,0,$4,$5,$6)`,
        [voucherId, stockItemId, quantity, totalSales, totalCost, profit]
      );
    }
  }

  async function note(
    type: "Credit Note" | "Debit Note",
    locationId: number,
    stockItemId: number,
    quantity: number,
    totalValue: number,
    inventoryCost: number
  ) {
    const voucherId = await voucher(type, locationId, "2026-03-15");
    await client.query(
      `INSERT INTO credit_note_items(voucher_id,stock_item_id,location_id,quantity,rate,total_value,inventory_cost)
       VALUES($1,$2,$3,$4,0,$5,$6)`,
      [voucherId, stockItemId, locationId, quantity, totalValue, inventoryCost]
    );
  }

  // Kolwezi (side A)
  await offload(
    kolwezi,
    [
      [rice, 10, 1000],
      [loose, 2, 50],
    ],
    { containerNumber: `${tag}-MSKU77` }
  );
  await offload(kolwezi, [[rice, 5, 500]], { offloadDate: null, offloadedAt: "2026-03-06T08:00:00Z" });
  await offload(kolwezi, [[rice, 99, 9900]], { optional: true });
  await offload(kolwezi, [[rice, 99, 9900]], { offloadDate: "2026-05-01" });
  await adjustment(kolwezi, "Production", [[rice, 4, 400]]);
  await adjustment(kolwezi, "Mixed", [
    [rice, -3, -300],
    [shoe, 2, 100],
  ]);
  await adjustment(kolwezi, "Consumption", [[shoe, 1, 50]]);
  await adjustment(kolwezi, "Production", [[rice, 99, 9900]], { optional: true });
  await sale(kolwezi, [[rice, 6, 900, 600, 300]], { number: `${tag}-INV-42` });
  await sale(kolwezi, [[rice, 99, 9900, 1, 1]], { deleted: true });
  await sale(kolwezi, [[rice, 99, 9900, 1, 1]], { type: "Purchase" });
  await sale(kolwezi, [[rice, 99, 9900, 1, 1]], { date: "2026-02-28" });
  await note("Credit Note", kolwezi, rice, 1, 150, 100);
  await note("Debit Note", kolwezi, shoe, 2, 40, 15);

  // Hadi (side B, Bales group only)
  await offload(hadi, [
    [rice, 3, 270],
    [apron, 1, 10],
  ]);
  await sale(hadi, [
    [rice, 2, 400, 200, 200],
    [shoe, 5, 500, 100, 400],
  ]);

  return { companyId, kolwezi, hadi, bales, shoes, rice, shoe, loose, apron, tag };
}

describe("getStockInSalesComparison", () => {
  it("compares per-item stock in, stock out and sales between two locations", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      report.calls = [];
      report.byLocation = new Map([
        [
          w.kolwezi,
          {
            rows: [
              {
                periodKey: "2026-03",
                periodStart: "2026-03-01",
                periodEnd: "2026-03-31",
                ...metrics({ totalSales: 750 }),
              },
              {
                periodKey: "2026-01",
                periodStart: "2026-01-01",
                periodEnd: "2026-01-31",
                ...metrics({ totalSales: 5 }),
              },
            ],
            summary: metrics({ totalSales: 755, stockInQty: 21 }),
          },
        ],
        [
          w.hadi,
          {
            rows: [
              {
                periodKey: "2026-02",
                periodStart: "2026-02-02",
                periodEnd: "2026-02-27",
                ...metrics({ totalSales: 9 }),
              },
              {
                periodKey: "2026-03",
                periodStart: "2026-03-09",
                periodEnd: "2026-03-30",
                ...metrics({ totalSales: 400 }),
              },
            ],
            summary: metrics({ totalSales: 409, stockInQty: 4 }),
          },
        ],
      ]);

      const result = await getStockInSalesComparison({
        companyId: w.companyId,
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        grouping: "monthly" as never,
        sideA: { locationId: w.kolwezi, stockGroupIds: [] },
        sideB: { locationId: w.hadi, stockGroupIds: [w.bales] },
      });

      expect(report.calls).toEqual([
        expect.objectContaining({
          companyId: w.companyId,
          locationIds: [w.kolwezi],
          stockGroupIds: [],
          profitFilter: "all",
        }),
        expect.objectContaining({
          locationIds: [w.hadi],
          stockGroupIds: [w.bales],
          startDate: "2026-03-01",
          endDate: "2026-03-31",
        }),
      ]);
      expect(result.filters).toEqual({
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        grouping: "monthly",
        search: undefined,
        sideA: { locationId: w.kolwezi, stockGroupIds: [] },
        sideB: { locationId: w.hadi, stockGroupIds: [w.bales] },
      });
      expect(result.summary.difference).toEqual(metrics({ totalSales: 346, stockInQty: 17 }));

      // Newest period first; bounds come from side A when it has the period.
      expect(
        result.rows.map((row) => [row.periodKey, row.periodStart, row.periodEnd, row.difference.totalSales])
      ).toEqual([
        ["2026-03", "2026-03-01", "2026-03-31", 350],
        ["2026-02", "2026-02-02", "2026-02-27", -9],
        ["2026-01", "2026-01-01", "2026-01-31", 5],
      ]);
      expect(result.rows[1].sideA).toEqual(metrics({}));
      expect(result.rowCount).toBe(3);

      expect(result.itemRows.map((row) => row.stockItemName)).toEqual(["Rice bale", "Shoe box", "Apron", "Loose"]);
      expect(result.itemRowCount).toBe(4);

      const [riceRow, shoeRow, apronRow, looseRow] = result.itemRows;
      expect(riceRow).toMatchObject({
        stockItemId: w.rice,
        stockItemCode: `${w.tag}-RICE`,
        stockGroupId: w.bales,
        stockGroupName: "Bales",
      });
      // In: 10 + 5 offloaded, 4 produced. Out: 3 adjusted, 6 sold, −1 returned.
      expect(riceRow.sideA).toEqual(
        metrics({
          stockInQty: 19,
          stockInValue: 1900,
          stockInAvgRate: 100,
          totalAvailableQty: 19,
          stockOutQty: 8,
          stockOutValue: 800,
          closingStockQty: 11,
          closingStockValue: 1100,
          totalSales: 750,
          costOfSales: 500,
          costProfit: 250,
          avgProfitPerBale: 31.25,
        })
      );
      expect(riceRow.sideB).toEqual(
        metrics({
          stockInQty: 3,
          stockInValue: 270,
          stockInAvgRate: 90,
          totalAvailableQty: 3,
          stockOutQty: 2,
          stockOutValue: 200,
          closingStockQty: 1,
          closingStockValue: 70,
          totalSales: 400,
          costOfSales: 200,
          costProfit: 200,
          avgProfitPerBale: 100,
        })
      );
      expect(riceRow.difference).toMatchObject({ stockInQty: 16, totalSales: 350, avgProfitPerBale: -68.75 });

      // Shoes are outside side B's group filter.
      expect(shoeRow.sideB).toEqual(metrics({}));
      expect(shoeRow.sideA).toEqual(
        metrics({
          stockInQty: 2,
          stockInValue: 100,
          stockInAvgRate: 50,
          totalAvailableQty: 2,
          stockOutQty: 3,
          stockOutValue: 80,
          closingStockQty: -1,
          closingStockValue: 20,
          totalSales: 40,
          costOfSales: 30,
          costProfit: 10,
          avgProfitPerBale: 3.333333,
        })
      );
      expect(shoeRow.difference).toEqual(shoeRow.sideA);

      expect(apronRow).toMatchObject({ stockGroupName: "Bales", sideA: metrics({}) });
      expect(apronRow.sideB).toMatchObject({ stockInQty: 1, stockInValue: 10, avgProfitPerBale: 0 });
      expect(looseRow).toMatchObject({ stockGroupId: null, stockGroupName: "Unassigned" });
      expect(looseRow.sideA).toMatchObject({ stockInQty: 2, stockInAvgRate: 25, stockOutQty: 0, avgProfitPerBale: 0 });
    });
  });

  it("narrows every source by the search text", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      report.byLocation = new Map();
      const run = (search: string) =>
        getStockInSalesComparison({
          companyId: w.companyId,
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          grouping: "monthly" as never,
          search,
          sideA: { locationId: w.kolwezi, stockGroupIds: [] },
          sideB: { locationId: w.hadi, stockGroupIds: [] },
        });

      let result = await run("shoe-box");
      expect(result.itemRows.map((row) => row.stockItemName)).toEqual(["Shoe box"]);
      expect(result.itemRows[0].sideB).toMatchObject({ totalSales: 500, stockOutQty: 5 });

      // A container number matches only that container's offload lines.
      result = await run("MSKU77");
      expect(result.itemRows.map((row) => [row.stockItemName, row.sideA.stockInQty, row.sideA.totalSales])).toEqual([
        ["Loose", 2, 0],
        ["Rice bale", 10, 0],
      ]);

      // A sales voucher number matches that sale.
      result = await run("INV-42");
      expect(result.itemRows.map((row) => [row.stockItemName, row.sideA.totalSales])).toEqual([["Rice bale", 900]]);

      // The location and group names match every line there.
      result = await run("Hadi");
      expect(result.itemRows.map((row) => row.stockItemName)).toEqual(["Shoe box", "Rice bale", "Apron"]);
      expect(result.itemRows.every((row) => row.sideA.totalSales === 0)).toBe(true);
      result = await run("Shoes");
      expect(result.itemRows.map((row) => row.stockItemName)).toEqual(["Shoe box"]);
      expect(result.filters.search).toBe("Shoes");
    });
  });

  it("includes every date when no range is given", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      report.byLocation = new Map();
      const result = await getStockInSalesComparison({
        companyId: w.companyId,
        grouping: "monthly" as never,
        sideA: { locationId: w.kolwezi, stockGroupIds: [w.bales] },
        sideB: { locationId: w.hadi, stockGroupIds: [w.shoes] },
      });
      const riceRow = result.itemRows.find((row) => row.stockItemId === w.rice);
      // The May offload and the February sale now count; optional and deleted rows still do not.
      expect(riceRow?.sideA).toMatchObject({ stockInQty: 118, totalSales: 10650, stockOutQty: 107 });
      expect(result.itemRows.map((row) => row.stockItemName)).toEqual(["Rice bale", "Shoe box"]);
      expect(result.rows).toEqual([]);
    });
  });

  it("falls back to the item id and placeholder names", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      report.byLocation = new Map();
      const blank = await id(
        client,
        "INSERT INTO stock_items(company_id,code,name,uom) VALUES($1,'','','Bale') RETURNING id",
        [w.companyId]
      );
      await client.query(
        `INSERT INTO credit_note_items(voucher_id,stock_item_id,location_id,quantity,rate,total_value,inventory_cost)
         SELECT v.id,$2,$3,1,0,10,4 FROM vouchers v WHERE v.company_id=$1 AND v.voucher_type='Debit Note' LIMIT 1`,
        [w.companyId, blank, w.hadi]
      );
      const result = await getStockInSalesComparison({
        companyId: w.companyId,
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        grouping: "monthly" as never,
        sideA: { locationId: w.kolwezi, stockGroupIds: [w.shoes] },
        sideB: { locationId: w.hadi, stockGroupIds: [] },
      });
      const row = result.itemRows.find((r) => r.stockItemId === blank);
      expect(row).toMatchObject({
        stockItemCode: String(blank),
        stockItemName: "Unknown item",
        stockGroupName: "Unassigned",
        sideB: expect.objectContaining({ totalSales: 10, costOfSales: 4, costProfit: 6 }),
      });
    });
  });
});
