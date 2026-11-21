/**
 * Behavioural coverage for the search filter on the shipping-container row list.
 *
 * `GET /api/factory/shipping-container-rows?search=…` builds its WHERE clause as
 * text with numbered placeholders. The search clause once interpolated the
 * placeholder numbers without their `$`, so the query compared text columns to
 * a bare integer and every search answered 500.
 *
 * What is pinned:
 *
 *   - **A search answers 200** and returns only the rows that match.
 *   - **Search ignores separators and case**, the way the rest of the app's
 *     search does: `msku 123-4567` finds container `MSKU1234567`.
 *   - **Search composes with the other filters.** The placeholder numbers
 *     depend on which filters come first, so search is exercised after
 *     `isDone` and the date range as well as on its own.
 *   - **The pagination total counts the filtered rows**, because the count
 *     query shares the same WHERE clause.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "shipsearch";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let alphaRowId: number;
let betaRowId: number;

interface ListedRow {
  id: number;
  containerNumber: string | null;
  destination: string | null;
  isDone: boolean | null;
}

async function createOrder(customerId: number, containerNumber: string, destination: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, container_number, destination)
     VALUES ($1, $2, '2026-06-01', 'DRAFT', $3, $4) RETURNING id`,
    [ctx.companyId, customerId, containerNumber, destination]
  );
  return result.rows[0].id;
}

async function createRow(orderId: number, orderDate: string): Promise<number> {
  const response = await agent
    .post("/api/factory/shipping-container-rows")
    .send({ customerOrderId: orderId, orderDate });
  if (response.status !== 201) throw new Error(`Seed row failed: ${response.status} ${response.text}`);
  return response.body.id;
}

async function list(filters: Record<string, string>) {
  return agent.get(`/api/factory/shipping-container-rows?${new URLSearchParams(filters)}`);
}

function ids(body: ListedRow[]): number[] {
  return body.map((row) => row.id).sort((a, b) => a - b);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-CUST`, `${TEST_PREFIX} Customer`]
  );
  const customerId = customer.rows[0].id;

  alphaRowId = await createRow(await createOrder(customerId, "MSKU1234567", "Beirut"), "2026-06-01");
  betaRowId = await createRow(await createOrder(customerId, "TGHU7654321", "Tripoli"), "2026-07-15");
  const done = await agent.post(`/api/factory/shipping-container-rows/${betaRowId}/done`).send({});
  if (done.status !== 200) throw new Error(`Seed done failed: ${done.status} ${done.text}`);
}, 120000);

afterAll(async () => {
  await pool.query(`DELETE FROM factory_shipping_container_rows WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customer_orders WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM customers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("GET /api/factory/shipping-container-rows?search=", () => {
  it("returns only the rows whose container number matches", async () => {
    const response = await list({ search: "MSKU1234567" });

    expect(response.status).toBe(200);
    expect(ids(response.body)).toEqual([alphaRowId]);
  });

  it("matches a partial value in another searched column", async () => {
    const response = await list({ search: "tripo" });

    expect(response.status).toBe(200);
    expect(ids(response.body)).toEqual([betaRowId]);
  });

  it("ignores separators and case", async () => {
    const response = await list({ search: "msku 123-4567" });

    expect(response.status).toBe(200);
    expect(ids(response.body)).toEqual([alphaRowId]);
  });

  it("returns an empty list when nothing matches", async () => {
    const response = await list({ search: "no-such-container-anywhere" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("matches every row that shares the searched text", async () => {
    const response = await list({ search: `${TEST_PREFIX} Customer` });

    expect(response.status).toBe(200);
    expect(ids(response.body)).toEqual([alphaRowId, betaRowId].sort((a, b) => a - b));
  });

  it("composes with the done filter", async () => {
    const open = await list({ isDone: "false", search: `${TEST_PREFIX} Customer` });
    const done = await list({ isDone: "true", search: `${TEST_PREFIX} Customer` });

    expect(open.status).toBe(200);
    expect(ids(open.body)).toEqual([alphaRowId]);
    expect(done.status).toBe(200);
    expect(ids(done.body)).toEqual([betaRowId]);
  });

  it("composes with the done filter and the date range together", async () => {
    const response = await list({
      isDone: "true",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      search: "TGHU7654321",
    });
    const outsideRange = await list({
      isDone: "true",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      search: "TGHU7654321",
    });

    expect(response.status).toBe(200);
    expect(ids(response.body)).toEqual([betaRowId]);
    expect(outsideRange.status).toBe(200);
    expect(outsideRange.body).toEqual([]);
  });

  it("reports the filtered total in the pagination headers", async () => {
    const all = await list({});
    const searched = await list({ search: "MSKU1234567" });

    expect(all.status).toBe(200);
    expect(all.headers["x-total-count"]).toBe("2");
    expect(searched.headers["x-total-count"]).toBe("1");
  });
});
