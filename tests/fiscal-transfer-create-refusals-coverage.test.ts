/**
 * Stock transfer creation (server/routes/fiscal-transfers/create.ts), one
 * rolled-back transaction per test through the full HTTP stack.
 *
 * Pinned: every validation refusal in both the new-transfer and the
 * existing-voucher flow leaves inventory and transfer tables untouched;
 * another company's locations, items and vouchers are refused; a client
 * request id replays instead of moving stock twice; a second transfer on the
 * same voucher is refused.
 */
import { describe, expect, it, vi } from "vitest";

import { logger } from "../server/lib/logger";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

// WhatsApp delivery is an external provider; only the call is observed.
const sendTransferWhatsApp = vi.hoisted(() => vi.fn(async (_payload: Record<string, unknown>) => undefined));
vi.mock("../server/helpers/sendTransferWhatsApp", () => ({ sendTransferWhatsApp }));

interface TransferWorld {
  source: number;
  destination: number;
  itemId: number;
  foreignLocation: number;
  foreignItem: number;
  foreignCompany: number;
}

async function transferWorld(w: FactoryWorld): Promise<TransferWorld> {
  const destination = await w.one(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`,
    [w.companyId, `${w.tag}D`]
  );
  const itemId = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2, 'Bale', 'PCS', true) RETURNING id`,
    [w.companyId, `${w.tag}IT`]
  );
  await w.q(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value) VALUES ($1, $2, $3, 10, 2, 20)`,
    [w.companyId, w.locationId, itemId]
  );
  const foreignCompany = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
    `${w.tag}O`,
  ]);
  const foreignLocation = await w.one(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Other') RETURNING id`,
    [foreignCompany, `${w.tag}OL`]
  );
  const foreignItem = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2, 'Other', 'PCS', true) RETURNING id`,
    [foreignCompany, `${w.tag}OI`]
  );
  return { source: w.locationId, destination, itemId, foreignLocation, foreignItem, foreignCompany };
}

async function state(w: FactoryWorld) {
  const [row] = await w.q<{ transfers: number; qty: string }>(
    `SELECT (SELECT count(*)::int FROM stock_transfer_vouchers st JOIN vouchers v ON v.id = st.voucher_id WHERE v.company_id = $1) AS transfers,
            (SELECT quantity::numeric::text FROM inventory WHERE company_id = $1 AND location_id = $2) AS qty`,
    [w.companyId, w.locationId]
  );
  return { transfers: row.transfers, qty: Number(row.qty) };
}

const UNCHANGED = { transfers: 0, qty: 10 };

describe("new stock transfer refusals", () => {
  it("refuses forged origin and every malformed or foreign body without moving stock", async () => {
    await withFactoryWorld(async (w) => {
      const t = await transferWorld(w);
      const item = { stockItemId: t.itemId, quantity: "1", sourceLocationId: t.source };
      const cases: [Record<string, unknown>, number, RegExp][] = [
        [{ workflowOrigin: "stock_transfer_order", sourceLocationId: t.source }, 400, /Workflow origin/],
        [{ sourceLocationId: t.source, items: [item] }, 400, /Destination location is required/],
        [{ sourceLocationId: t.source, destinationLocationId: t.destination, items: [] }, 400, /Items are required/],
        [
          {
            sourceLocationId: "abc",
            destinationLocationId: t.destination,
            items: [{ ...item, sourceLocationId: undefined }],
          },
          400,
          /Invalid sourceLocationId/,
        ],
        [{ destinationLocationId: t.destination, items: [{ ...item, stockItemId: "x" }] }, 400, /Invalid stockItemId/],
        [{ destinationLocationId: t.destination, items: [{ ...item, quantity: "0" }] }, 400, /Invalid quantity/],
        [{ destinationLocationId: "nope", items: [item] }, 400, /Invalid destinationLocationId/],
        [{ destinationLocationId: t.source, items: [item] }, 400, /Source and destination must be different/],
        [{ destinationLocationId: t.foreignLocation, items: [item] }, 404, /Destination location not found/],
        [
          { destinationLocationId: t.destination, items: [{ ...item, sourceLocationId: t.foreignLocation }] },
          404,
          /Source location not found/,
        ],
        [
          { destinationLocationId: t.destination, items: [{ ...item, stockItemId: t.foreignItem }] },
          400,
          /Stock item not found/,
        ],
        [
          {
            destinationLocationId: t.destination,
            items: [item, { ...item, sourceLocationId: t.destination }],
          },
          400,
          /Source and destination cannot be the same/,
        ],
        [
          { destinationLocationId: t.destination, items: [item], clientRequestId: "x".repeat(201) },
          400,
          /200 characters/,
        ],
      ];
      for (const [body, status, message] of cases) {
        const res = await w.agent.post("/api/stock-transfers").send(body);
        expect(res.status, JSON.stringify(body) + res.text).toBe(status);
        expect(res.body.message).toMatch(message);
      }
      expect(await state(w)).toEqual(UNCHANGED);
    });
  });

  it("refuses manual stock transfer orders in retail mode", async () => {
    await withFactoryWorld(async (w) => {
      const t = await transferWorld(w);
      await w.q(`UPDATE companies SET company_type = 'retail' WHERE id = $1`, [w.companyId]);
      const res = await w.agent.post("/api/stock-transfer-orders").send({
        sourceLocationId: t.source,
        destinationLocationId: t.destination,
        items: [{ stockItemId: t.itemId, quantity: "1" }],
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("RETAIL_MANUAL_VOUCHER_TYPE_BLOCKED");
      expect(await state(w)).toEqual(UNCHANGED);
    });
  });

  it("moves stock once per client request id and refuses negative stock when not confirmed", async () => {
    await withFactoryWorld(async (w) => {
      const t = await transferWorld(w);
      const body = {
        destinationLocationId: t.destination,
        items: [{ stockItemId: t.itemId, quantity: "3", sourceLocationId: t.source }],
        clientRequestId: `${w.tag.toLowerCase()}-req-0001`,
        voucherDate: "2026-03-01",
      };
      const first = await w.agent.post("/api/stock-transfers").send(body);
      expect(first.status, first.text).toBe(201);
      expect(first.body.replayed).toBe(false);
      const replay = await w.agent.post("/api/stock-transfers").send(body);
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ replayed: true, transfer: { id: first.body.transfer.id } });
      expect(await state(w)).toEqual({ transfers: 1, qty: 7 });

      const tooMuch = await w.agent.post("/api/stock-transfers").send({
        sourceLocationId: t.source,
        destinationLocationId: t.destination,
        items: [{ stockItemId: t.itemId, quantity: "50" }],
        allowNegativeInventory: false,
      });
      expect([400, 409]).toContain(tooMuch.status);
      expect(tooMuch.body.code).toMatch(/^STOCK_TRANSFER_/);
      expect(await state(w)).toEqual({ transfers: 1, qty: 7 });
    });
  });
});

async function transferVoucher(w: FactoryWorld, companyId = w.companyId) {
  return w.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Stock Transfer', '2026-03-01', 0) RETURNING id`,
    [companyId, `${w.tag}ST${Math.floor(Math.random() * 1e7)}`]
  );
}

