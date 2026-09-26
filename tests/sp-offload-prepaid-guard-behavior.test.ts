/**
 * The SP offload prepaid guard runs before the mutating offload handler. Every
 * prepaid_used charge line must reference a prepaid charge owned by the active
 * supplier-partner company; the guard checks all referenced ids in one
 * company-scoped read and rejects the request before the handler runs if any id
 * is missing or belongs to another company.
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
import { registerSpOffloadPrepaidCompanyGuard } from "../server/routes/sp/spOffloadPrepaidCompanyGuard";

const app = express();
app.use(express.json());
registerSpOffloadPrepaidCompanyGuard(app as any);
// Stand-in for the legacy offload handler: reaching it means the guard passed.
app.post("/api/sp/offload", (_req, res) => res.status(299).json({ reachedHandler: true }));

const tag = `SP-PREPAID-GUARD-${process.pid}`;
let companyA = 0;
let companyB = 0;
let ownPrepaid = 0;
let secondOwnPrepaid = 0;
let foreignPrepaid = 0;

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

async function insertPrepaid(client: import("pg").PoolClient, companyId: number): Promise<number> {
  const row = await client.query<{ id: number }>(
    `INSERT INTO sp_prepaid_charges (company_id, charge_type, amount_paid_usd, notes)
     VALUES ($1, 'freight', 100, $2) RETURNING id`,
    [companyId, tag]
  );
  return row.rows[0].id;
}

function offload(chargeLines: unknown[]) {
  return request(app).post("/api/sp/offload").send({ chargeLines });
}

beforeAll(async () => {
  await maintenance(async (client) => {
    const companies = await client.query<{ id: number }>(
      `INSERT INTO companies (code, name, company_type)
       VALUES ($1, 'Prepaid Guard A', 'supplier_partner'), ($2, 'Prepaid Guard B', 'supplier_partner')
       RETURNING id`,
      [`${tag}-A`, `${tag}-B`]
    );
    [companyA, companyB] = companies.rows.map((row) => row.id);
    ownPrepaid = await insertPrepaid(client, companyA);
    secondOwnPrepaid = await insertPrepaid(client, companyA);
    foreignPrepaid = await insertPrepaid(client, companyB);
  });
  harness.session = { userId: "prepaid-guard-user", currentCompanyId: companyA };
});

afterAll(async () => {
  await maintenance(async (client) => {
    await client.query(`DELETE FROM sp_prepaid_charges WHERE notes = $1`, [tag]);
    await client.query(`DELETE FROM companies WHERE code = ANY($1::text[])`, [[`${tag}-A`, `${tag}-B`]]);
  });
});

describe("SP offload prepaid company guard", () => {
  it("lets requests through when every prepaid charge belongs to the active company", async () => {
    const res = await offload([
      { chargeType: "prepaid_used", prepaidChargeId: ownPrepaid },
      { chargeType: "prepaid_used", prepaidChargeId: String(secondOwnPrepaid) },
      { chargeType: "prepaid_used", prepaidChargeId: ownPrepaid },
      { chargeType: "paid_now" },
    ]);
    expect(res.status).toBe(299);
    expect(res.body).toEqual({ reachedHandler: true });
  });

  it("rejects a prepaid charge owned by another company before the handler runs", async () => {
    const res = await offload([
      { chargeType: "prepaid_used", prepaidChargeId: ownPrepaid },
      { chargeType: "prepaid_used", prepaidChargeId: foreignPrepaid },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(`Prepaid charge #${foreignPrepaid} not found for this company`);
  });

  it("rejects a prepaid charge id that does not exist", async () => {
    const missing = foreignPrepaid + 1_000_000;
    const res = await offload([{ chargeType: "prepaid_used", prepaidChargeId: missing }]);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(`Prepaid charge #${missing} not found for this company`);
  });

  it("rejects malformed prepaid references", async () => {
    const res = await offload([{ chargeType: "prepaid_used", prepaidChargeId: "12abc" }]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/prepaidChargeId is required/);
  });

  it("passes requests that use no prepaid charges", async () => {
    const res = await offload([{ chargeType: "paid_now" }]);
    expect(res.status).toBe(299);
  });
});
