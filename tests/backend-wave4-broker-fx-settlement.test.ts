/**
 * Wave 4 — broker bulk FX settlement against real PostgreSQL rows
 * (POST /api/factory/suppliers/:brokerId/bulk-fx-settlement).
 *
 * A broker pays one foreign-currency amount for several linked suppliers. The
 * route spreads it greedily, oldest container first, up to each supplier's
 * outstanding balance in that currency (container value, minus payments and
 * earlier FX transfers; freight counts only when priced in the same currency),
 * books any excess to the last supplier as an overpayment, and records
 * container-level allocations. Dry runs must not write.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "w4brokerfx";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let brokerId: number;
let olderSupplierId: number;
let newerSupplierId: number;
let idleSupplierId: number;
let olderContainerId: number;

async function supplier(name: string, parentId: number | null, isActive = true) {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_suppliers (company_id, name, parent_id, is_active, is_broker)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ctx.companyId, name, parentId, isActive, parentId === null]
  );
  return result.rows[0].id;
}

async function container(fields: {
  supplierId: number;
  number: string;
  status: string;
  kg: string;
  rate: string;
  currency: string;
  arrival: string;
  freight?: string;
  freightCurrency?: string;
}) {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO factory_containers
       (company_id, supplier_id, container_number, status, total_kg, rate_per_kg, currency_code,
        arrival_date, freight, freight_currency_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      ctx.companyId,
      fields.supplierId,
      fields.number,
      fields.status,
      fields.kg,
      fields.rate,
      fields.currency,
      fields.arrival,
      fields.freight ?? "0",
      fields.freightCurrency ?? fields.currency,
    ]
  );
  return result.rows[0].id;
}

async function transfersFor(supplierId: number) {
  const result = await pool.query<{ id: number; from_amount: string; to_amount_usd: string; to_supplier_id: number }>(
    `SELECT id, from_amount, to_amount_usd, to_supplier_id FROM factory_supplier_fx_transfers
      WHERE company_id = $1 AND from_supplier_id = $2 ORDER BY id`,
    [ctx.companyId, supplierId]
  );
  return result.rows;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app) as request.SuperAgentTest;
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`set-company failed: ${selected.status} ${selected.text}`);

  brokerId = await supplier(`${PREFIX} Broker`, null);
  olderSupplierId = await supplier(`${PREFIX} Older`, brokerId);
  newerSupplierId = await supplier(`${PREFIX} Newer`, brokerId);
  idleSupplierId = await supplier(`${PREFIX} Idle`, brokerId, false);

  // Older supplier: 1000 AUD of goods (+ USD freight that must not count toward AUD), 200 AUD already paid.
  olderContainerId = await container({
    supplierId: olderSupplierId,
    number: `${PREFIX}-OLD`,
    status: "OFFLOADED",
    kg: "1000",
    rate: "1",
    currency: "AUD",
    arrival: "2026-05-01",
    freight: "100",
    freightCurrency: "USD",
  });
  await pool.query(
    `INSERT INTO factory_supplier_payments (company_id, supplier_id, date, amount, currency_code, fx_rate_to_usd, amount_usd)
     VALUES ($1, $2, '2026-05-10', '200', 'AUD', '0.66', '132')`,
    [ctx.companyId, olderSupplierId]
  );
  // Newer supplier: 500 AUD received, plus a pending container that is not yet payable.
  await container({
    supplierId: newerSupplierId,
    number: `${PREFIX}-NEW`,
    status: "RECEIVED",
    kg: "250",
    rate: "2",
    currency: "AUD",
    arrival: "2026-06-01",
  });
  await container({
    supplierId: newerSupplierId,
    number: `${PREFIX}-PEND`,
    status: "PENDING",
    kg: "999",
    rate: "9",
    currency: "AUD",
    arrival: "2026-06-02",
  });
  // Inactive supplier with a payable container is ignored.
  await container({
    supplierId: idleSupplierId,
    number: `${PREFIX}-IDLE`,
    status: "OFFLOADED",
    kg: "100",
    rate: "1",
    currency: "AUD",
    arrival: "2026-01-01",
  });
}, 120_000);

afterAll(async () => {
  if (ctx) {
    const cid = ctx.companyId;
    await pool.query(`DELETE FROM factory_fx_allocations WHERE company_id = $1`, [cid]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_supplier_fx_transfers WHERE company_id = $1`, [cid]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_supplier_payments WHERE company_id = $1`, [cid]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [cid]).catch(() => undefined);
    await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [cid]).catch(() => undefined);
    await cleanupTestData(PREFIX);
  }
  closeTestServer();
}, 120_000);

const url = () => `/api/factory/suppliers/${brokerId}/bulk-fx-settlement`;

describe("broker bulk FX settlement", () => {
  it("validates the request", async () => {
    expect((await agent.post(url()).send({ fromCurrencyCode: "AUD" })).status).toBe(400);
    expect(
      (await agent.post(url()).send({ fromCurrencyCode: "AUD", totalAmount: "-1", fxRateToUsd: "0.66" })).status
    ).toBe(400);
    expect(
      (
        await agent
          .post(`/api/factory/suppliers/99999999/bulk-fx-settlement`)
          .send({ fromCurrencyCode: "AUD", totalAmount: "1", fxRateToUsd: "1" })
      ).status
    ).toBe(404);
    const none = await agent.post(url()).send({ fromCurrencyCode: "EUR", totalAmount: "10", fxRateToUsd: "1.1" });
    expect(none.status).toBe(400);
    expect(none.body.message).toContain("EUR");
  });

  it("previews an oldest-first split with the excess booked to the last supplier, without writing", async () => {
    const response = await agent
      .post(url())
      .send({ fromCurrencyCode: "AUD", totalAmount: "1500", fxRateToUsd: "0.66", dryRun: true });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({ dryRun: true, totalRequested: "1500.0000", totalAllocated: "1500.0000" });
    expect(Number(response.body.totalUsd)).toBeCloseTo(990, 4);
    expect(response.body.transfers).toEqual([
      expect.objectContaining({ supplierId: olderSupplierId, allocated: "800.0000", overpayment: "0.0000" }),
      expect.objectContaining({ supplierId: newerSupplierId, allocated: "700.0000", overpayment: "200.0000" }),
    ]);
    expect(await transfersFor(olderSupplierId)).toEqual([]);
  });

  it("can fill the newest supplier first", async () => {
    const response = await agent
      .post(url())
      .send({ fromCurrencyCode: "AUD", totalAmount: "600", fxRateToUsd: "0.66", dryRun: true, order: "newest" });
    expect(response.status, response.text).toBe(200);
    expect(response.body.transfers).toEqual([
      expect.objectContaining({ supplierId: newerSupplierId, allocated: "500.0000" }),
      expect.objectContaining({ supplierId: olderSupplierId, allocated: "100.0000" }),
    ]);
  });

  it("records FX transfers to the broker and container allocations", async () => {
    const response = await agent.post(url()).send({
      fromCurrencyCode: "AUD",
      totalAmount: "900",
      fxRateToUsd: "0.66",
      date: "2026-09-01",
      notes: "Wave 4 settlement",
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({ success: true, totalAllocated: "900.0000", remaining: "0.0000" });

    const older = await transfersFor(olderSupplierId);
    const newer = await transfersFor(newerSupplierId);
    expect(older).toHaveLength(1);
    expect(Number(older[0].from_amount)).toBeCloseTo(800, 4);
    expect(Number(older[0].to_amount_usd)).toBeCloseTo(528, 4);
    expect(older[0].to_supplier_id).toBe(brokerId);
    expect(Number(newer[0].from_amount)).toBeCloseTo(100, 4);

    const allocations = await pool.query<{ container_id: number; allocated_amount: string }>(
      `SELECT container_id, allocated_amount FROM factory_fx_allocations WHERE fx_transfer_id = $1`,
      [older[0].id]
    );
    expect(allocations.rows).toEqual([{ container_id: olderContainerId, allocated_amount: expect.any(String) }]);
    expect(Number(allocations.rows[0].allocated_amount)).toBeCloseTo(800, 4);
  });

  it("nets earlier transfers out of the next settlement", async () => {
    const response = await agent
      .post(url())
      .send({ fromCurrencyCode: "AUD", totalAmount: "400", fxRateToUsd: "0.66", dryRun: true });
    expect(response.status, response.text).toBe(200);
    // Older supplier is settled; newer has 500 - 100 = 400 left.
    expect(response.body.transfers).toEqual([
      expect.objectContaining({ supplierId: newerSupplierId, allocated: "400.0000", overpayment: "0.0000" }),
    ]);
  });
});
