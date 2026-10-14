import request from "supertest";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const PREFIX = "fxreversal";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let sourceSupplier = 0;
let destinationSupplier = 0;

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query("UPDATE companies SET company_type = 'factory' WHERE id = $1", [ctx.companyId]);
  agent = request.agent(ctx.app);
  const login = await agent.post("/api/auth/login").send({
    username: PREFIX + "_testuser",
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error("Login failed");
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  const rows = await pool.query<{ id: number }>(
    "INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2), ($1, $3) RETURNING id",
    [ctx.companyId, PREFIX + " source", PREFIX + " destination"]
  );
  sourceSupplier = rows.rows[0].id;
  destinationSupplier = rows.rows[1].id;
  await pool.query(
    "INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side) VALUES ($1, 'ROUNDING', 'Rounding Differences', 'Indirect Expense', 'Indirect Expense', '0', 'Dr')",
    [ctx.companyId]
  );
}, 120000);

afterAll(async () => {
  if (!ctx) return;
  await pool.query("DELETE FROM factory_fx_allocations WHERE company_id = $1", [ctx.companyId]);
  await pool.query("DELETE FROM factory_supplier_fx_transfers WHERE company_id = $1", [ctx.companyId]);
  await pool.query("DELETE FROM factory_suppliers WHERE company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

describe("supplier FX transfer creation and reversible accounting /api/factory/supplier-fx-transfers/:id", () => {
  it("posts balanced source and destination entries and retires the voucher on reversal", async () => {
    const response = await agent.post("/api/factory/supplier-fx-transfers").send({
      fromSupplierId: sourceSupplier,
      toSupplierId: destinationSupplier,
      fromCurrencyCode: "EUR",
      fromAmount: "100",
      fxRateToUsd: "1.18",
      toAmountUsd: "118",
      date: "2026-09-01",
      sourceType: "supplier",
    });
    expect(response.status).toBeLessThan(300);
    const transferId = Number(response.body.id);
    const voucher = await pool.query<{ id: number; dr: string; cr: string }>(
      "SELECT v.id, SUM(e.debit_amount)::text dr, SUM(e.credit_amount)::text cr FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id WHERE v.company_id = $1 AND v.voucher_number LIKE $2 AND v.deleted_at IS NULL GROUP BY v.id",
      [ctx.companyId, "FACTORY-SFX-" + transferId + "-%"]
    );
    expect(voucher.rows).toHaveLength(1);
    expect(voucher.rows[0].dr).toBe(voucher.rows[0].cr);

    const reversal = await agent.delete("/api/factory/supplier-fx-transfers/" + transferId);
    expect(reversal.status).toBeLessThan(300);
    const active = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text count FROM vouchers WHERE id = $1 AND deleted_at IS NULL",
      [voucher.rows[0].id]
    );
    expect(Number(active.rows[0].count)).toBe(0);
  });
});
