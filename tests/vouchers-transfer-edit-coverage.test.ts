/**
 * The legacy PATCH /api/vouchers/:id/transfer handler
 * (vouchers/transfer/transfer.ts) against PostgreSQL in one rolled-back
 * transaction per test.
 *
 * Over HTTP the exact-value edit route and the stock-transfer lifecycle route
 * are registered first and answer every existing transfer voucher, so the
 * legacy handler only sees unknown vouchers and non-transfer types (pinned
 * over HTTP below). Its remaining logic is exercised by invoking the
 * registered handler directly: voucher type and company checks, foreign
 * locations and items, locked (migrated / Golden Coast / intercompany)
 * vouchers, the role rules (Manager only for today's vouchers), and an edit
 * that reverses the old lines, applies the new ones, rewrites the transfer and
 * voucher and audits the change. Refusals change nothing.
 */
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { item, nextSeq, otherCompany, voucher } from "./helpers/voucherReadFixture";
import { registerVoucherTransferOnlyRoutes } from "../server/routes/vouchers/transfer/transfer";

type Handler = (req: Request, res: Response) => Promise<unknown>;
let legacyHandler: Handler | null = null;
registerVoucherTransferOnlyRoutes({
  patch: (_path: string, ...chain: unknown[]) => {
    legacyHandler = chain[chain.length - 1] as Handler;
  },
} as never);

/** Runs the legacy handler itself (see the file header) with a session for the world's user. */
async function patch(
  w: FactoryWorld,
  id: number | string,
  body: Record<string, unknown>,
  role: string | null = "Admin"
) {
  let status = 200;
  let payload: any;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      payload = value;
      return res;
    },
  };
  const session = { currentCompanyId: w.companyId, currentRole: role, userId: w.userId, username: w.username };
  await legacyHandler!({ params: { id: String(id) }, body, session } as unknown as Request, res as unknown as Response);
  return { status, body: payload };
}

async function setup(w: FactoryWorld, options: { date?: string; number?: string; withTransfer?: boolean } = {}) {
  const shop = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
    w.companyId,
    `${w.tag}SH${nextSeq()}`,
  ]);
  const id = options.number
    ? await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Stock Transfer', '2026-05-01', 10) RETURNING id`,
        [w.companyId, options.number]
      )
    : await voucher(w, "Stock Transfer", { date: options.date, total: "10" });
  const coat = await item(w, "Coat");
  for (const [location, qty] of [
    [w.locationId, "8"],
    [shop, "2"],
  ] as const) {
    await w.q(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, total_value, average_rate)
       VALUES ($1, $2, $3, $4, $4::numeric * 5, 5)`,
      [w.companyId, location, coat, qty]
    );
  }
  if (options.withTransfer !== false) {
    const tv = await w.one(
      `INSERT INTO stock_transfer_vouchers (voucher_id, source_location_id, destination_location_id) VALUES ($1, $2, $3)
       RETURNING id`,
      [id, w.locationId, shop]
    );
    await w.q(
      `INSERT INTO stock_transfer_items (transfer_id, stock_item_id, quantity, rate, total_amount, source_location_id)
       VALUES ($1, $2, 2, 5, 10, $3)`,
      [tv, coat, w.locationId]
    );
  }
  const body = {
    sourceLocationId: w.locationId,
    destinationLocationId: shop,
    voucherDate: "2026-05-02",
    description: " moved coats ",
    items: [{ stockItemId: coat, quantity: "3", rate: "5" }],
  };
  return { id, shop, coat, body };
}

const qty = async (w: FactoryWorld, location: number, stockItemId: number) =>
  (
    await w.q(`SELECT quantity::text AS q FROM inventory WHERE location_id = $1 AND stock_item_id = $2`, [
      location,
      stockItemId,
    ])
  )[0]?.q;

describe("PATCH /api/vouchers/:id/transfer over HTTP", () => {
  it("reaches the legacy handler only for unknown vouchers and non-transfer types", async () => {
    await withFactoryWorld(async (w) => {
      const { body } = await setup(w);
      const http = (id: number) => w.agent.patch(`/api/vouchers/${id}/transfer`).send(body);
      expect((await http(2147483000)).status).toBe(404);
      const journal = await http(await voucher(w, "Journal"));
      expect([journal.status, journal.body.message]).toEqual([
        400,
        "This endpoint only updates Stock Transfer vouchers",
      ]);
    });
  });
});

describe("legacy transfer edit handler: refusals", () => {
  it("validates the id, items and locations and refuses unknown, non-transfer and foreign vouchers", async () => {
    await withFactoryWorld(async (w) => {
      const { id, body } = await setup(w);
      expect((await patch(w, "abc", body)).status).toBe(400);
      expect((await patch(w, id, { ...body, items: [] })).body.message).toBe("At least one item is required");
      expect((await patch(w, id, { ...body, destinationLocationId: null })).status).toBe(400);
      expect((await patch(w, 2147483000, body)).status).toBe(404);
      const journal = await voucher(w, "Journal");
      expect((await patch(w, journal, body)).body.message).toMatch(/only updates Stock Transfer/);
      const foreign = await voucher(w, "Stock Transfer", { companyId: await otherCompany(w) });
      expect((await patch(w, foreign, body)).status).toBe(403);
      const elsewhere = await otherCompany(w);
      const foreignLocation = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`,
        [elsewhere, `${w.tag}FAR`]
      );
      const badLocation = await patch(w, id, { ...body, destinationLocationId: foreignLocation });
      expect([badLocation.status, badLocation.body.message]).toEqual([400, "Location not found"]);
      const badItem = await patch(w, id, { ...body, items: [{ stockItemId: 2147483000, quantity: "1", rate: "1" }] });
      expect([badItem.status, badItem.body.message]).toEqual([400, "Stock item not found"]);
      expect(await qty(w, w.locationId, body.items[0].stockItemId)).toBe("8.000");
    });
  });

  it("refuses migrated, Golden Coast and intercompany vouchers", async () => {
    await withFactoryWorld(async (w) => {
      for (const number of [`MIG-${w.tag}`, `GC-${w.tag}`]) {
        const { id, body } = await setup(w, { number });
        expect((await patch(w, id, body)).status).toBe(403);
      }
      const { id, body } = await setup(w);
      await w.q(`UPDATE vouchers SET source_module = 'INTERCOMPANY_CONTAINER' WHERE id = $1`, [id]);
      expect((await patch(w, id, body)).status).toBe(403);
      const [row] = await w.q(`SELECT description FROM vouchers WHERE id = $1`, [id]);
      expect(row.description).toBeNull();
    });
  });

  it("lets a Manager edit only today's transfer and refuses other or missing roles", async () => {
    await withFactoryWorld(async (w) => {
      const { id, body } = await setup(w);
      const old = await patch(w, id, body, "Manager");
      expect([old.status, old.body.message]).toEqual([403, "Managers can only edit today's vouchers"]);
      expect((await patch(w, id, body, "ERP Tester")).body.message).toBe("Insufficient permissions to edit vouchers");
      expect((await patch(w, id, body, null)).body.message).toBe("User role not found");
      expect(await qty(w, w.locationId, body.items[0].stockItemId)).toBe("8.000");
      const today = new Date().toISOString().slice(0, 10);
      const fresh = await setup(w, { date: today });
      const ok = await patch(w, fresh.id, { ...fresh.body, voucherDate: undefined, description: undefined }, "Manager");
      expect(ok.status).toBe(200);
      expect(ok.body.description).toBeNull();
    });
  });
});

