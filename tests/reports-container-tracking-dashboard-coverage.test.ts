/**
 * GET /api/dashboard/container-tracking
 * (server/routes/reportsContainerTrackingRoutes.ts) over HTTP, one rolled-back
 * company per test: a withdrawn company role is refused, then OTW and
 * offloaded containers grouped by route, agent (with ledger balances matched
 * by account name), location and transporter, with purchase-order item counts,
 * and containers of companies the user cannot reach left out.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/dashboard/container-tracking";

async function seed(w: FactoryWorld, companyId = w.companyId) {
  const supplierId = await w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Ship Co', 'ship@example.test') RETURNING id`,
    [companyId, `${w.tag}S${companyId}`]
  );
  let n = 0;
  const container = (fields: {
    status: string;
    agent?: string | null;
    plate?: string | null;
    shop?: string | null;
    location?: string | null;
    transporter?: string | null;
    total?: string;
    duty?: string;
    transport?: string;
  }) =>
    w.one(
      `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, agent, number_plate,
         shop_name, tracking_location, transporter, grand_total, duty_fee, transport_fee)
       VALUES ($1, $2, '2026-03-01', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        companyId,
        `${w.tag}-K${companyId}-${++n}`,
        supplierId,
        fields.status,
        fields.agent ?? null,
        fields.plate ?? null,
        fields.shop ?? null,
        fields.location ?? null,
        fields.transporter ?? null,
        fields.total ?? "0",
        fields.duty ?? "0",
        fields.transport ?? "0",
      ]
    );
  return { supplierId, container };
}

describe("container tracking dashboard", () => {
  it("refuses a session whose company role was withdrawn", () =>
    withFactoryWorld(async (w) => {
      const agent = await w.agentFor("Staff");
      await w.q(
        `DELETE FROM user_company_roles WHERE company_id = $1 AND user_id IN (SELECT id FROM users WHERE username LIKE $2)`,
        [w.companyId, `${w.tag.toLowerCase()}_u%`]
      );
      expect((await agent.get(URL)).status).toBe(403);
    }));

  it("groups OTW and offloaded containers and matches agent ledger balances", () =>
    withFactoryWorld(async (w) => {
      const { supplierId, container } = await seed(w);
      const otwA = await container({
        status: "OTW",
        agent: "Bolloré",
        plate: "ABC 123",
        shop: "Kolwezi",
        location: "Kasumbalesa",
        transporter: "Trucks Ltd",
        total: "1000.50",
        transport: "200",
      });
      await container({ status: "OTW", agent: "Bolloré", plate: "  ", total: "300" });
      await container({
        status: "OFFLOADED",
        agent: "Bolloré",
        transporter: "Trucks Ltd",
        duty: "75",
        transport: "50",
      });
      await container({ status: "OFFLOADED", duty: "10" });
      await container({ status: "PENDING", total: "999" });
      // An agent with no matching ledger account and a purchase order without lines.
      const otwZ = await container({ status: "OTW", agent: "Zed Logistics", plate: "ZED 1", total: "0" });

      const stockItemId = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bales', 'PCS') RETURNING id`,
        [w.companyId, `${w.tag}I`]
      );
      const poId = await w.one(
        `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [w.companyId, otwA, `${w.tag}PO`, supplierId]
      );
      await w.q(
        `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id) VALUES ($1, $2, $3, $4)`,
        [w.companyId, otwZ, `${w.tag}PZ`, supplierId]
      );
      for (const name of ["Shirts", "Shoes"]) {
        await w.q(
          `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total) VALUES ($1, $2, $3, 1, 1, 1)`,
          [poId, stockItemId, name]
        );
      }
      const accountId = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
         VALUES ($1, $2, 'Bolloré Agent', 'Liability', 100, 'Cr') RETURNING id`,
        [w.companyId, `${w.tag}AG`]
      );
      const voucherId = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Payment', '2026-03-02', 40) RETURNING id`,
        [w.companyId, `${w.tag}V1`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 40, 0)`,
        [voucherId, accountId]
      );

      // Another company's containers stay out of this user's report.
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      await (await seed(w, other)).container({ status: "OTW", total: "5000" });

      const res = await w.agent.get(URL);
      expect(res.status).toBe(200);
      const body = res.body;
      expect(body.totals).toEqual({ count: 3, amount: 1300.5, totalItems: 2 });
      expect(new Set(body.containers.map((c: { companyId: number }) => c.companyId))).toEqual(new Set([w.companyId]));
      expect(body.byAgent["Zed Logistics"]).toMatchObject({ total: 0, balance: 0 });
      expect(body.containers.find((c: { id: number }) => c.id === otwZ).itemCount).toBe(0);
      expect(body.containers.find((c: { id: number }) => c.id === otwA)).toMatchObject({
        itemCount: 2,
        supplierName: "Ship Co",
        companyCode: w.tag,
      });
      expect(Object.keys(body.byRoute).sort()).toEqual(["Kolwezi", "Unassigned"]);
      expect(body.byRoute.Unassigned).toHaveLength(2);
      expect(body.byLocation).toEqual({ Kasumbalesa: { count: 1, total: 1000.5 }, Unknown: { count: 2, total: 300 } });
      expect(body.byAgent["Bolloré"]).toMatchObject({ total: 1000.5, offloadedTotal: 75, balance: -60 });
      expect(body.byAgent["Bolloré"].containers).toHaveLength(1);
      expect(body.byAgent.Unassigned).toMatchObject({ offloadedTotal: 10, balance: 0 });
      expect(body.byTransporter["Trucks Ltd"]).toMatchObject({ otwTotal: 200, offloadedTotal: 50 });
      expect(body.byTransporter.Unassigned.otw).toHaveLength(2);
      expect(body.byTransporter.Unassigned.offloaded).toHaveLength(1);
    }));
});
