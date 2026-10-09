/**
 * Accounting integrity diagnostic and trial balance (2026-10 accounting audit,
 * wave 3). The trial balance must never force balance: a seeded ledger with a
 * known opening imbalance, a one-sided stock voucher and a line posted to no
 * account must report exactly that difference, split into its sources.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w3integ";
const DATE = "2026-09-15";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let assetId: number;

// The voucher and its lines go in one transaction: the voucher balance guard
// checks the voucher at COMMIT.
async function voucher(
  type: string,
  number: string,
  lines: [number | null, string, string][],
  customerId?: number,
  legacy = false
) {
  return withFixtureTransaction(async (client) => {
    // Wave 16 (B): the line-target guard refuses a new line with no account; a
    // legacy row (written before the guard) is modelled under its bypass.
    if (legacy) await client.query(`SET LOCAL app.ledger_integrity_bypass = 'on'`);
    const created = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, $3, $4, 0) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-${number}`, type, DATE]
    );
    for (const [accountId, debit, credit] of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, customer_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [created.rows[0].id, accountId, customerId ?? null, debit, credit]
      );
    }
    return created.rows[0].id;
  });
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" }))
      .status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  // An asset account opened at 100.00 Dr with no matching credit anywhere.
  assetId = (
    await pool.query<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
       VALUES ($1, $2, $3, 'Asset', 100, 'Dr') RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-ASSET`, `${TEST_PREFIX} Asset`]
    )
  ).rows[0].id;
  // A balanced sale, a one-sided consumption voucher (by design) and a line with no account.
  await voucher("Sales", "SALE", [
    [ctx.cashAccountId, "250.00", "0"],
    [ctx.salesAccountId, "0", "250.00"],
  ]);
  await voucher("Consumption", "CONS", [[ctx.salesAccountId, "12.50", "0"]]);
  await voucher(
    "Journal",
    "NOACC",
    [
      [assetId, "40.00", "0"],
      [null, "0", "40.00"],
    ],
    undefined,
    true
  );
  // A type the shared classifier does not know (wave 13: a mis-cased 'EXPENSE'
  // is classified as an expense and is no longer flagged).
  await pool.query(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, 'Suspense Bucket')`,
    [ctx.companyId, `${TEST_PREFIX}-BADTYPE`, `${TEST_PREFIX} Bad Type`]
  );
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("GET /api/accounting/trial-balance", () => {
  it("reports the exact difference and its sources instead of plugging it", async () => {
    const res = await agent.get("/api/accounting/trial-balance");
    expect(res.status).toBe(200);
    // seedTestData's own openings are part of the company; compare deltas the test controls.
    const components = res.body.differenceComponents;
    expect(res.body.balanced).toBe(false);
    expect(components.singleSidedStockVouchers).toBe("12.50");
    expect(components.otherUnbalancedVouchers).toBe("0.00");
    const asset = res.body.rows.find(
      (row: { kind: string; id: number }) => row.kind === "ledger" && row.id === assetId
    );
    expect(asset).toMatchObject({ openingDebit: "100.00", periodDebit: "40.00", closingDebit: "140.00" });
    const unassigned = res.body.rows.find((row: { kind: string }) => row.kind === "unassigned");
    expect(unassigned).toMatchObject({ periodCredit: "40.00", closingCredit: "40.00" });
    const difference = Number(res.body.unexplainedDifference);
    const sumOfParts =
      Number(components.openingBalances) +
      Number(components.singleSidedStockVouchers) +
      Number(components.otherUnbalancedVouchers);
    expect(difference).toBeCloseTo(sumOfParts, 2);
    expect(Number(res.body.totals.closingDebit) - Number(res.body.totals.closingCredit)).toBeCloseTo(difference, 2);
  });

  it("rejects a malformed as-of date", async () => {
    expect((await agent.get("/api/accounting/trial-balance?asOf=yesterday")).status).toBe(400);
  });

  it("excludes vouchers dated after the as-of date", async () => {
    const res = await agent.get("/api/accounting/trial-balance?asOf=2026-09-01");
    expect(res.status).toBe(200);
    expect(res.body.differenceComponents.singleSidedStockVouchers).toBe("0.00");
  });
});

describe("GET /api/accounting/integrity", () => {
  it("flags the seeded defects", async () => {
    const res = await agent.get("/api/accounting/integrity");
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(
      (res.body.checks as { key: string; status: string; count: number }[]).map((c) => [c.key, c])
    );
    expect(res.body.status).toBe("fail");
    expect(byKey.lines_without_account).toMatchObject({ status: "fail", count: 1 });
    expect(byKey.single_sided_stock_vouchers).toMatchObject({ status: "warn", count: 1 });
    expect(byKey.unbalanced_vouchers).toMatchObject({ status: "pass", count: 0 });
    expect(byKey.non_canonical_account_types.status).toBe("fail");
    expect(byKey.opening_balances_unbalanced.status).toBe("fail");
  });

  it("is not available to non-admin roles", async () => {
    await pool.query(`UPDATE user_company_roles SET role = 'Manager' WHERE user_id = $1 AND company_id = $2`, [
      ctx.userId,
      ctx.companyId,
    ]);
    const manager = request.agent(ctx.app);
    await manager.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
    await manager.post("/api/auth/set-company").send({ companyId: ctx.companyId });
    const res = await manager.get("/api/accounting/integrity");
    await pool.query(`UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2`, [
      ctx.userId,
      ctx.companyId,
    ]);
    expect(res.status).toBe(403);
  });
});
