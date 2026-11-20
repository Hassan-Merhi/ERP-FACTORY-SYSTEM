/**
 * /api/factory/sheets-sacks through the real app inside one rolled-back
 * transaction: write access (page grant for non-admin roles), validation,
 * other-company items, restock/deduct arithmetic and its log, log filters,
 * and delete. Every refusal leaves the item and its log untouched.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/factory/sheets-sacks";

async function item(w: FactoryWorld, companyId = w.companyId, packQty: number | null = 4) {
  return w.one(
    `INSERT INTO factory_sheets_sacks (company_id, type, name, size, quantity, unit_price, pack_qty, pcs_per_pack)
     VALUES ($1, 'SACK', 'Sack 50kg', 'L', 100, '0.35', $2, 25) RETURNING id`,
    [companyId, packQty]
  );
}

const stateOf = async (w: FactoryWorld, id: number) => ({
  row: (await w.q(`SELECT quantity::text AS q, pack_qty, name FROM factory_sheets_sacks WHERE id = $1`, [id]))[0],
  logs: (await w.q(`SELECT count(*)::int AS n FROM factory_sheets_sacks_log WHERE item_id = $1`, [id]))[0].n,
});

describe("factory sheets and sacks", () => {
  it("refuses Manager writes with or without the page grant", () =>
    withFactoryWorld(async (w) => {
      const id = await item(w);
      const before = await stateOf(w, id);
      const manager = await w.agentFor("Manager");
      for (const res of [
        await manager.post(BASE).send({ type: "SHEET", name: "x" }),
        await manager.patch(`${BASE}/${id}`).send({ name: "y" }),
        await manager.patch(`${BASE}/${id}/restock`).send({ pieces: 5 }),
        await manager.patch(`${BASE}/${id}/deduct`).send({ pieces: 5 }),
        await manager.delete(`${BASE}/${id}`),
      ]) {
        expect(res.status).toBe(403);
      }
      expect(await stateOf(w, id)).toEqual(before);

      const [user] = await w.q<{ id: string }>(
        `SELECT u.id FROM users u JOIN user_company_roles r ON r.user_id = u.id
          WHERE r.company_id = $1 AND r.role = 'Manager'`,
        [w.companyId]
      );
      await w.q(
        `INSERT INTO factory_user_page_access (user_id, company_id, page_key) VALUES ($1, $2, 'factory/sheets-sacks')`,
        [user.id, w.companyId]
      );
      // The page grant opens the reads; stock writes still need an Admin.
      expect((await manager.get(BASE)).status).toBe(200);
      const still = await manager.patch(`${BASE}/${id}/restock`).send({ pieces: 5 });
      expect(still.status).toBe(403);
      expect(still.body.requiresAdminOverride).toBe(true);
      expect(await stateOf(w, id)).toEqual(before);
    }));

  it("creates items, logging initial stock only when there is some", () =>
    withFactoryWorld(async (w) => {
      const missing = await w.agent.post(BASE).send({ type: "SHEET" });
      expect(missing.status).toBe(400);
      expect(missing.body.message).toBe("name and type are required");

      const stocked = await w.agent
        .post(BASE)
        .send({ type: "SHEET", name: "Sheet", quantity: 12, unitPrice: "0.105", packQty: "3", pcsPerPack: "4" });
      expect(stocked.status).toBe(201);
      expect(stocked.body).toMatchObject({ packQty: 3, pcsPerPack: 4, size: null });
      const [log] = await w.q(
        `SELECT action, pieces, packs, total_value::text AS total, notes FROM factory_sheets_sacks_log WHERE item_id = $1`,
        [stocked.body.id]
      );
      expect(log).toMatchObject({ action: "IN", pieces: 12, packs: 3, notes: "Initial stock" });

      const empty = await w.agent.post(BASE).send({ type: "SACK", name: "Empty", size: "S", rowColor: "#fff" });
      expect(empty.status).toBe(201);
      expect(empty.body).toMatchObject({ quantity: "0.000", packQty: null, rowColor: "#fff" });
      expect((await stateOf(w, empty.body.id)).logs).toBe(0);
    }));

  it("validates and scopes edits", () =>
    withFactoryWorld(async (w) => {
      const id = await item(w);
      const before = await stateOf(w, id);
      const bad: Array<[Record<string, unknown>, string]> = [
        [{ quantity: "lots" }, "quantity"],
        [{ unitPrice: "abc" }, "unitPrice"],
        [{ packQty: 1.5 }, "packQty"],
        [{ pcsPerPack: "x" }, "pcsPerPack"],
      ];
      for (const [body, field] of bad) {
        const res = await w.agent.patch(`${BASE}/${id}`).send(body);
        expect(res.status).toBe(400);
        expect(res.body.field).toBe(field);
      }
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const theirs = await item(w, other);
      const theirsBefore = await stateOf(w, theirs);
      expect((await w.agent.patch(`${BASE}/${theirs}`).send({ name: "mine" })).status).toBe(404);
      expect((await w.agent.patch(`${BASE}/${theirs}/restock`).send({ pieces: 1 })).status).toBe(404);
      expect((await w.agent.patch(`${BASE}/${theirs}/deduct`).send({ pieces: 1 })).status).toBe(404);
      expect((await w.agent.delete(`${BASE}/${theirs}`)).status).toBe(404);
      expect(await stateOf(w, theirs)).toEqual(theirsBefore);
      expect(await stateOf(w, id)).toEqual(before);

      const edit = await w.agent.patch(`${BASE}/${id}`).send({ name: "Renamed", quantity: "", unitPrice: 2 });
      expect(edit.status).toBe(200);
      expect(edit.body).toMatchObject({ name: "Renamed", quantity: "100.000", unitPrice: "2.00", packQty: null });
    }));

  it("restocks and deducts with pack counts, never below zero", () =>
    withFactoryWorld(async (w) => {
      const id = await item(w);
      expect((await w.agent.patch(`${BASE}/${id}/restock`).send({ pieces: 0 })).status).toBe(400);
      expect((await w.agent.patch(`${BASE}/${id}/deduct`).send({ pieces: "x" })).status).toBe(400);
      expect((await stateOf(w, id)).logs).toBe(0);

      const restock = await w.agent.patch(`${BASE}/${id}/restock`).send({ pieces: 50, packs: 2, notes: "truck" });
      expect(restock.body).toMatchObject({ quantity: "150.000", packQty: 6 });
      const deduct = await w.agent.patch(`${BASE}/${id}/deduct`).send({ pieces: 500, packs: 10 });
      expect(deduct.body).toMatchObject({ quantity: "0.000", packQty: 0 });

      const loose = await item(w, w.companyId, null);
      const r2 = await w.agent.patch(`${BASE}/${loose}/restock`).send({ pieces: 1, packs: 1 });
      expect(r2.body.packQty).toBeNull();
      const d2 = await w.agent.patch(`${BASE}/${loose}/deduct`).send({ pieces: 1 });
      expect(d2.body.quantity).toBe("100.000");

      const logs = await w.agent.get(`${BASE}/log`).query({ itemId: id, action: "OUT" });
      expect(logs.status).toBe(200);
      expect(logs.body).toEqual([expect.objectContaining({ action: "OUT", pieces: 500, totalValue: "175.0000" })]);
      const all = await w.agent.get(`${BASE}/log`).query({ action: "all", limit: "1", itemId: "abc" });
      expect(all.body).toHaveLength(1);
      const today = new Date().toISOString().slice(0, 10);
      const ranged = await w.agent.get(`${BASE}/log`).query({ from: today, to: today, itemId: id });
      expect(ranged.body.map((l: { action: string }) => l.action).sort()).toEqual(["IN", "OUT"]);
      const none = await w.agent.get(`${BASE}/log`).query({ from: "2000-01-01", to: "2000-01-02" });
      expect(none.body).toEqual([]);

      const list = await w.agent.get(BASE);
      expect(list.body.map((r: { id: number }) => r.id).sort()).toEqual([id, loose].sort((a, b) => a - b));
      expect((await w.agent.delete(`${BASE}/${id}`)).body).toEqual({ success: true });
      expect((await w.agent.delete(`${BASE}/${id}`)).status).toBe(404);
    }));
});
