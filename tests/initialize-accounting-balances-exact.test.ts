/**
 * POST /api/admin/initialize-accounting-balances computes the import-cycle
 * balance per company exactly (server/lib/money.ts): ten supplier credits of
 * 0.10 are a supplier balance of exactly 1, where the float sum was
 * 0.9999999999999999.
 *
 * It used to write the difference into the Profit account's opening balance
 * so the books appeared balanced. That hid the difference (2026-10 accounting
 * audit). It now only reports the opening balance a balancing entry would need
 * and leaves the account unchanged.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "initbalexact";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let profitAccountId: number;

interface CompanyResult {
  companyId: number;
  imbalance: number;
  accountUpdated?: boolean;
  proposedOpeningBalance?: string;
  proposedOpeningBalanceSide?: string;
  components?: {
    assets: { name: string; value: number }[];
    liabilities: { name: string; value: number }[];
    totalAssets: number;
    totalLiabilities: number;
  };
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" }))
      .status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const [profit] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code: `${TEST_PREFIX}_PROFIT`,
      name: "Retained Profit",
      accountType: "Profit",
      openingBalance: "0",
      openingBalanceSide: "Cr",
    })
    .returning();
  profitAccountId = profit.id;

  const supplier = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-SUP`, `${TEST_PREFIX} Supplier`, `${TEST_PREFIX}@example.test`]
  );
  const supplierId = supplier.rows[0].id;

  // Ten purchases of 0.10 on credit: Dr Cash (stands in for the goods), Cr supplier.
  for (let index = 0; index < 10; index += 1) {
    const [voucher] = await db
      .insert(schema.vouchers)
      .values({
        companyId: ctx.companyId,
        voucherNumber: `${TEST_PREFIX}-P${index}`,
        voucherType: "Journal",
        voucherDate: "2026-05-01",
        totalAmount: "0.10",
      })
      .returning();
    await db.insert(schema.voucherEntries).values([
      { voucherId: voucher.id, ledgerAccountId: ctx.cashAccountId, debitAmount: "0.10", creditAmount: "0" },
      { voucherId: voucher.id, ledgerAccountId: ctx.cashAccountId, supplierId, debitAmount: "0", creditAmount: "0.10" },
    ]);
  }
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("initialize accounting balances", () => {
  it("sums ledger lines exactly and reports, without writing, the closing difference", async () => {
    const response = await agent.post("/api/admin/initialize-accounting-balances").send({});
    expect(response.status).toBe(200);
    const result = (response.body.results as CompanyResult[]).find((row) => row.companyId === ctx.companyId);
    expect(result?.components).toBeDefined();

    const supplier = result!.components!.liabilities.find((component) => component.name === "Supplier Balance");
    expect(supplier?.value).toBe(1);

    const { totalAssets, totalLiabilities } = result!.components!;
    const expectedCents = Math.round(totalAssets * 100) - Math.round(totalLiabilities * 100);
    const [profit] = await db.select().from(schema.ledgerAccounts).where(eq(schema.ledgerAccounts.id, profitAccountId));
    expect(profit.openingBalance).toBe("0.00");
    expect(profit.openingBalanceSide).toBe("Cr");
    if (Math.abs(expectedCents) < 100) {
      expect(result!.proposedOpeningBalance).toBeUndefined();
      return;
    }
    expect(result!.accountUpdated).toBe(false);
    expect(result!.proposedOpeningBalance).toBe((Math.abs(expectedCents) / 100).toFixed(2));
    expect(result!.proposedOpeningBalanceSide).toBe(expectedCents >= 0 ? "Cr" : "Dr");
  });
});
