/**
 * Location cost-price and inventory imports
 * (server/routes/inventory-movement/location-imports.ts), one rolled-back
 * transaction per test through the full HTTP stack.
 *
 * Pinned: bad ids, unknown and other-company locations, malformed bodies and
 * the perpetual-inventory cut-over refuse without touching inventory; the
 * pre-cut-over import resolves items by code, alias, session registry, name
 * match (registering the barcode as an alias) and stock-group prefix, adds to
 * existing rows and reports rows it cannot place.
 */
import { describe, expect, it } from "vitest";

import { registerLocationImportRoutes } from "../server/routes/inventory-movement/location-imports";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function item(w: FactoryWorld, code: string, name = code, groupId: number | null = null) {
  return w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, active, stock_group_id) VALUES ($1, $2, $3, 'PCS', true, $4) RETURNING id`,
    [w.companyId, code, name, groupId]
  );
}

async function group(w: FactoryWorld, code: string) {
  return w.one(`INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2::varchar, $2::text) RETURNING id`, [
    w.companyId,
    code,
  ]);
}

async function inventory(w: FactoryWorld) {
  return w.q<{ code: string; quantity: string; total_value: string; average_rate: string }>(
    `SELECT si.code, i.quantity::numeric::text AS quantity, i.total_value::numeric::text AS total_value,
            i.average_rate::numeric::text AS average_rate
       FROM inventory i JOIN stock_items si ON si.id = i.stock_item_id
      WHERE i.company_id = $1 AND i.location_id = $2 ORDER BY si.code`,
    [w.companyId, w.locationId]
  );
}

async function otherLocation(w: FactoryWorld) {
  const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
    `${w.tag}O`,
  ]);
  return w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Other') RETURNING id`, [
    other,
    `${w.tag}OL`,
  ]);
}

async function cutover(w: FactoryWorld) {
  await w.q(
    `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, '2026-01-01', '{}'::jsonb, 'test')`,
    [w.companyId]
  );
}

