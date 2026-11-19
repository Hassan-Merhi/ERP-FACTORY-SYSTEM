/**
 * POS "containers on the way" routes through the real app inside one
 * rolled-back transaction: location assignment refusals, shop matching (and
 * the single-POS-location exception for unassigned containers), the
 * POS-only departure-date write with its strict body and date rules, and the
 * container detail with PO line quantities. Refusals leave the row unchanged.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

type Agent = Awaited<ReturnType<FactoryWorld["agentFor"]>>;

/** A POS user assigned to `locationId` (or none), signed in with that assignment. */
async function posAgent(w: FactoryWorld, locationId: number | null): Promise<Agent> {
  const agent = await w.agentFor("POS");
  await w.q(
    `UPDATE user_company_roles SET assigned_location_id = $1
      WHERE company_id = $2 AND role = 'POS'
        AND user_id = (SELECT id FROM users WHERE username = (SELECT max(username) FROM users WHERE username LIKE $3))`,
    [locationId, w.companyId, `${w.tag.toLowerCase()}_u%`]
  );
  const set = await agent.post("/api/auth/set-company").send({ companyId: w.companyId });
  if (set.status !== 200) throw new Error(`set-company failed: ${set.status}`);
  return agent;
}

async function container(w: FactoryWorld, number: string, shopName: string | null, status = "OTW") {
  const supplierId = await w.one(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Mill', '') RETURNING id`,
    [w.companyId, `${w.tag}${number}`]
  );
  return w.one(
    `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, shop_name)
     VALUES ($1, $2, '2026-06-01', $3, $4, $5) RETURNING id`,
    [w.companyId, `${w.tag}${number}`, supplierId, status, shopName]
  );
}

const departure = async (w: FactoryWorld, id: number) =>
  (await w.q<{ d: string | null }>(`SELECT port_departure_date::text AS d FROM containers WHERE id = $1`, [id]))[0].d;

describe("POS containers on the way", () => {
  it("requires the POS role and an active assigned location", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get("/api/pos/containers-otw")).status).toBe(403);
      const unassigned = await posAgent(w, null);
      const res = await unassigned.get("/api/pos/containers-otw");
      expect(res.status).toBe(403);
      expect(res.body.message).toBe("No location is assigned to this POS user");

      const assigned = await posAgent(w, w.locationId);
      await w.q(`UPDATE locations SET active = false WHERE id = $1`, [w.locationId]);
      const inactive = await assigned.get("/api/pos/containers-otw");
      expect(inactive.status).toBe(403);
      expect(inactive.body.message).toBe("The assigned POS location is unavailable");
    }));

  it("lists only containers for the assigned shop, plus unassigned ones for a sole POS location", () =>
    withFactoryWorld(async (w) => {
      const mine = await container(w, "A", "  yard ");
      await container(w, "B", "Other Shop");
      const blank = await container(w, "C", null);
      await container(w, "D", "Yard", "Offloaded");
      const pos = await posAgent(w, w.locationId);
      const list = await pos.get("/api/pos/containers-otw");
      expect(list.status).toBe(200);
      expect(list.body.assignedLocation).toMatchObject({ id: w.locationId, name: "Yard" });
      expect(list.body.containers.map((c: { id: number }) => c.id).sort()).toEqual([mine, blank].sort());

      const second = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Depot') RETURNING id`,
        [w.companyId, `${w.tag}D2`]
      );
      await posAgent(w, second);
      const shared = await pos.get("/api/pos/containers-otw");
      expect(shared.body.containers.map((c: { id: number }) => c.id)).toEqual([mine]);
    }));

  it("shows container detail with PO quantities and refuses other shops", () =>
    withFactoryWorld(async (w) => {
      const mine = await container(w, "E", `${w.tag}L`);
      const other = await container(w, "F", "Elsewhere");
      const [{ supplier_id: supplierId }] = await w.q(`SELECT supplier_id FROM containers WHERE id = $1`, [mine]);
      const itemId = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bales', 'kg') RETURNING id`,
        [w.companyId, `${w.tag}SI`]
      );
      const otherCompany = await w.one(
        `INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`,
        [`${w.tag}X`]
      );
      const foreignItem = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Foreign', 'kg') RETURNING id`,
        [otherCompany, `${w.tag}FX`]
      );
      const poId = await w.one(
        `INSERT INTO purchase_orders (company_id, container_id, supplier_id, po_number, items_total, currency, status)
         VALUES ($1, $2, $3, $4, 0, 'USD', 'Open') RETURNING id`,
        [w.companyId, mine, supplierId, `${w.tag}PO`]
      );
      await w.q(
        `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
         VALUES ($1, $2, 'raw', 3, 1, 3), ($1, $3, '', 2.5, 1, 2.5)`,
        [poId, itemId, foreignItem]
      );
      const pos = await posAgent(w, w.locationId);
      expect((await pos.get("/api/pos/containers-otw/abc")).status).toBe(400);
      expect((await pos.get(`/api/pos/containers-otw/${other}`)).status).toBe(404);
      const detail = await pos.get(`/api/pos/containers-otw/${mine}`);
      expect(detail.status).toBe(200);
      expect(detail.body.items).toEqual([
        { itemName: "Bales", itemCode: `${w.tag}SI`, quantity: expect.any(String) },
        { itemName: "Item", itemCode: "", quantity: expect.any(String) },
      ]);
      expect(detail.body.totalQty).toBe(5.5);
      const empty = await container(w, "G", "Yard");
      expect((await pos.get(`/api/pos/containers-otw/${empty}`)).body).toMatchObject({ items: [], totalQty: 0 });
    }));

  it("lets only POS users set a valid, non-future departure date", () =>
    withFactoryWorld(async (w) => {
      const mine = await container(w, "H", "Yard");
      const other = await container(w, "I", "Elsewhere");
      const url = (id: number | string) => `/api/pos/containers-otw/${id}/departure-date`;
      expect((await w.agent.patch(url(mine)).send({ portDepartureDate: "2026-06-02" })).status).toBe(403);

      const pos = await posAgent(w, w.locationId);
      expect((await pos.patch(url("x")).send({ portDepartureDate: "2026-06-02" })).status).toBe(400);
      for (const body of [{}, { portDepartureDate: "2026-06-02", status: "Arrived" }, [1]]) {
        const res = await pos.patch(url(mine)).send(body);
        expect(res.body.message).toBe("Only portDepartureDate can be changed");
      }
      for (const value of ["2026-02-30", "06/02/2026", 20260602, "2999-01-01"]) {
        const res = await pos.patch(url(mine)).send({ portDepartureDate: value });
        expect(res.status, String(value)).toBe(400);
      }
      expect((await pos.patch(url(other)).send({ portDepartureDate: "2026-06-02" })).status).toBe(404);
      expect(await departure(w, other)).toBeNull();

      const saved = await pos.patch(url(mine)).send({ portDepartureDate: "2026-06-02" });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ id: mine });
      expect(await departure(w, mine)).toBe("2026-06-02");
      expect((await pos.patch(url(mine)).send({ portDepartureDate: null })).status).toBe(200);
      expect(await departure(w, mine)).toBeNull();

      const unassigned = await container(w, "J", null);
      expect((await pos.patch(url(unassigned)).send({ portDepartureDate: "2026-06-03" })).status).toBe(200);
      expect(await departure(w, unassigned)).toBe("2026-06-03");
    }));
});