describe("legacy transfer edit handler: edits", () => {
  it("reverses the old lines, applies the new ones and audits the edit", async () => {
    await withFactoryWorld(async (w) => {
      const { id, shop, coat, body } = await setup(w);
      const res = await patch(w, id, body);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id,
        totalAmount: "15.00",
        locationId: w.locationId,
        description: "moved coats",
      });
      // Old line (2 from Yard to Shop) reversed, new line (3) applied.
      expect(await qty(w, w.locationId, coat)).toBe("7.000");
      expect(await qty(w, shop, coat)).toBe("3.000");
      const items = await w.q(
        `SELECT i.quantity::text AS q FROM stock_transfer_items i JOIN stock_transfer_vouchers t ON t.id = i.transfer_id
          WHERE t.voucher_id = $1`,
        [id]
      );
      expect(items).toEqual([{ q: "3.000" }]);
      const [audit] = await w.q(
        `SELECT changes FROM audit_log WHERE table_name = 'vouchers' AND record_id = $1 AND action = 'update'`,
        [id]
      );
      expect(Object.keys(audit.changes)).toEqual(expect.arrayContaining(["date", "totalAmount", "description"]));
    });
  });

  it("creates the transfer record when missing, moves locations and narrates a blank description", async () => {
    await withFactoryWorld(async (w) => {
      const { id, shop, coat, body } = await setup(w, { withTransfer: false });
      const res = await patch(w, id, {
        ...body,
        sourceLocationId: shop,
        destinationLocationId: w.locationId,
        description: "   ",
        items: [{ stockItemId: coat, quantity: "1", rate: "5" }],
      });
      expect(res.status).toBe(200);
      expect(res.body.description).toMatch(/Shop/);
      expect(res.body.locationName).toBe("Shop");
      expect(await qty(w, shop, coat)).toBe("1.000");
      expect(await qty(w, w.locationId, coat)).toBe("9.000");
      const [tv] = await w.q(
        `SELECT source_location_id, destination_location_id FROM stock_transfer_vouchers WHERE voucher_id = $1`,
        [id]
      );
      expect(tv).toEqual({ source_location_id: shop, destination_location_id: w.locationId });
    });
  });

  it("fails an existing transfer that has lost its source location", async () => {
    await withFactoryWorld(async (w) => {
      const { id, coat, body } = await setup(w);
      await w.q(`UPDATE stock_transfer_vouchers SET source_location_id = NULL WHERE voucher_id = $1`, [id]);
      const res = await patch(w, id, body);
      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/missing source or destination/);
      expect(await qty(w, w.locationId, coat)).toBe("8.000");
    });
  });
});