describe("location cost-price import", () => {
  const url = (id: number | string) => `/api/locations/${id}/import-cost-prices`;

  it("refuses bad ids, unknown or foreign locations, bad bodies and non-admin roles", async () => {
    await withFactoryWorld(async (w) => {
      const foreign = await otherLocation(w);
      expect((await w.agent.post(url("abc")).send({ updates: [] })).status).toBe(400);
      expect((await w.agent.post(url(2_000_000_000)).send({ updates: [] })).status).toBe(404);
      const cross = await w.agent.post(url(foreign)).send({ updates: [] });
      expect(cross.status).toBe(404);
      const notArray = await w.agent.post(url(w.locationId)).send({ updates: { barcode: "x" } });
      expect(notArray.status).toBe(400);
      expect(notArray.body.message).toBe("Updates must be an array");
      const manager = await w.agentFor("Manager");
      expect((await manager.post(url(w.locationId)).send({ updates: [] })).status).toBe(403);
    });
  });

  it("updates cost prices before the cut-over and is refused after it", async () => {
    await withFactoryWorld(async (w) => {
      const id = await item(w, `${w.tag}CP`);
      await w.q(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value) VALUES ($1, $2, $3, 4, 1, 4)`,
        [w.companyId, w.locationId, id]
      );
      const ok = await w.agent.post(url(w.locationId)).send({
        updates: [
          { barcode: `${w.tag}CP`, costPrice: "2.5" },
          { barcode: "missing-code", costPrice: "1" },
          { barcode: `${w.tag}CP`, costPrice: "-1" },
        ],
      });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.body.updated).toBe(1);
      expect(ok.body.errors).toHaveLength(2);
      expect((await inventory(w))[0]).toMatchObject({ total_value: "10.00" });

      await cutover(w);
      const refused = await w.agent
        .post(url(w.locationId))
        .send({ updates: [{ barcode: `${w.tag}CP`, costPrice: "9" }] });
      expect(refused.status).toBe(409);
      expect((await inventory(w))[0]).toMatchObject({ total_value: "10.00" });
    });
  });
});

describe("location inventory import", () => {
  const url = (id: number | string) => `/api/locations/${id}/import-inventory`;

  it("refuses bad ids, unknown or foreign locations and non-array items without writing", async () => {
    await withFactoryWorld(async (w) => {
      const foreign = await otherLocation(w);
      const row = [{ Item_barcode: "X1", quantity: 1, rate: 1 }];
      expect((await w.agent.post(url("abc")).send({ items: row })).status).toBe(400);
      expect((await w.agent.post(url(2_000_000_000)).send({ items: row })).status).toBe(404);
      expect((await w.agent.post(url(foreign)).send({ items: row })).status).toBe(404);
      const notArray = await w.agent.post(url(w.locationId)).send({ items: "nope" });
      expect(notArray.status).toBe(400);
      expect(notArray.body.message).toBe("Items must be an array");
      expect(await inventory(w)).toEqual([]);
    });
  });

  it("requires an import kind after the cut-over and keeps opening imports for owners", async () => {
    await withFactoryWorld(async (w) => {
      await cutover(w);
      const row = [{ Item_barcode: "X1", quantity: 1, rate: 1 }];
      const noKind = await w.agent.post(url(w.locationId)).send({ items: row });
      expect(noKind.status).toBe(400);
      expect(noKind.body.code).toBe("INVENTORY_IMPORT_KIND_REQUIRED");
      const opening = await w.agent.post(url(w.locationId)).send({ items: row, importKind: "opening" });
      expect(opening.status).toBe(403);
      expect(opening.body.code).toBe("OPENING_STOCK_IMPORT_OWNER_ONLY");
      expect(await inventory(w)).toEqual([]);
    });
  });

  it("resolves items by code, alias, name, group prefix and fallback group, and reports what it cannot place", async () => {
    await withFactoryWorld(async (w) => {
      const gcc = await group(w, "GCC");
      await group(w, "UN");
      await group(w, `F${w.tag}`);
      const existing = await item(w, `${w.tag}EX`);
      await w.q(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value) VALUES ($1, $2, $3, 2, 3, 6)`,
        [w.companyId, w.locationId, existing]
      );
      const named = await item(w, `${w.tag}NM`, "blue widget");
      // An item whose name equals another item's code: the name match is
      // reused for the existing coded item instead of registering an alias.
      await item(w, `${w.tag}CODE2`, `${w.tag}DUP`, gcc);
      await item(w, `${w.tag}DUP`.toLowerCase() + "x", "unrelated");

      const res = await w.agent.post(url(w.locationId)).send({
        items: [
          { Item_barcode: `${w.tag}EX`, quantity: 3, rate: 3 },
          { Item_barcode: ` ${w.tag}ex `, quantity: 1, rate: 3, value: "4" },
          { Item_barcode: "Blue Widget", quantity: 5, rate: 2 },
          { Item_barcode: "GCC777", quantity: 1, rate: 10 },
          { Item_barcode: "UN259", quantity: 2, rate: 1 },
          { Item_barcode: "ZZ1", quantity: 1, rate: 1, stockGroupCode: `f${w.tag}`.toLowerCase() },
          { Item_barcode: "Q", quantity: 1, rate: 1 },
          { Item_barcode: "QQ9", quantity: 1, rate: 1, stockGroupCode: "nope" },
          { code: "no-barcode", quantity: 1 },
        ],
      });
      expect(res.status, res.text).toBe(200);
      const { results } = res.body;
      expect(results.updated.map((u: { code: string }) => u.code.trim())).toEqual([`${w.tag}EX`, `${w.tag}ex`]);
      expect(results.updated[1].newQuantity).toBe(6);
      expect(results.created.map((c: { code: string }) => c.code)).toEqual(["Blue Widget", "GCC777", "UN259", "ZZ1"]);
      expect(results.errors.map((e: { code: string }) => e.code)).toEqual(["Q", "QQ9", "no-barcode"]);
      expect(res.body.message).toBe("Import completed: 4 created, 2 updated, 0 skipped, 3 errors");

      const aliases = await w.q(`SELECT alias_code FROM stock_item_code_aliases WHERE stock_item_id = $1`, [named]);
      expect(aliases.map((a) => a.alias_code)).toEqual(["Blue Widget"]);
      const rows = await inventory(w);
      expect(rows.find((r) => r.code === `${w.tag}EX`)).toMatchObject({ quantity: "6.000" });
      expect(rows.find((r) => r.code === `${w.tag}NM`)).toMatchObject({ quantity: "5.000" });
      const groups = await w.q(
        `SELECT si.code, sg.code AS group_code FROM stock_items si JOIN stock_groups sg ON sg.id = si.stock_group_id
          WHERE si.company_id = $1 AND si.code IN ('GCC777', 'UN259', 'ZZ1') ORDER BY si.code`,
        [w.companyId]
      );
      expect(groups.map((g) => g.group_code)).toEqual(["GCC", "UN", `F${w.tag}`]);
    });
  });

  it("is refused to read-only and POS roles, while Manager may import (no role guard of its own)", async () => {
    await withFactoryWorld(async (w) => {
      await item(w, `${w.tag}RL`);
      const out: string[] = [];
      for (const role of ["View Only", "Create Only", "POS", "Manager"]) {
        const agent = await w.agentFor(role);
        const res = await agent
          .post(url(w.locationId))
          .send({ items: [{ Item_barcode: `${w.tag}RL`, quantity: 1, rate: 1 }] });
        out.push(`${role}=${res.status}`);
        if (role !== "Manager") expect(await inventory(w)).toEqual([]);
      }
      expect(out).toEqual(["View Only=403", "Create Only=403", "POS=403", "Manager=200"]);
    });
  });

  it("drives an item to zero quantity with a zero average rate", async () => {
    await withFactoryWorld(async (w) => {
      const id = await item(w, `${w.tag}NEG`);
      await w.q(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value) VALUES ($1, $2, $3, 2, 1, 2)`,
        [w.companyId, w.locationId, id]
      );
      const res = await w.agent
        .post(url(w.locationId))
        .send({ items: [{ Item_barcode: `${w.tag}NEG`, quantity: -2, rate: 1 }] });
      expect(res.status, res.text).toBe(200);
      expect(res.body.results.updated[0]).toMatchObject({ newQuantity: 0 });
      expect(Number((await inventory(w))[0].average_rate)).toBe(0);
    });
  });
});

// In the app, guards before the handlers (location-access middleware) answer
// bad, unknown and other-company location ids, so the handlers' own
// defence-in-depth refusals are pinned by invoking them directly with the
// world's real database.
type Handler = (req: unknown, res: unknown, next: () => void) => Promise<unknown> | unknown;
const handlers = new Map<string, Handler>();
registerLocationImportRoutes(
  new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (path: string, ...chain: Handler[]) =>
          handlers.set(`${method.toUpperCase()} ${path}`, chain[chain.length - 1]),
    }
  ) as never
);

async function direct(route: string, locationId: string, session: Record<string, unknown>, body: unknown) {
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
  const req = { params: { locationId }, session, body, headers: {}, user: { role: "Admin" } };
  await handlers.get(route)!(req, res, () => undefined);
  return { status, body: payload };
}

describe("location import handlers' own refusals", () => {
  const routes = [
    "POST /api/locations/:locationId/import-cost-prices",
    "POST /api/locations/:locationId/import-inventory",
  ];

  it("refuse bad ids, no company, unknown and other-company locations", async () => {
    await withFactoryWorld(async (w) => {
      const foreign = await otherLocation(w);
      const session = { currentCompanyId: w.companyId };
      for (const route of routes) {
        const body = { updates: [], items: [] };
        expect(await direct(route, "abc", session, body)).toMatchObject({ status: 400 });
        expect(await direct(route, String(w.locationId), {}, body)).toEqual({
          status: 400,
          body: { message: "No company selected" },
        });
        expect((await direct(route, "2000000000", session, body)).status).toBe(404);
        expect(await direct(route, String(foreign), session, body)).toEqual({
          status: 403,
          body: { message: "Access denied: Location belongs to a different company" },
        });
      }
    });
  });

  it("fall back to the user id and the computed value when username and value are absent", async () => {
    await withFactoryWorld(async (w) => {
      await item(w, `${w.tag}DV`);
      const session = { currentCompanyId: w.companyId, userId: w.userId };
      const res = await direct(routes[1], String(w.locationId), session, {
        items: [{ Item_barcode: `${w.tag}DV`, quantity: 2, rate: 4 }],
      });
      expect(res.status).toBe(200);
      expect((await inventory(w))[0]).toMatchObject({ total_value: "8.00" });
      const cost = await direct(
        routes[0],
        String(w.locationId),
        { currentCompanyId: w.companyId },
        { updates: [{ barcode: `${w.tag}DV`, costPrice: "5" }] }
      );
      expect(cost).toMatchObject({ status: 200, body: { updated: 1 } });
    });
  });
});
