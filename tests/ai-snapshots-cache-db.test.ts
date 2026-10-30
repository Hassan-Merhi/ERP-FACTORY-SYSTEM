/**
 * Chatbot company snapshots against PostgreSQL in a rolled-back transaction:
 * cache hits and expiry, the upsert, the inventory and supplier balance
 * builders, and the summaries derived from the AI tools (stubbed).
 */
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tools = vi.hoisted(() => ({
  summary: vi.fn(),
  lowStock: vi.fn(),
  pricing: vi.fn(),
}));
vi.mock("../server/aiTools", () => ({
  getBusinessSummary: (...a: unknown[]) => tools.summary(...a),
  getLowStockItems: (...a: unknown[]) => tools.lowStock(...a),
  getPricingHealth: (...a: unknown[]) => tools.pricing(...a),
}));

import { getOrBuildAISnapshot } from "../server/lib/aiSnapshots";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const PREFIX = `AISNAP${Date.now().toString(36).toUpperCase()}`;
const business = {
  fetchedAt: "2026-10-30T00:00:00.000Z",
  today: { revenue: "10.00" },
  thisMonth: { revenue: "300.00" },
  topItemsThisMonth: [{ name: "Bale" }],
  openPurchaseOrders: 2,
  extra: "only in the full summary",
};

beforeEach(() => {
  tools.summary.mockReset().mockResolvedValue(business);
  tools.lowStock
    .mockReset()
    .mockResolvedValue([{ status: "OUT_OF_STOCK" }, { status: "LOW_STOCK" }, { status: "LOW_STOCK" }]);
  tools.pricing
    .mockReset()
    .mockResolvedValue([
      { status: "LOSING" },
      { status: "PROFITABLE" },
      { status: "PROFITABLE" },
      { status: "BREAK_EVEN" },
    ]);
});

