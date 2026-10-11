import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../server/db";
import * as schema from "../shared/schema";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "phase33bmig";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let destinationCompanyId: number;
let sequence = 0;

async function makeAccount(companyId: number, label: string): Promise<number> {
  sequence += 1;
  const [account] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId,
      code: `P33B${label}${sequence}`.slice(0, 50),
      name: `${TEST_PREFIX} ${label} ${sequence}`,
      accountType: "Asset",
      subType: "Current Asset",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    })
    .returning();
  return account.id;
}

async function makeVoucher(
  companyId: number,
  entries: Array<{ accountId: number; debit: string; credit: string }>,
  label: string
): Promise<number> {
  sequence += 1;
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId,
      voucherNumber: `P33B-${label}-${sequence}`,
      voucherType: "Journal",
      voucherDate: "2026-09-17",
      description: `${TEST_PREFIX} ${label}`,
      totalAmount: "100.00",
      currency: "USD",
      optional: false,
    })
    .returning();

  await db.insert(schema.voucherEntries).values(
    entries.map((entry) => ({
      voucherId: voucher.id,
      ledgerAccountId: entry.accountId,
      debitAmount: entry.debit,
      creditAmount: entry.credit,
      narration: `${TEST_PREFIX} ${label}`,
    }))
  );
  return voucher.id;
}

async function accountCompany(accountId: number): Promise<number | null> {
  const [row] = await db
    .select({ companyId: schema.ledgerAccounts.companyId })
    .from(schema.ledgerAccounts)
    .where(eq(schema.ledgerAccounts.id, accountId));
  return row?.companyId ?? null;
}

async function voucherCompany(voucherId: number): Promise<number | null> {
  const [row] = await db
    .select({ companyId: schema.vouchers.companyId })
    .from(schema.vouchers)
    .where(eq(schema.vouchers.id, voucherId));
  return row?.companyId ?? null;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);

  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);

  const [destination] = await db
    .insert(schema.companies)
    .values({
      code: "P33BDEST",
      name: `${TEST_PREFIX}_Destination`,
      companyType: "erp",
      active: true,
      baseCurrency: "USD",
    })
    .returning();
  destinationCompanyId = destination.id;

  await db.insert(schema.userCompanyRoles).values({
    userId: ctx.userId,
    companyId: destinationCompanyId,
    role: "Admin",
  });
}, 120_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  await closeTestServer();
}, 120_000);

// Phase 23 (G5, decided by default): the account migration no longer moves
// vouchers between companies or rewrites their lines; execute and undo answer
// 410 and change nothing. A balance moves by an account reclassification
// journal (tests/phase23-ledger-tools.test.ts). The tests below pinned the
// retired line-rewriting behaviour and now pin the retirement.
describe("Phase 33B account migration accounting routes (retired in phase 23)", () => {
  it("refuses execute and undo with 410 before any accounting write", async () => {
    const source = await makeAccount(ctx.companyId, "SRC");
    const voucherId = await makeVoucher(
      ctx.companyId,
      [
        { accountId: source, debit: "100.00", credit: "0" },
        { accountId: ctx.cashAccountId, debit: "0", credit: "100.00" },
      ],
      "RETIRED"
    );
    const execute = await agent.post("/api/admin/account-migration/execute").send({
      accountIds: [source],
      srcCompanyId: ctx.companyId,
      destCompanyId: destinationCompanyId,
    });
    expect(execute.status).toBe(410);
    expect(execute.body.code).toBe("ACCOUNT_MIGRATION_RETIRED");
    const undo = await agent.post("/api/admin/account-migration/undo").send({ migrationId: "any" });
    expect(undo.status).toBe(410);
    expect(await accountCompany(source)).toBe(ctx.companyId);
    expect(await voucherCompany(voucherId)).toBe(ctx.companyId);
  });
});
