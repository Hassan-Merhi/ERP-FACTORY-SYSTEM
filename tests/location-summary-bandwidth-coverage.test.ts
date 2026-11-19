/**
 * The bandwidth profiles of GET /api/location-summary (summary, group and the
 * sparse full contract) against PostgreSQL in one rolled-back transaction per
 * test: empty location filters, group validation, ungrouped items, inactive
 * groups and deleted items left out, zero rows dropped, stored values summed,
 * and a database failure reported as 500.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { nextSeq } from "./helpers/voucherReadFixture";

const summary = (w: FactoryWorld, query: Record<string, string>) => w.agent.get("/api/location-summary").query(query);

async function world(w: FactoryWorld) {
  const shop = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`, [
    w.companyId,
    `${w.tag}SH`,
  ]);
  const group = (name: string, active = true) =>
    w.one(`INSERT INTO stock_groups (company_id, code, name, active) VALUES ($1, $2, $3, $4) RETURNING id`, [
      w.companyId,
      `${w.tag}G${nextSeq()}`,
      name,
      active,
    ]);
  const coats = await group("Coats");
  const hidden = await group("Hidden", false);
  const item = (name: string, groupId: number | null, deleted = false) =>
    w.one(
      `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id, deleted_at)
       VALUES ($1, $2, $3, 'PCS', $4, $5) RETURNING id`,
      [w.companyId, `${w.tag}-I${nextSeq()}`, name, groupId, deleted ? new Date() : null]
    );
  const stock = (location: number, itemId: number, qty: string, value: string) =>
    w.q(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, total_value, average_rate)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4::numeric = 0 THEN 0 ELSE $5::numeric / $4::numeric END)`,
      [w.companyId, location, itemId, qty, value]
    );
  const coat = await item("Coat", coats);
  const jacket = await item("Jacket", coats);
  const loose = await item("Loose", null);
  const secret = await item("Secret", hidden);
  const gone = await item("Gone", coats, true);
  await stock(w.locationId, coat, "4", "40");
  await stock(shop, coat, "1", "12");
  await stock(w.locationId, jacket, "0", "0");
  await stock(shop, loose, "2", "6");
  await stock(w.locationId, secret, "5", "50");
  await stock(w.locationId, gone, "5", "50");
  return { shop, coats, coat, loose, locations: `${w.locationId},${shop},${shop},x,-1` };
}

describe("location summary bandwidth profiles", () => {
  it("returns empty shapes without locations and refuses a bad or unknown group", async () => {
    await withFactoryWorld(async (w) => {
      expect((await summary(w, { profile: "summary", asOfDate: "2026-01-31" })).body).toEqual({
        stockGroups: [],
        grandTotals: {},
        asOfDate: "2026-01-31",
      });
      expect((await summary(w, { profile: "group", groupId: "1" })).body).toEqual({ groupId: null, items: [] });
      const full = await summary(w, { locationIds: "abc" });
      expect(full.body.stockGroups).toEqual([]);
      expect(typeof full.body.asOfDate).toBe("string");
      const noGroup = await summary(w, { profile: "group", locationIds: String(w.locationId), groupId: "-2" });
      expect([noGroup.status, noGroup.body.message]).toEqual([400, "groupId is required for profile=group"]);
      const unknown = await summary(w, { profile: "group", locationIds: String(w.locationId), groupId: "2147483000" });
      expect(unknown.status).toBe(404);
    });
  });

  it("totals active groups per location from stored values and skips zero, hidden and deleted rows", async () => {
    await withFactoryWorld(async (w) => {
      const { shop, coats, locations } = await world(w);
      const res = await summary(w, { profile: "summary", locationIds: locations, asOfDate: "2026-02-01" });
      expect(res.status).toBe(200);
      expect(res.headers["x-erp-payload-profile"]).toBe("location-summary-groups");
      expect(res.body.stockGroups.map((g: { id: number; name: string }) => [g.id, g.name])).toEqual([
        [coats, "Coats"],
        [0, "Ungrouped Items"],
      ]);
      expect(res.body.stockGroups[0].locationData[w.locationId]).toEqual({ quantity: 4, value: 40, rate: 10 });
      expect(res.body.grandTotals[shop]).toEqual({ quantity: 3, value: 18, rate: 6 });
      expect(res.body.asOfDate).toBe("2026-02-01");
    });
  });

  it("lists one group's items, or the ungrouped items, with per-location cells", async () => {
    await withFactoryWorld(async (w) => {
      const { shop, coats, coat, loose, locations } = await world(w);
      const group = await summary(w, { profile: "group", locationIds: locations, groupId: String(coats) });
      expect(group.headers["x-erp-payload-profile"]).toBe("location-summary-group-items");
      expect(group.body.groupId).toBe(coats);
      expect(group.body.items).toEqual([
        expect.objectContaining({
          id: coat,
          name: "Coat",
          locationData: {
            [w.locationId]: { quantity: 4, rate: 10, value: 40 },
            [shop]: { quantity: 1, rate: 12, value: 12 },
          },
        }),
      ]);
      const ungrouped = await summary(w, { profile: "group", locationIds: locations, groupId: "0" });
      expect(ungrouped.body.items.map((i: { id: number }) => i.id)).toEqual([loose]);
    });
  });

  it("returns the sparse full contract with group, item and grand totals", async () => {
    await withFactoryWorld(async (w) => {
      const { shop, coats, coat, locations } = await world(w);
      const res = await summary(w, { profile: "", locationIds: locations });
      expect(res.headers["x-erp-payload-profile"]).toBe("location-summary-full-sparse");
      const [coatsGroup, ungrouped] = res.body.stockGroups;
      expect(coatsGroup).toMatchObject({ id: coats, code: expect.any(String) });
      expect(coatsGroup.items.map((i: { id: number }) => i.id)).toEqual([coat]);
      expect(coatsGroup.locationData[shop]).toEqual({ quantity: 1, value: 12, rate: 12 });
      expect(ungrouped).toMatchObject({ id: 0, code: "UNGROUPED", name: "Ungrouped Items" });
      expect(res.body.grandTotals[w.locationId]).toEqual({ quantity: 4, value: 40, rate: 10 });
    });
  });

  it("keeps blank group labels, gives negative stock a zero rate and leaves unknown profiles to the legacy route", async () => {
    await withFactoryWorld(async (w) => {
      const blank = await w.one(`INSERT INTO stock_groups (company_id, code, name) VALUES ($1, '', '') RETURNING id`, [
        w.companyId,
      ]);
      const short = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id) VALUES ($1, $2, 'Short', 'PCS', $3) RETURNING id`,
        [w.companyId, `${w.tag}-NEG`, blank]
      );
      await w.q(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, total_value, average_rate)
         VALUES ($1, $2, $3, -2, -10, 5)`,
        [w.companyId, w.locationId, short]
      );
      for (const profile of ["summary", "full"]) {
        const res = await summary(w, { profile, locationIds: String(w.locationId), asOfDate: "" });
        expect(res.body.stockGroups[0]).toMatchObject({ id: blank, code: "", name: "" });
        expect(res.body.grandTotals[w.locationId]).toEqual({ quantity: -2, value: -10, rate: 0 });
        expect(res.body.asOfDate).not.toBe("");
      }
      const legacy = await summary(w, { profile: "bogus", locationIds: String(w.locationId) });
      expect(legacy.headers["x-erp-payload-profile"]).toBeUndefined();
    });
  });

  it("reports a database failure as 500", async () => {
    await withFactoryWorld(async (w) => {
      const res = await summary(w, { profile: "summary", locationIds: "99999999999" });
      expect(res.status).toBe(500);
    });
  });
});
