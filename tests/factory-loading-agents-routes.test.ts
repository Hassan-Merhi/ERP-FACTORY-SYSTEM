/**
 * Reusable loading agents on Factory Invoices
 * (POST and GET /api/factory/loading-agents, server/routes/factory/customer-orders/
 * registerOrderCrudRoutesPart3.ts), against the real database.
 *
 * Agents share Booking Info's visibility (Admin, Owner, Developer), belong to
 * one company, and are unique per company ignoring case: saving a name that
 * differs only in case returns the stored spelling instead of a duplicate.
 */
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db } from "../server/db";
import { registerOrderCrudRoutesPart3 } from "../server/routes/factory/customer-orders/registerOrderCrudRoutesPart3";

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

/** Keeps the final handler of each route; requireAuth is the session gate tested elsewhere. */
function routes() {
  const handlers = new Map<string, Handler>();
  const record =
    (method: string) =>
    (path: string, ...chain: unknown[]) => {
      if (!handlers.has(`${method} ${path}`)) handlers.set(`${method} ${path}`, chain.at(-1) as Handler);
    };
  registerOrderCrudRoutesPart3({
    get: record("GET"),
    post: record("POST"),
    put: record("PUT"),
    patch: record("PATCH"),
    delete: record("DELETE"),
  } as never);

  return async (method: "GET" | "POST", session: Record<string, unknown>, body: unknown = {}) => {
    const handler = handlers.get(`${method} /api/factory/loading-agents`);
    if (!handler) throw new Error(`${method} /api/factory/loading-agents is not registered`);
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(value: unknown) {
        res.body = value;
        return res;
      },
    };
    await handler({ session, body, params: {}, query: {}, headers: {}, get: () => undefined }, res);
    return { status: res.statusCode, body: res.body };
  };
}

// Company ids no test database holds; factory_loading_agents has no foreign key to companies.
const COMPANY = 990_000_000 + (process.pid % 100_000);
const OTHER_COMPANY = COMPANY + 1;
const owner = { factoryCompanyId: COMPANY, currentRole: "Owner", userId: "agent-test" };
const call = routes();

afterAll(async () => {
  await db.execute(sql`DELETE FROM factory_loading_agents WHERE company_id IN (${COMPANY}, ${OTHER_COMPANY})`);
});

describe("loading agents", () => {
  it("saves a trimmed name and lists the company's agents alphabetically, ignoring case", async () => {
    expect(await call("POST", owner, { name: "  Port Line  " })).toEqual({ status: 201, body: { name: "Port Line" } });
    expect(await call("POST", owner, { name: "coastal agency" })).toEqual({
      status: 201,
      body: { name: "coastal agency" },
    });

    expect(await call("GET", owner)).toEqual({ status: 200, body: ["coastal agency", "Port Line"] });
  });

  it("returns the stored spelling for a name that differs only in case, without a duplicate", async () => {
    expect(await call("POST", owner, { name: "PORT LINE" })).toEqual({ status: 201, body: { name: "Port Line" } });
    expect((await call("GET", owner)).body).toEqual(["coastal agency", "Port Line"]);
  });

  it("keeps each company's agents to itself", async () => {
    const other = { ...owner, factoryCompanyId: OTHER_COMPANY };
    expect(await call("GET", other)).toEqual({ status: 200, body: [] });
    await call("POST", other, { name: "Port Line" });
    expect((await call("GET", other)).body).toEqual(["Port Line"]);
    expect((await call("GET", owner)).body).toEqual(["coastal agency", "Port Line"]);
  });

  it("refuses a blank or over-long name", async () => {
    for (const name of ["", "   ", "x".repeat(201), 42]) {
      expect((await call("POST", owner, { name })).status).toBe(400);
    }
  });

  it("refuses roles that cannot see Booking Info, and a session with no company", async () => {
    for (const role of ["Manager", "Normal User", "POS"]) {
      const session = { ...owner, currentRole: role };
      expect(await call("GET", session)).toEqual({ status: 403, body: { message: "Not authorized" } });
      expect((await call("POST", session, { name: "Sneaky" })).status).toBe(403);
    }
    expect((await call("POST", { currentRole: "Owner" }, { name: "Nowhere" })).status).toBe(400);
    expect((await call("GET", owner)).body).not.toContain("Sneaky");
  });
});
