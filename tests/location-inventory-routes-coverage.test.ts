/**
 * Location inventory routes (rates, list, Excel export, godown PDF and the
 * per-stock-group PDF) through the real app in one rolled-back transaction:
 * bad and unknown ids, another company's location, the rates request limits,
 * the light profile, historical dates in several formats, and the POS cost
 * rule (cost hidden or refused without inventory.cost.view, shown with it).
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

let seq = 0;

async function stock(w: FactoryWorld) {
  const groupId = await w.one(
    `INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, 'Rags & Co') RETURNING id`,
    [w.companyId, `${w.tag}G${++seq}`]
  );
  const item = (name: string, group: number | null) =>
    w.one(
      `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id) VALUES ($1, $2, $3, 'KG', $4) RETURNING id`,
      [w.companyId, `${w.tag}I${++seq}`, name, group]
    );
  const grouped = await item("Cream", groupId);
  const loose = await item("Loose", null);
  const empty = await item("Empty", groupId);
  const inv = (itemId: number, qty: string, rate: string) =>
    w.q(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
       VALUES ($1, $2, $3, $4, $5, $4::numeric * $5::numeric)`,
      [w.companyId, w.locationId, itemId, qty, rate]
    );
  await inv(grouped, "10", "2.5");
  await inv(loose, "4", "1");
  await inv(empty, "0", "3");
  return { groupId, grouped, loose, empty };
}

/** A POS user assigned to the world's location; `cost` keeps inventory.cost.view. */
async function posAgent(w: FactoryWorld, cost: boolean) {
  const agent = await w.agentFor("POS");
  const [user] = await w.q<{ id: string }>(
    `SELECT u.id FROM users u JOIN user_company_roles r ON r.user_id = u.id
      WHERE r.company_id = $1 AND r.role = 'POS' ORDER BY u.id DESC LIMIT 1`,
    [w.companyId]
  );
  await w.q(`INSERT INTO user_locations (user_id, company_id, location_id) VALUES ($1, $2, $3)`, [
    user.id,
    w.companyId,
    w.locationId,
  ]);
  if (!cost) {
    await w.q(
      `DELETE FROM user_security_permissions WHERE user_id = $1 AND company_id = $2 AND permission = 'inventory.cost.view'`,
      [user.id, w.companyId]
    );
  }
  return agent;
}

