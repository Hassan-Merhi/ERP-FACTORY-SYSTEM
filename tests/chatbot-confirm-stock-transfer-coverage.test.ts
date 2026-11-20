/**
 * POST /api/chatbot/confirm-stock-transfer (server/routes/chatbot/transactions.ts):
 * AI permission gate, revalidation of locations and items against the
 * session company, the optional-draft stock check, and the forward to
 * /api/stock-transfers (stubbed at the fetch boundary) with its audit row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const ROUTE = "/api/chatbot/confirm-stock-transfer";

// Restore only the fetch spy: the rolled-back pool routing is a spy too.
afterEach(() => {
  vi.mocked(globalThis.fetch).mockRestore?.();
});

async function seed(world: FactoryWorld) {
  await world.q(`UPDATE users SET chatbot_enabled = true WHERE id = $1`, [world.userId]);
  const dest = await world.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
    world.companyId,
    `${world.tag}D`,
  ]);
  const item = await world.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Shirt', 'pcs') RETURNING id`,
    [world.companyId, `${world.tag}I`]
  );
  const other = await world.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
    `${world.tag}X`,
  ]);
  const otherLocation = await world.one(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Foreign') RETURNING id`,
    [other, `${world.tag}XL`]
  );
  const otherItem = await world.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Foreign', 'pcs') RETURNING id`,
    [other, `${world.tag}XI`]
  );
  return { dest, item, otherLocation, otherItem };
}

function stubForward(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

describe("POST /api/chatbot/confirm-stock-transfer", () => {
  it("refuses users without the assistant and roles without AI write access", async () => {
    await withFactoryWorld(async (world) => {
      const res = await world.agent.post(ROUTE).send({});
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/not enabled/);

      await world.q(`UPDATE users SET chatbot_enabled = true WHERE id = $1`, [world.userId]);
      const worker = await world.agentFor("Factory Worker");
      await world.q(`UPDATE users SET chatbot_enabled = true WHERE username = $1`, [`${world.tag.toLowerCase()}_u1`]);
      const workerRes = await worker.post(ROUTE).send({});
      expect(workerRes.status).toBe(403);
      expect(workerRes.body.message).toMatch(/does not have permission to use AI write/);
    });
  });

  it("validates locations, items and quantities, including another company's ids", async () => {
    await withFactoryWorld(async (world) => {
      const { dest, item, otherLocation, otherItem } = await seed(world);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const post = (body: Record<string, unknown>) => world.agent.post(ROUTE).send(body);
      const base = { sourceLocationId: world.locationId, destinationLocationId: dest };

      expect((await post({ items: [{ stockItemId: item, quantity: 1 }] })).body.message).toMatch(/are required/);
      expect((await post({ ...base, items: [] })).body.message).toMatch(/At least one item/);
      const same = await post({ ...base, destinationLocationId: world.locationId, items: [{ stockItemId: item }] });
      expect(same.body.message).toMatch(/must be different/);

      const foreignSource = await post({ ...base, sourceLocationId: otherLocation, items: [{ stockItemId: item }] });
      expect(foreignSource.status).toBe(404);
      expect(foreignSource.body.message).toBe("Source location not found");
      const foreignDest = await post({ ...base, destinationLocationId: otherLocation, items: [{ stockItemId: item }] });
      expect(foreignDest.status).toBe(404);
      expect(foreignDest.body.message).toBe("Destination location not found");

      for (const bad of [
        { stockItemId: 0, quantity: 1 },
        { stockItemId: item, quantity: "x" },
        { stockItemId: item, quantity: 0 },
      ]) {
        const res = await post({ ...base, items: [bad] });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Invalid item or quantity/);
      }
      const foreignItem = await post({ ...base, items: [{ stockItemId: otherItem, quantity: 1 }] });
      expect(foreignItem.status).toBe(404);
      expect(foreignItem.body.message).toBe(`Stock item ${otherItem} not found`);

      const overdraw = await post({ ...base, optional: true, items: [{ stockItemId: item, quantity: 5 }] });
      expect(overdraw.status).toBe(400);
      expect(overdraw.body.message).toMatch(/exceeds available stock \(0\)/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("forwards an optional draft within stock and logs the AI action", async () => {
    await withFactoryWorld(async (world) => {
      const { dest, item } = await seed(world);
      await world.q(
        `INSERT INTO inventory (company_id, stock_item_id, location_id, quantity, average_rate, total_value)
         VALUES ($1, $2, $3, 10, 1, 10)`,
        [world.companyId, item, world.locationId]
      );
      const fetchSpy = stubForward(200, { voucher: { id: 77 }, transfer: { id: 55 } });
      const res = await world.agent.post(ROUTE).send({
        sourceLocationId: world.locationId,
        destinationLocationId: dest,
        optional: true,
        date: "2026-01-02",
        notes: "move",
        analysisSummary: "slow seller",
        items: [{ stockItemId: item, quantity: 4 }],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, transferId: 55, voucherId: 77, optional: true });
      const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
      expect(sent).toMatchObject({ optional: true, voucherDate: "2026-01-02", notes: "move" });
      expect(sent.items).toEqual([{ stockItemId: item, quantity: "4", sourceLocationId: world.locationId }]);
      const log = await world.q(
        `SELECT action_name, status, created_record_id FROM ai_action_log WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
        [world.userId]
      );
      expect(log[0]).toMatchObject({ action_name: "stock_transfer", status: "success" });
    });
  });

  it("forwards a direct transfer without a stock check, falling back to top-level ids", async () => {
    await withFactoryWorld(async (world) => {
      const { dest, item } = await seed(world);
      const fetchSpy = stubForward(200, { id: 9, voucherId: 8 });
      const res = await world.agent.post(ROUTE).send({
        sourceLocationId: world.locationId,
        destinationLocationId: dest,
        items: [{ stockItemId: item, quantity: 3 }],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ transferId: 9, voucherId: 8, optional: false });
      const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
      expect(sent.notes).toBe("");
      expect(sent.voucherDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it("passes through a refusal from the stock-transfer route and turns a network failure into 500", async () => {
    await withFactoryWorld(async (world) => {
      const { dest, item } = await seed(world);
      const body = {
        sourceLocationId: world.locationId,
        destinationLocationId: dest,
        items: [{ stockItemId: item, quantity: 1 }],
      };
      const fetchSpy = stubForward(422, { message: "Period locked" });
      const refused = await world.agent.post(ROUTE).send(body);
      expect(refused.status).toBe(422);
      expect(refused.body).toEqual({ message: "Period locked" });

      fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
      const failed = await world.agent.post(ROUTE).send(body);
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ message: "Internal server error" });
      const logs = await world.q(`SELECT 1 FROM ai_action_log WHERE user_id = $1`, [world.userId]);
      expect(logs).toHaveLength(0);
    });
  });
});
