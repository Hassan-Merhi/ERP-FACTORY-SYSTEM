/**
 * The Factory customer order analytics routes build their order filter,
 * including `co.company_id`, from interpolated fragments. The customer join must
 * carry the company scope too: a customer id belonging to another company must
 * never contribute its name to this company's analytics, even if an order row
 * points at it.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ session: {} as Record<string, unknown> }));

vi.mock("../server/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.session = harness.session;
    next();
  },
}));

import { pool } from "../server/db";
import { registerFactoryAnalyticsRoutes } from "../server/routes/factory/docs-users/analyticsRoutes";

const app = express();
app.use(express.json());
registerFactoryAnalyticsRoutes(app as any);

const tag = `CO-SCOPE-${process.pid}`;
let companyA = 0;
let companyB = 0;

async function maintenance<T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.company_scope_maintenance = 'on'");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertOrder(client: import("pg").PoolClient, companyId: number, customerId: number, article: string) {
  const order = await client.query<{ id: number }>(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status)
     VALUES ($1, $2, '2026-09-01', 'FINALIZED') RETURNING id`,
    [companyId, customerId]
  );
  await client.query(
    `INSERT INTO customer_order_lines
       (order_id, article_code, bale_name, qty, weight_per_bale, total_weight, price_per_bale, total_price)
     VALUES ($1, $2, $3, 1, 50, 50, 100, 100)`,
    [order.rows[0].id, article, article]
  );
}

beforeAll(async () => {
  await maintenance(async (client) => {
    const companies = await client.query<{ id: number }>(
      `INSERT INTO companies (code, name, company_type) VALUES ($1, 'Scope A', 'factory'), ($2, 'Scope B', 'factory')
       RETURNING id`,
      [`${tag}-A`, `${tag}-B`]
    );
    [companyA, companyB] = companies.rows.map((row) => row.id);
    const own = await client.query<{ id: number }>(
      `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Own Customer') RETURNING id`,
      [companyA, `${tag}-OWN`]
    );
    const foreign = await client.query<{ id: number }>(
      `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Foreign Customer') RETURNING id`,
      [companyB, `${tag}-FOREIGN`]
    );
    await insertOrder(client, companyA, own.rows[0].id, `${tag}-OWN-ART`);
    // An order row that points at another company's customer (integrity drift).
    await insertOrder(client, companyA, foreign.rows[0].id, `${tag}-DRIFT-ART`);
  });
});

afterAll(async () => {
  await maintenance(async (client) => {
    await client.query(
      `DELETE FROM customer_order_lines WHERE order_id IN (SELECT id FROM customer_orders WHERE company_id = ANY($1))`,
      [[companyA, companyB]]
    );
    await client.query(`DELETE FROM customer_orders WHERE company_id = ANY($1)`, [[companyA, companyB]]);
    await client.query(`DELETE FROM customers WHERE company_id = ANY($1)`, [[companyA, companyB]]);
    await client.query(`DELETE FROM companies WHERE id = ANY($1)`, [[companyA, companyB]]);
  });
});

describe("Factory customer order analytics company scope", () => {
  it("names this company's customers and never another company's", async () => {
    harness.session = { factoryCompanyId: companyA };
    const response = await request(app).get("/api/factory/analytics/customer-order-items?status=all");
    expect(response.status).toBe(200);

    const names = (response.body.rows as Array<{ customerBreakdown: Array<{ customerName: string | null }> }>).flatMap(
      (row) => row.customerBreakdown.map((entry) => entry.customerName)
    );
    expect(names).toContain("Own Customer");
    expect(names).not.toContain("Foreign Customer");
  });

  it("keeps the customer-grouped invoice view to this company's customers", async () => {
    harness.session = { factoryCompanyId: companyA };
    const response = await request(app).get("/api/factory/analytics/customer-orders?status=all");
    expect(response.status).toBe(200);

    const names = (response.body.rows as Array<{ customerName: string | null }>).map((row) => row.customerName);
    expect(names).toContain("Own Customer");
    expect(names).not.toContain("Foreign Customer");
  });
});
