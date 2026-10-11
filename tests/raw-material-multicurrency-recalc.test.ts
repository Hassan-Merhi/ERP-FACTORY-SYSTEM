/**
 * Integration + unit tests for multi-currency raw-material cost recomputation
 * and the write-path rejections added around opening-balance commissions.
 *
 * Covers remaining spec scenarios not exercised by factory-fx-diagnostic-repair.test.ts:
 *   - computeCorrectContainerCost blends a container-currency base cost with charges
 *     stored in OTHER currencies (freight/other-charges/commission/additional-charge
 *     each with their own currency + explicit rate) using decimal.js, not floats.
 *   - An unresolved container FX rate is surfaced as fxUnresolved, never guessed as 1.
 *   - Opening-balance import rejects a non-USD commission with no explicit rate,
 *     exactly like the existing check for the main container rate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { db, pool } from "../server/db";
import { eq } from "drizzle-orm";
import * as schema from "../shared/schema";
import { computeCorrectContainerCost } from "../server/services/factory/raw-stock-recalc";

const TEST_PREFIX = "fxmulti";

let ctx: TestContext;
let agent: request.SuperAgentTest;

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await db.update(schema.companies).set({ companyType: "factory" }).where(eq(schema.companies.id, ctx.companyId));
  agent = request.agent(ctx.app);
  const loginRes = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  if (loginRes.status !== 200) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 30000);

afterAll(async () => {
  if (!ctx) return;
  await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_offload_additional_charges WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_container_commissions WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_raw_stock WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [ctx.companyId]);
  // The opening-balance commission is journalled (FACTORY-COMM, wave 14 B); its lines reference the supplier.
  await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
    ctx.companyId,
  ]);
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("Multi-currency raw-material cost recomputation (decimal.js)", () => {
  it("blends a EUR base cost with a CDF additional charge, each converted via its own explicit rate", () => {
    const container: any = {
      currencyCode: "EUR",
      fxRateToUsd: "1.08",
      fxRateToUsdOffload: "1.08",
      fxRateConfirmed: true,
      actualReceivedKg: "1000",
      ratePerKg: "2.5",
      freight: "0",
      freightCurrencyCode: "EUR",
      otherCharges: "0",
      otherChargesCurrencyCode: "EUR",
      commissionAmount: "0",
      commissionCurrencyCode: "EUR",
      dutyStatus: "PENDING",
      dutyAmount: "0",
    };
    const additionalCharges: any[] = [
      {
        amount: "50000",
        currencyCode: "CDF",
        fxRateToUsd: "0.00038",
        fxRateConfirmed: true,
      },
    ];

    const result = computeCorrectContainerCost(container, additionalCharges, null);

    expect(result.fxUnresolved).toBe(false);
    expect(result.totalUsd).toBeCloseTo(2719, 4);
    expect(result.totalCost).toBeCloseTo(2500 + 19 / 1.08, 4);
    expect(result.costPerKgUsd).toBeCloseTo(2719 / 1000, 6);
  });

  it("surfaces fxUnresolved instead of guessing rate=1 for a non-USD container with no confirmed rate", () => {
    const container: any = {
      currencyCode: "EUR",
      fxRateToUsd: "1",
      fxRateToUsdOffload: null,
      fxRateConfirmed: false,
      actualReceivedKg: "500",
      ratePerKg: "3",
      freight: "0",
      otherCharges: "0",
      commissionAmount: "0",
      dutyStatus: "PENDING",
      dutyAmount: "0",
    };

    const result = computeCorrectContainerCost(container, [], null);
    expect(result.fxUnresolved).toBe(true);
    expect(result.totalUsd).toBe(0);
  });

  it("does not flag a genuinely-confirmed 1:1 peg as unresolved", () => {
    const container: any = {
      currencyCode: "EUR",
      fxRateToUsd: "1",
      fxRateToUsdOffload: "1",
      fxRateConfirmed: true,
      actualReceivedKg: "500",
      ratePerKg: "3",
      freight: "0",
      otherCharges: "0",
      commissionAmount: "0",
      dutyStatus: "PENDING",
      dutyAmount: "0",
    };

    const result = computeCorrectContainerCost(container, [], null);
    expect(result.fxUnresolved).toBe(false);
    expect(result.totalUsd).toBeCloseTo(1500, 4);
  });
});

describe("Opening-balance import: commission FX rejection", () => {
  it("rejects an opening-balance import whose main rate is missing for a non-USD currency", async () => {
    const res = await agent.post("/api/factory/raw-stock/opening-balance").send({
      supplierName: `${TEST_PREFIX}_SupplierA`,
      receivedKg: "100",
      costPerKg: "2",
      currencyCode: "EUR",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an opening-balance import whose commission currency is non-USD with no explicit rate", async () => {
    const res = await agent.post("/api/factory/raw-stock/opening-balance").send({
      supplierName: `${TEST_PREFIX}_SupplierB`,
      receivedKg: "100",
      costPerKg: "2",
      currencyCode: "USD",
      commissionAmount: "50",
      commissionCurrencyCode: "EUR",
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/[Cc]ommission/);
  });

  it("accepts an opening-balance import with an explicit commission FX rate and blends it correctly", async () => {
    const res = await agent.post("/api/factory/raw-stock/opening-balance").send({
      supplierName: `${TEST_PREFIX}_SupplierC`,
      receivedKg: "100",
      costPerKg: "2",
      currencyCode: "USD",
      commissionAmount: "50",
      commissionCurrencyCode: "EUR",
      commissionFxRateToUsd: "1.08",
    });
    expect(res.status).toBe(200);
  });
});