describe("transfer onto an existing voucher", () => {
  it("refuses missing or invalid fields and unknown records without moving stock", async () => {
    await withFactoryWorld(async (w) => {
      const t = await transferWorld(w);
      const voucherId = await transferVoucher(w);
      const item = { stockItemId: t.itemId, quantity: "1", rate: "2", sourceLocationId: t.source };
      const cases: [Record<string, unknown>, number, RegExp][] = [
        [{ destinationLocationId: t.destination }, 400, /Either voucherId or sourceLocationId/],
        [{ voucherId, items: [item] }, 400, /Destination location is required/],
        [{ voucherId, destinationLocationId: t.destination }, 400, /Items are required/],
        [{ voucherId, destinationLocationId: 2_000_000_000, items: [item] }, 404, /Destination location not found/],
        [{ voucherId: 2_000_000_000, destinationLocationId: t.destination, items: [item] }, 404, /Voucher not found/],
        [{ voucherId, destinationLocationId: t.destination, items: [{ ...item, sourceLocationId: 0 }] }, 400, /./],
        [
          { voucherId, destinationLocationId: t.destination, items: [{ ...item, stockItemId: 0 }] },
          400,
          /Stock item ID/,
        ],
        [
          { voucherId, destinationLocationId: t.destination, items: [{ ...item, quantity: "-1" }] },
          400,
          /Quantity must be/,
        ],
        [{ voucherId, destinationLocationId: t.destination, items: [{ ...item, rate: "-1" }] }, 400, /Rate must be/],
        [{ voucherId, destinationLocationId: t.source, items: [item] }, 400, /must be different for each item/],
        [
          { voucherId, destinationLocationId: t.destination, items: [{ ...item, sourceLocationId: 2_000_000_000 }] },
          404,
          /Source location with ID/,
        ],
      ];
      for (const [body, status, message] of cases) {
        const res = await w.agent.post("/api/stock-transfers").send(body);
        expect(res.status, JSON.stringify(body) + res.text).toBe(status);
        expect(res.body.message).toMatch(message);
      }
      expect(await state(w)).toEqual(UNCHANGED);
    });
  });

  it("refuses another company's voucher, destination and source", async () => {
    await withFactoryWorld(async (w) => {
      const t = await transferWorld(w);
      const mine = await transferVoucher(w);
      const theirs = await transferVoucher(w, t.foreignCompany);
      const item = { stockItemId: t.itemId, quantity: "1", rate: "2", sourceLocationId: t.source };
      const foreignVoucher = await w.agent
        .post("/api/stock-transfers")
        .send({ voucherId: theirs, destinationLocationId: t.destination, items: [item] });
      expect(foreignVoucher.status).toBe(400);
      expect(foreignVoucher.body.code).toBe("STOCK_TRANSFER_SCOPE_INVALID");
      for (const body of [
        { voucherId: mine, destinationLocationId: t.foreignLocation, items: [item] },
        {
          voucherId: mine,
          destinationLocationId: t.destination,
          items: [{ ...item, sourceLocationId: t.foreignLocation }],
        },
      ]) {
        const res = await w.agent.post("/api/stock-transfers").send(body);
        expect(`${res.status} ${res.body.code}`).toBe("400 STOCK_TRANSFER_SCOPE_INVALID");
      }
      expect(await state(w)).toEqual(UNCHANGED);
    });
  });

  it("fills a zero rate from inventory and refuses a second transfer on the voucher", async () => {
    await withFactoryWorld(async (w) => {
      const t = await transferWorld(w);
      const voucherId = await transferVoucher(w);
      const body = {
        voucherId,
        destinationLocationId: t.destination,
        items: [{ stockItemId: t.itemId, quantity: "4", rate: "0", sourceLocationId: t.source }],
      };
      const res = await w.agent.post("/api/stock-transfers").send(body);
      expect(res.status, res.text).toBe(201);
      expect(Number(res.body.items[0].rate)).toBe(2);
      expect(await state(w)).toEqual({ transfers: 1, qty: 6 });
      const again = await w.agent.post("/api/stock-transfers").send(body);
      expect(again.status).toBe(409);
      expect(await state(w)).toEqual({ transfers: 1, qty: 6 });
    });
  });

  it("notifies the POS user's assigned location after a POS transfer onto a voucher", async () => {
    await withFactoryWorld(async (w) => {
      const t = await transferWorld(w);
      sendTransferWhatsApp.mockClear();
      const pos = await w.agentFor("POS");
      await w.q(`UPDATE user_company_roles SET assigned_location_id = $1 WHERE company_id = $2 AND role = 'POS'`, [
        t.destination,
        w.companyId,
      ]);
      const res = await pos.post("/api/stock-transfers").send({
        voucherId: await transferVoucher(w),
        destinationLocationId: t.destination,
        items: [{ stockItemId: t.itemId, quantity: "1", rate: "2", sourceLocationId: t.source }],
      });
      expect(res.status, res.text).toBe(201);
      await vi.waitFor(() => expect(sendTransferWhatsApp).toHaveBeenCalledTimes(1));
      expect(sendTransferWhatsApp.mock.calls[0][0]).toMatchObject({
        recipientLocationId: t.destination,
        sourceLocationName: "Yard",
        destLocationName: "Shop",
        items: [{ stockItemId: t.itemId, quantity: 1 }],
      });
    });
  });

  it("skips the notification for a POS user without an assigned location", async () => {
    await withFactoryWorld(async (w) => {
      const t = await transferWorld(w);
      sendTransferWhatsApp.mockClear();
      const warn = vi.spyOn(logger, "warn");
      const pos = await w.agentFor("POS");
      const res = await pos.post("/api/stock-transfers").send({
        voucherId: await transferVoucher(w),
        destinationLocationId: t.destination,
        items: [{ stockItemId: t.itemId, quantity: "1", rate: "2", sourceLocationId: t.source }],
      });
      expect(res.status, res.text).toBe(201);
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          "[TransferWA] POS user has no active assigned location; skipping notification",
          expect.anything()
        )
      );
      warn.mockRestore();
      expect(sendTransferWhatsApp).not.toHaveBeenCalled();
    });
  });
});