async function company(client: PoolClient, suffix: string): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO companies (code, name, base_currency, company_type) VALUES ($1, $2, 'USD', 'retail') RETURNING id`,
    [`${PREFIX}${suffix}`.slice(0, 20), `${PREFIX} ${suffix}`]
  );
  return rows[0].id;
}

async function storedSnapshot(client: PoolClient, companyId: number, type: string) {
  const { rows } = await client.query(
    `SELECT data, EXTRACT(EPOCH FROM (expires_at - calculated_at))::int AS ttl
       FROM ai_company_snapshots WHERE company_id = $1 AND snapshot_type = $2`,
    [companyId, type]
  );
  return rows;
}

describe("getOrBuildAISnapshot cache", () => {
  it("serves an unexpired snapshot without rebuilding it", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client, "H");
      await client.query(
        `INSERT INTO ai_company_snapshots (company_id, snapshot_type, data, calculated_at, expires_at)
         VALUES ($1, 'sales_today', '{"cached":true}', now(), now() + interval '1 minute')`,
        [id]
      );
      expect(await getOrBuildAISnapshot(id, "sales_today")).toEqual({ cached: true });
      expect(tools.summary).not.toHaveBeenCalled();
    });
  });

  it("rebuilds an expired snapshot and replaces it with the default TTL", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client, "E");
      await client.query(
        `INSERT INTO ai_company_snapshots (company_id, snapshot_type, data, calculated_at, expires_at)
         VALUES ($1, 'sales_today', '{"cached":true}', now() - interval '1 hour', now() - interval '1 second')`,
        [id]
      );
      const fresh = await getOrBuildAISnapshot(id, "sales_today");
      expect(fresh).toEqual({ fetchedAt: business.fetchedAt, today: business.today });
      expect(tools.summary).toHaveBeenCalledWith(id);
      expect(await storedSnapshot(client, id, "sales_today")).toEqual([{ data: fresh, ttl: 300 }]);
    });
  });

  it("stores each type with its own TTL, or the TTL the caller asks for", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client, "T");
      const month = await getOrBuildAISnapshot(id, "sales_month");
      expect(month).toEqual({
        fetchedAt: business.fetchedAt,
        thisMonth: business.thisMonth,
        topItemsThisMonth: business.topItemsThisMonth,
        openPurchaseOrders: 2,
      });
      expect(await getOrBuildAISnapshot(id, "business_summary", 42)).toEqual(business);
      const pricing = await getOrBuildAISnapshot(id, "pricing_health");
      expect(pricing).toMatchObject({ losingCount: 1, profitableCount: 2, breakEvenCount: 1 });
      expect(tools.pricing).toHaveBeenCalledWith(id, 30);
      const low = await getOrBuildAISnapshot(id, "low_stock");
      expect(low).toMatchObject({ outOfStockCount: 1, lowStockCount: 2 });
      expect(low.items).toHaveLength(3);
      expect(tools.lowStock).toHaveBeenCalledWith(id, 30);

      const ttls = Object.fromEntries(
        await Promise.all(
          ["sales_month", "business_summary", "pricing_health", "low_stock"].map(
            async (type) => [type, (await storedSnapshot(client, id, type))[0].ttl] as const
          )
        )
      );
      expect(ttls).toEqual({ sales_month: 600, business_summary: 42, pricing_health: 1800, low_stock: 600 });
    });
  });

  it("rejects an unknown snapshot type", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client, "U");
      await expect(getOrBuildAISnapshot(id, "nope" as never)).rejects.toThrow(
        "[AISnapshot] Unknown snapshot type: nope"
      );
    });
  });
});

describe("inventory_summary", () => {
  it("totals the company's inventory and ranks stock groups by value", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client, "I");
      const other = await company(client, "O");
      const location = await client.query<{ id: number }>(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Main') RETURNING id`,
        [id, `${PREFIX}L`]
      );
      const group = async (code: string, name: string) =>
        (
          await client.query<{ id: number }>(
            `INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
            [id, code, name]
          )
        ).rows[0].id;
      const bales = await group(`${PREFIX}B`, "Bales");
      const shoes = await group("", "Shoes");
      await group(`${PREFIX}E`, "Empty");
      const item = async (groupId: number, code: string, active = true) =>
        (
          await client.query<{ id: number }>(
            `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id, active)
             VALUES ($1, $2, $3, 'PCS', $4, $5) RETURNING id`,
            [id, `${PREFIX}${code}`, code, groupId, active]
          )
        ).rows[0].id;
      const stock = (itemId: number, qty: string, value: string) =>
        client.query(
          `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
           VALUES ($1, $2, $3, $4, '1', $5)`,
          [id, location.rows[0].id, itemId, qty, value]
        );
      await stock(await item(bales, "B1"), "2.5", "100.10");
      await stock(await item(bales, "B2"), "1", "50.005");
      await stock(await item(shoes, "S1"), "4", "300");
      await stock(await item(shoes, "S2", false), "9", "999");
      // Another company's group never appears.
      await client.query(`INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, 'Other')`, [
        other,
        `${PREFIX}X`,
      ]);

      // PostgreSQL returns COUNT as a bigint, which node-postgres hands back as text.
      const snapshot = await getOrBuildAISnapshot(id, "inventory_summary");
      expect(snapshot).toMatchObject({ totalItems: "4", totalValue: "1449.11", totalQty: "16.500" });
      expect(snapshot.byGroup).toEqual([
        { groupId: shoes, groupName: "Shoes", groupCode: "", itemCount: "1", totalValue: "300.00", totalQty: "4.000" },
        {
          groupId: bales,
          groupName: "Bales",
          groupCode: `${PREFIX}B`,
          itemCount: "2",
          totalValue: "150.11",
          totalQty: "3.500",
        },
        {
          groupId: expect.any(Number),
          groupName: "Empty",
          groupCode: `${PREFIX}E`,
          itemCount: "0",
          totalValue: "0.00",
          totalQty: "0.000",
        },
      ]);
    });
  });

  it("reports zero totals for a company with no stock", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client, "Z");
      expect(await getOrBuildAISnapshot(id, "inventory_summary")).toMatchObject({
        totalItems: "0",
        totalValue: "0.00",
        totalQty: "0.000",
        byGroup: [],
      });
    });
  });
});

describe("supplier_balances", () => {
  it("nets opening balances with this company's posted entries", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client, "S");
      const other = await company(client, "R");
      const supplier = async (code: string, opening: string, name: string | null = `${PREFIX} ${code}`) =>
        (
          await client.query<{ id: number }>(
            `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, active)
             VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
            [id, `${PREFIX}${code}`, name ?? "", `${code.toLowerCase()}@example.test`, opening]
          )
        ).rows[0].id;
      const payable = await supplier("PAY", "100");
      const overpaid = await supplier("OVR", "0");
      const settled = await supplier("SET", "50");
      const blank = await supplier("BLK", "5", null);
      await client.query(`UPDATE suppliers SET code = '' WHERE id = $1`, [blank]);
      const inactive = await supplier("OFF", "70");
      await client.query(`UPDATE suppliers SET active = false WHERE id = $1`, [inactive]);

      const voucher = async (companyId: number, number: string, optional = false, deleted = false) =>
        (
          await client.query<{ id: number }>(
            `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional, deleted_at)
             VALUES ($1, $2, 'Journal', '2026-10-01', '0', $3, CASE WHEN $4 THEN now() END) RETURNING id`,
            [companyId, `${PREFIX}-${number}`, optional, deleted]
          )
        ).rows[0].id;
      const entry = (voucherId: number, supplierId: number, debit: string, credit: string) =>
        client.query(
          `INSERT INTO voucher_entries (voucher_id, supplier_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
          [voucherId, supplierId, debit, credit]
        );
      const posted = await voucher(id, "1");
      await entry(posted, payable, "0", "25.50");
      await entry(posted, payable, "10", "0");
      await entry(posted, overpaid, "40", "0");
      await entry(posted, settled, "50", "0");
      await entry(await voucher(id, "2", true), payable, "0", "1000");
      await entry(await voucher(id, "3", false, true), payable, "0", "1000");
      // Another company's posting never reaches this company's balances.
      const foreign = (
        await client.query<{ id: number }>(
          `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, active)
           VALUES ($1, $2, 'Foreign', 'foreign@example.test', '0', true) RETURNING id`,
          [other, `${PREFIX}FOR`]
        )
      ).rows[0].id;
      await entry(await voucher(other, "4"), foreign, "0", "1000");

      const { balances } = await getOrBuildAISnapshot(id, "supplier_balances");
      const mine = balances.filter((b) =>
        [payable, overpaid, settled, blank, inactive, foreign].includes(b.supplierId)
      );
      expect(mine).toEqual([
        {
          supplierId: payable,
          supplierCode: `${PREFIX}PAY`,
          supplierName: `${PREFIX} PAY`,
          openingBalance: "100.00",
          balance: "115.50",
          status: "PAYABLE",
        },
        {
          supplierId: blank,
          supplierCode: "",
          supplierName: "Unknown",
          openingBalance: "5.00",
          balance: "5.00",
          status: "PAYABLE",
        },
        {
          supplierId: overpaid,
          supplierCode: `${PREFIX}OVR`,
          supplierName: `${PREFIX} OVR`,
          openingBalance: "0.00",
          balance: "-40.00",
          status: "OVERPAID",
        },
      ]);
      // Every listed balance is ordered from most payable to most overpaid.
      const amounts = balances.map((b) => Number(b.balance));
      expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    });
  });
});
