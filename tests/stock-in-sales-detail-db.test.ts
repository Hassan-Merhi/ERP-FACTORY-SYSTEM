/**
 * Stock In / Sales detail against PostgreSQL in a rolled-back transaction:
 * container offload receipts, sales with credit and debit notes, stock
 * adjustments in and out, the location/group/search filters, paging and the
 * export cap. The summary report it delegates to is stubbed.
 */
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

const summary = vi.hoisted(() => vi.fn());
vi.mock("../server/services/reports/stockInSalesReportService", () => ({
  getStockInSalesReport: (...a: unknown[]) => summary(...a),
}));

import { getStockInSalesDetail } from "../server/services/reports/stockInSalesDetailService";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const PREFIX = `SISD${Date.now().toString(36).toUpperCase()}`;
let seq = 0;

async function world(client: PoolClient) {
  const tag = `${PREFIX}${++seq}`;
  const one = async (text: string, params: unknown[]) => (await client.query<{ id: number }>(text, params)).rows[0].id;
  const companyId = await one(
    `INSERT INTO companies (code, name, base_currency, company_type) VALUES ($1::varchar, $1::text, 'USD', 'retail') RETURNING id`,
    [tag]
  );
  const location = (name: string) =>
    one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, $3) RETURNING id`, [
      companyId,
      `${tag}${name}`,
      name,
    ]);
  const group = (name: string) =>
    one(`INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, $3) RETURNING id`, [
      companyId,
      `${tag}${name}`,
      name,
    ]);
  const item = (code: string, name: string, groupId: number | null) =>
    one(
      `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id, active) VALUES ($1, $2, $3, 'PCS', $4, true) RETURNING id`,
      [companyId, code, name, groupId]
    );
  const supplierId = await one(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2, 'Supplier', 's@example.test', true) RETURNING id`,
    [companyId, `${tag}S`]
  );
  const offload = async (
    containerNumber: string,
    locationId: number,
    date: string | null,
    items: Array<[number, string, string]>,
    optional = false
  ) => {
    const containerId = await one(
      `INSERT INTO containers (company_id, container_number, import_date, supplier_id, offload_date)
       VALUES ($1, $2, '2026-09-01', $3, $4) RETURNING id`,
      [companyId, containerNumber, supplierId, date]
    );
    const offloadId = await one(
      `INSERT INTO container_offloads (container_id, location_id, total_bales, additional_cost_per_bale, optional, offloaded_at)
       VALUES ($1, $2, 0, 0, $3, '2026-10-05T10:00:00Z') RETURNING id`,
      [containerId, locationId, optional]
    );
    for (const [stockItemId, quantity, totalValue] of items) {
      await client.query(
        `INSERT INTO container_offload_items (offload_id, stock_item_id, quantity, rate, total_value) VALUES ($1, $2, $3, 0, $4)`,
        [offloadId, stockItemId, quantity, totalValue]
      );
    }
  };
  const voucher = (type: string, number: string, date: string, extra: Record<string, unknown> = {}) =>
    one(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, location_id, location_name, is_credit_sale, optional, deleted_at)
       VALUES ($1, $2, $3, $4, '0', $5, $6, $7, $8, $9) RETURNING id`,
      [
        companyId,
        number,
        type,
        date,
        extra.locationId ?? null,
        extra.locationName ?? null,
        extra.credit ?? false,
        extra.optional ?? false,
        extra.deleted ? new Date() : null,
      ]
    );
  const sale = (voucherId: number, stockItemId: number, qty: string, price: string, cost: string) =>
    client.query(
      `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
       VALUES ($1, $2, $3, $4, $5, $3::numeric * $4::numeric, $3::numeric * $5::numeric, $3::numeric * ($4::numeric - $5::numeric))`,
      [voucherId, stockItemId, qty, price, cost]
    );
  const note = (voucherId: number, stockItemId: number, locationId: number, qty: string, rate: string, cost: string) =>
    client.query(
      `INSERT INTO credit_note_items (voucher_id, stock_item_id, location_id, quantity, rate, total_value, inventory_cost)
       VALUES ($1, $2, $3, $4, $5, $4::numeric * $5::numeric, $6)`,
      [voucherId, stockItemId, locationId, qty, rate, cost]
    );
  const adjustment = async (
    number: string,
    date: string,
    type: string,
    locationId: number,
    items: Array<[number, string, string, string]>
  ) => {
    const voucherId = await voucher("Stock Adjustment", number, date);
    const adjustmentId = await one(
      `INSERT INTO stock_adjustment_vouchers (voucher_id, adjustment_type, location_id) VALUES ($1, $2, $3) RETURNING id`,
      [voucherId, type, locationId]
    );
    for (const [stockItemId, quantity, rate, total] of items) {
      await client.query(
        `INSERT INTO stock_adjustment_items (adjustment_id, stock_item_id, quantity, rate, total_amount) VALUES ($1, $2, $3, $4, $5)`,
        [adjustmentId, stockItemId, quantity, rate, total]
      );
    }
  };
  return { companyId, location, group, item, offload, voucher, sale, note, adjustment };
}

const filters = (companyId: number, over: Record<string, unknown> = {}) => ({
  companyId,
  startDate: "2026-10-01",
  endDate: "2026-10-31",
  locationIds: [] as number[],
  stockGroupIds: [] as number[],
  stockInPage: 1,
  stockOutPage: 1,
  limit: 50,
  ...over,
});

async function seeded(client: PoolClient) {
  const w = await world(client);
  const main = await w.location("Main Store");
  const branch = await w.location("Branch");
  const bales = await w.group("Bales");
  const shirt = await w.item(`${PREFIX}SH${seq}`, "Shirts", bales);
  const misc = await w.item(`${PREFIX}MI${seq}`, "Misc", null);

  await w.offload("MSKU-100", main, "2026-10-10", [
    [shirt, "10", "125.005"],
    [misc, "0", "0"],
  ]);
  // No offload date: the offload timestamp's date counts.
  await w.offload("TGHU-200", branch, null, [[shirt, "4", "40"]]);
  await w.offload("OUT-OF-RANGE", main, "2026-09-30", [[shirt, "1", "1"]]);
  await w.offload("OPTIONAL", main, "2026-10-12", [[shirt, "1", "1"]], true);

  const sale = await w.voucher("Sales", "S-002", "2026-10-15", { locationId: main, credit: true });
  await w.sale(sale, shirt, "3", "20", "12.5");
  const unlocated = await w.voucher("Sales", "S-001", "2026-10-15", { locationName: "Pop-up" });
  await w.sale(unlocated, misc, "2", "5", "5");
  const draft = await w.voucher("Sales", "S-DRAFT", "2026-10-15", { optional: true });
  await w.sale(draft, shirt, "1", "1", "1");
  const removed = await w.voucher("Sales", "S-DEL", "2026-10-15", { deleted: true });
  await w.sale(removed, shirt, "1", "1", "1");
  const credit = await w.voucher("Credit Note", "CN-1", "2026-10-20");
  await w.note(credit, shirt, main, "1", "20", "12.5");
  const debit = await w.voucher("Debit Note", "DN-1", "2026-10-18");
  await w.note(debit, misc, branch, "2", "3", "1");

  await w.adjustment("ADJ-1", "2026-10-11", "Production", main, [[shirt, "5", "11", "55"]]);
  await w.adjustment("ADJ-2", "2026-10-12", "Mixed", branch, [
    [shirt, "2", "10", "20"],
    [misc, "-3", "1.5", "-4.5"],
  ]);
  await w.adjustment("ADJ-3", "2026-10-13", "Damage", main, [[shirt, "-1", "10", "-10"]]);
  return { ...w, main, branch, bales, shirt, misc };
}

describe("getStockInSalesDetail", () => {
  it("lists receipts, sales and notes, and adjustments for the period with the summary", async () => {
    summary.mockReset().mockResolvedValue({ summary: { stockInQuantity: 14 } });
    await withRolledBackPool(async (client) => {
      const w = await seeded(client);
      const out = await getStockInSalesDetail(filters(w.companyId, { search: undefined }));
      expect(summary).toHaveBeenCalledWith({
        companyId: w.companyId,
        startDate: "2026-10-01",
        endDate: "2026-10-31",
        grouping: "daily",
        profitFilter: "all",
        locationIds: [],
        stockGroupIds: [],
        search: undefined,
      });
      expect(out).toMatchObject({
        period: { startDate: "2026-10-01", endDate: "2026-10-31" },
        filters: { startDate: "2026-10-01", endDate: "2026-10-31", locationIds: [], stockGroupIds: [] },
        summary: { stockInQuantity: 14 },
      });
      expect(out.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      expect(out.stockIn).toMatchObject({ total: 3, page: 1, limit: 50, totalPages: 1, truncated: false });
      expect(
        out.stockIn.rows.map((r) => [
          r.containerNumber,
          r.activityDate,
          r.stockItemName,
          r.stockGroupName,
          r.quantity,
          r.totalValue,
          r.avgRate,
        ])
      ).toEqual([
        ["MSKU-100", "2026-10-10", "Misc", "Unassigned", 0, 0, 0],
        ["MSKU-100", "2026-10-10", "Shirts", "Bales", 10, 125.01, 12.501],
        ["TGHU-200", "2026-10-05", "Shirts", "Bales", 4, 40, 10],
      ]);

      expect(out.stockOut).toMatchObject({ total: 4, truncated: false });
      expect(
        out.stockOut.rows.map((r) => [
          r.sourceType,
          r.voucherNumber,
          r.locationName,
          r.isCreditSale,
          r.quantity,
          r.totalSales,
          r.totalCost,
          r.costProfit,
          r.avgProfitPerBale,
        ])
      ).toEqual([
        ["Credit Note", "CN-1", "Main Store", null, -1, -20, -12.5, -7.5, 7.5],
        ["Debit Note", "DN-1", "Branch", null, 2, 6, 2, 4, 2],
        ["Sale", "S-002", "Main Store", true, 3, 60, 37.5, 22.5, 7.5],
        ["Sale", "S-001", "Pop-up", false, 2, 10, 10, 0, 0],
      ]);
      expect(out.stockOut.rows[2]).toMatchObject({ sellingRate: 20, unitCost: 12.5, stockGroupName: "Bales" });

      expect(out.adjustments).toMatchObject({ total: 4, page: 1, totalPages: 1, truncated: false });
      expect(
        out.adjustments.rows.map((r) => [
          r.voucherNumber,
          r.adjustmentType,
          r.direction,
          r.stockItemName,
          r.quantity,
          r.unitRate,
          r.totalValue,
        ])
      ).toEqual([
        ["ADJ-3", "Damage", "Out", "Shirts", 1, 10, 10],
        ["ADJ-2", "Mixed", "Out", "Misc", 3, 1.5, 4.5],
        ["ADJ-2", "Mixed", "In", "Shirts", 2, 10, 20],
        ["ADJ-1", "Production", "In", "Shirts", 5, 11, 55],
      ]);
    });
  });

  it("filters by location, stock group and search text", async () => {
    summary.mockReset().mockResolvedValue({ summary: {} });
    await withRolledBackPool(async (client) => {
      const w = await seeded(client);
      const branch = await getStockInSalesDetail(filters(w.companyId, { locationIds: [w.branch] }));
      expect(branch.stockIn.rows.map((r) => r.containerNumber)).toEqual(["TGHU-200"]);
      expect(branch.stockOut.rows.map((r) => r.voucherNumber)).toEqual(["DN-1"]);
      expect(branch.adjustments.rows.map((r) => r.voucherNumber)).toEqual(["ADJ-2", "ADJ-2"]);

      const grouped = await getStockInSalesDetail(filters(w.companyId, { stockGroupIds: [w.bales] }));
      expect(grouped.stockIn.total).toBe(2);
      expect(grouped.stockOut.rows.map((r) => r.voucherNumber)).toEqual(["CN-1", "S-002"]);
      expect(grouped.adjustments.total).toBe(3);

      const container = await getStockInSalesDetail(filters(w.companyId, { search: "tghu200" }));
      expect(container.stockIn.rows.map((r) => r.containerNumber)).toEqual(["TGHU-200"]);
      expect(container.stockOut.total).toBe(0);
      const byVoucher = await getStockInSalesDetail(filters(w.companyId, { search: "S-002" }));
      expect(byVoucher.stockOut.rows.map((r) => r.voucherNumber)).toEqual(["S-002"]);
      const byPopUp = await getStockInSalesDetail(filters(w.companyId, { search: "pop up" }));
      expect(byPopUp.stockOut.rows.map((r) => r.voucherNumber)).toEqual(["S-001"]);
      const byAdjustment = await getStockInSalesDetail(filters(w.companyId, { search: "ADJ-3" }));
      expect(byAdjustment.adjustments.rows.map((r) => r.voucherNumber)).toEqual(["ADJ-3"]);
      const byItem = await getStockInSalesDetail(filters(w.companyId, { search: "misc" }));
      expect(byItem.stockIn.total).toBe(1);
      expect(byItem.adjustments.total).toBe(1);
      const byGroupName = await getStockInSalesDetail(filters(w.companyId, { search: "bales" }));
      expect(byGroupName.stockIn.total).toBe(2);
      const byLocation = await getStockInSalesDetail(filters(w.companyId, { search: "branch" }));
      expect(byLocation.stockIn.rows.map((r) => r.containerNumber)).toEqual(["TGHU-200"]);
    });
  });

  it("pages receipts and sales, and returns everything on export", async () => {
    summary.mockReset().mockResolvedValue({ summary: {} });
    await withRolledBackPool(async (client) => {
      const w = await seeded(client);
      const page2 = await getStockInSalesDetail(filters(w.companyId, { limit: 2, stockInPage: 2, stockOutPage: 2 }));
      expect(page2.stockIn).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
      expect(page2.stockIn.rows.map((r) => r.containerNumber)).toEqual(["TGHU-200"]);
      expect(page2.stockOut).toMatchObject({ page: 2, total: 4, totalPages: 2 });
      expect(page2.stockOut.rows.map((r) => r.voucherNumber)).toEqual(["S-002", "S-001"]);
      // Adjustments are not paged: one page of up to the limit.
      expect(page2.adjustments).toMatchObject({ page: 1, limit: 2, total: 4, totalPages: 2 });
      expect(page2.adjustments.rows).toHaveLength(2);

      const exported = await getStockInSalesDetail(filters(w.companyId, { limit: 2, stockInPage: 2, exportAll: true }));
      expect(exported.stockIn).toMatchObject({ page: 1, limit: 20000, truncated: false });
      expect(exported.stockIn.rows).toHaveLength(3);
      expect(exported.stockOut.rows).toHaveLength(4);
      expect(exported.adjustments).toMatchObject({ limit: 20000, truncated: false });
      expect(exported.adjustments.rows).toHaveLength(4);
    });
  });

  it("reports an empty period with one page", async () => {
    summary.mockReset().mockResolvedValue({ summary: {} });
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const out = await getStockInSalesDetail(filters(w.companyId));
      for (const section of [out.stockIn, out.stockOut, out.adjustments]) {
        expect(section).toMatchObject({ rows: [], total: 0, totalPages: 1, truncated: false });
      }
    });
  });
});