describe("location inventory routes", () => {
  it("refuses bad, unknown and other-company locations on every route", () =>
    withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const foreign = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`,
        [other, `${w.tag}FL`]
      );
      const paths = [
        "inventory-rates?stockItemIds=1",
        "inventory",
        "inventory/export",
        "inventory/pdf",
        "inventory/pdf/stock-group/none",
      ];
      for (const path of paths) {
        expect((await w.agent.get(`/api/locations/abc/${path}`)).status).toBe(400);
        expect((await w.agent.get(`/api/locations/2147483000/${path}`)).status).toBe(404);
        // Refused either by the location lookup or the company check.
        expect([403, 404]).toContain((await w.agent.get(`/api/locations/${foreign}/${path}`)).status);
      }
      expect((await w.agent.get(`/api/locations/${w.locationId}/inventory/pdf/stock-group/abc`)).status).toBe(400);
    }));

  it("answers rates within the request limits", () =>
    withFactoryWorld(async (w) => {
      const s = await stock(w);
      const url = `/api/locations/${w.locationId}/inventory-rates`;
      expect((await w.agent.get(url)).body.message).toBe("stockItemIds query parameter is required");
      expect((await w.agent.get(`${url}?stockItemIds=x,-1`)).body).toEqual([]);
      const many = Array.from({ length: 251 }, (_, i) => i + 1).join(",");
      expect((await w.agent.get(`${url}?stockItemIds=${many}`)).status).toBe(400);
      const res = await w.agent.get(`${url}?stockItemIds=${s.grouped},${s.grouped},${s.loose}`);
      expect(res.body.map((r: { stockItemName: string }) => r.stockItemName).sort()).toEqual(["Cream", "Loose"]);
    }));

  it("lists light, full and historical inventory", () =>
    withFactoryWorld(async (w) => {
      await stock(w);
      const base = `/api/locations/${w.locationId}/inventory`;
      const light = await w.agent.get(`${base}?profile=light&includePricing=true&includeZero=true`);
      expect(light.body).toHaveLength(3);
      expect(light.body[0]).toHaveProperty("averageRate");
      const plain = await w.agent.get(`${base}?profile=light`);
      expect(plain.body[0]).not.toHaveProperty("averageRate");
      expect((await w.agent.get(base)).status).toBe(200);
      for (const date of ["01/06/2026", "2026-06-01", "2026-06-01T10:00:00Z"]) {
        expect((await w.agent.get(`${base}?asOfDate=${encodeURIComponent(date)}`)).status).toBe(200);
      }
      expect((await w.agent.get(`${base}?asOfDate=notadate`)).body.message).toMatch(/Invalid asOfDate/);
    }));

  it("exports the inventory workbook and the godown and group PDFs", () =>
    withFactoryWorld(async (w) => {
      const s = await stock(w);
      const base = `/api/locations/${w.locationId}/inventory`;
      const xlsx = await w.agent.get(`${base}/export`);
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
      const pdf = await w.agent.get(`${base}/pdf`);
      expect([pdf.status, pdf.headers["content-disposition"]]).toEqual([
        200,
        expect.stringMatching(/_with_cost\.pdf"$/),
      ]);
      const noCost = await w.agent.get(`${base}/pdf?includeCost=0`);
      expect(noCost.headers["content-disposition"]).toMatch(/_no_cost\.pdf"$/);
      const group = await w.agent.get(`${base}/pdf/stock-group/${s.groupId}?includeCost=false`);
      expect(group.headers["content-disposition"]).toMatch(/_Rags___Co_/);
      const unassigned = await w.agent.get(`${base}/pdf/stock-group/none`);
      expect(unassigned.headers["content-disposition"]).toMatch(/_Unassigned_/);
      const emptyGroup = await w.one(
        `INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, 'Nothing') RETURNING id`,
        [w.companyId, `${w.tag}G${++seq}`]
      );
      expect((await w.agent.get(`${base}/pdf/stock-group/${emptyGroup}`)).status).toBe(404);
    }));

  it("hides or refuses cost for a POS user without inventory.cost.view", () =>
    withFactoryWorld(async (w) => {
      const s = await stock(w);
      const base = `/api/locations/${w.locationId}`;
      const pos = await posAgent(w, false);
      const rates = await pos.get(`${base}/inventory-rates?stockItemIds=${s.grouped}`);
      expect([rates.status, rates.body.code]).toEqual([403, "POS_INVENTORY_COST_FORBIDDEN"]);
      const list = await pos.get(`${base}/inventory`);
      expect(list.body.every((r: { averageRate: unknown }) => r.averageRate === null)).toBe(true);
      const light = await pos.get(`${base}/inventory?profile=light&includePricing=true`);
      expect(light.body[0].averageRate).toBeNull();
      expect((await pos.get(`${base}/inventory/pdf`)).status).toBe(403);
      expect((await pos.get(`${base}/inventory/pdf/stock-group/none`)).status).toBe(403);
      expect((await pos.get(`${base}/inventory/pdf/stock-group/none?includeCost=0`)).status).toBe(200);
      expect((await pos.get(`${base}/inventory/export`)).status).toBe(200);
    }));

  it("shows cost to a POS user granted inventory.cost.view", () =>
    withFactoryWorld(async (w) => {
      const s = await stock(w);
      const pos = await posAgent(w, true);
      const rates = await pos.get(`/api/locations/${w.locationId}/inventory-rates?stockItemIds=${s.grouped}`);
      expect(rates.status).toBe(200);
      const list = await pos.get(`/api/locations/${w.locationId}/inventory`);
      expect(list.body.some((r: { averageRate: unknown }) => r.averageRate !== null)).toBe(true);
    }));
});
