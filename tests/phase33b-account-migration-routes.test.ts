import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
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

describe("Phase 33B account migration accounting routes", () => {
  it("rejects malformed and same-company migrations before any accounting write", async () => {
    const invalid = await agent.post("/api/admin/account-migration/execute").send({
      accountIds: [],
      srcCompanyId: ctx.companyId,
      destCompanyId: destinationCompanyId,
    });
    expect(invalid.status).toBe(400);

    const sameCompany = await agent.post("/api/admin/account-migration/execute").send({
      accountIds: [ctx.salesAccountId],
      srcCompanyId: ctx.companyId,
      destCompanyId: ctx.companyId,
    });
    expect(sameCompany.status).toBe(400);
  });

  it("moves an exclusive voucher intact and restores it on exact undo", async () => {
    const migratedAccountId = await makeAccount(ctx.companyId, "EXCLUSIVE");
    const sourceVoucherId = await makeVoucher(
      ctx.companyId,
      [
        { accountId: migratedAccountId, debit: "100.00", credit: "0" },
        { accountId: migratedAccountId, debit: "0", credit: "100.00" },
      ],
      "exclusive-history"
    );

    const execute = await agent.post("/api/admin/account-migration/execute").send({
      accountIds: [migratedAccountId],
      srcCompanyId: ctx.companyId,
      destCompanyId: destinationCompanyId,
    });

    expect(execute.status).toBe(200);
    expect(execute.body).toMatchObject({
      success: true,
      movedVoucherCount: 1,
      sharedVoucherCount: 0,
      splitVoucherCount: 0,
    });
    expect(execute.body.movedVoucherIds).toContain(sourceVoucherId);
    expect(await accountCompany(migratedAccountId)).toBe(destinationCompanyId);
    expect(await voucherCompany(sourceVoucherId)).toBe(destinationCompanyId);

    const undo = await agent.post("/api/admin/account-migration/undo").send({
      accounts: execute.body.accounts,
      movedVoucherIds: execute.body.movedVoucherIds,
      srcCompanyId: ctx.companyId,
      destCompanyId: destinationCompanyId,
    });

    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ success: true, restoredAccountCount: 1 });
    expect(undo.body.roundTrip).not.toBe(true);
    expect(await accountCompany(migratedAccountId)).toBe(ctx.companyId);
    expect(await voucherCompany(sourceVoucherId)).toBe(ctx.companyId);
  }, 60_000);

  it("splits shared history on execute and restores it exactly on ordinary undo", async () => {
    const migratedAccountId = await makeAccount(ctx.companyId, "SPLIT");
    const sourceVoucherId = await makeVoucher(
      ctx.companyId,
      [
        { accountId: migratedAccountId, debit: "100.00", credit: "0" },
        { accountId: ctx.cashAccountId, debit: "0", credit: "100.00" },
      ],
      "shared-history"
    );

    const execute = await agent.post("/api/admin/account-migration/execute").send({
      accountIds: [migratedAccountId],
      srcCompanyId: ctx.companyId,
      destCompanyId: destinationCompanyId,
    });

    expect(execute.status).toBe(200);
    expect(execute.body).toMatchObject({
      success: true,
      srcCompanyId: ctx.companyId,
      destCompanyId: destinationCompanyId,
      sharedVoucherCount: 1,
      splitVoucherCount: 1,
    });
    expect(await accountCompany(migratedAccountId)).toBe(destinationCompanyId);
    expect(await voucherCompany(sourceVoucherId)).toBe(ctx.companyId);

    const movedEntry = await pool.query<{ ledger_account_id: number | null }>(
      `SELECT ledger_account_id
         FROM voucher_entries
        WHERE voucher_id = $1
          AND narration = $2
        ORDER BY id
        LIMIT 1`,
      [sourceVoucherId, `${TEST_PREFIX} shared-history`]
    );
    expect(movedEntry.rows[0]?.ledger_account_id).not.toBe(migratedAccountId);

    const undo = await agent.post("/api/admin/account-migration/undo").send({
      accounts: execute.body.accounts,
      movedVoucherIds: execute.body.movedVoucherIds,
      srcCompanyId: ctx.companyId,
      destCompanyId: destinationCompanyId,
    });

    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ success: true, restoredAccountCount: 1 });
    expect(undo.body.roundTrip).not.toBe(true);
    expect(await accountCompany(migratedAccountId)).toBe(ctx.companyId);
    expect(await voucherCompany(sourceVoucherId)).toBe(ctx.companyId);

    const restored = await pool.query<{ ledger_account_id: number | null }>(
      `SELECT ledger_account_id
         FROM voucher_entries
        WHERE voucher_id = $1
          AND narration = $2
        ORDER BY id
        LIMIT 1`,
      [sourceVoucherId, `${TEST_PREFIX} shared-history`]
    );
    expect(restored.rows[0]?.ledger_account_id).toBe(migratedAccountId);
  }, 60_000);

  it("round-trips new exclusive destination-company accounting activity instead of orphaning it", async () => {
    const migratedAccountId = await makeAccount(ctx.companyId, "ROUND");

    const execute = await agent.post("/api/admin/account-migration/execute").send({
      accountIds: [migratedAccountId],
      srcCompanyId: ctx.companyId,
      destCompanyId: destinationCompanyId,
    });
    expect(execute.status).toBe(200);
    expect(await accountCompany(migratedAccountId)).toBe(destinationCompanyId);

    const postMigrationVoucherId = await makeVoucher(
      destinationCompanyId,
      [
        { accountId: migratedAccountId, debit: "100.00", credit: "0" },
        { accountId: migratedAccountId, debit: "0", credit: "100.00" },
      ],
      "post-migration"
    );

    const undo = await agent.post("/api/admin/account-migration/undo").send({
      accounts: execute.body.accounts,
      movedVoucherIds: execute.body.movedVoucherIds,
      srcCompanyId: ctx.companyId,
      destCompanyId: destinationCompanyId,
    });

    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({
      success: true,
      roundTrip: true,
      postMigrationVoucherCount: 1,
      restoredAccountCount: 1,
      movedBackVoucherCount: 1,
      splitBackVoucherCount: 0,
    });
    expect(await accountCompany(migratedAccountId)).toBe(ctx.companyId);
    expect(await voucherCompany(postMigrationVoucherId)).toBe(ctx.companyId);
  }, 60_000);

  it("splits shared post-migration activity when moving the account back", async () => {
    const migratedAccountId = await makeAccount(ctx.companyId, "ROUND-SHARED");
    const destinationPeerAccountId = await makeAccount(destinationCompanyId, "DEST-PEER");

    const execute = await agent.post("/api/admin/account-migration/execute").send({
      accountIds: [migratedAccountId],
      srcCompanyId: ctx.companyId,
      destCompanyId: destinationCompanyId,
    });
    expect(execute.status).toBe(200);

    const postMigrationVoucherId = await makeVoucher(
      destinationCompanyId,
      [
        { accountId: migratedAccountId, debit: "100.00", credit: "0" },
        { accountId: destinationPeerAccountId, debit: "0", credit: "100.00" },
      ],
      "post-migration-shared"
    );

    const undo = await agent.post("/api/admin/account-migration/undo").send({
      accounts: execute.body.accounts,
      movedVoucherIds: execute.body.movedVoucherIds,
      srcCompanyId: ctx.companyId,
      destCompanyId: destinationCompanyId,
    });

    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({
      success: true,
      roundTrip: true,
      postMigrationVoucherCount: 1,
      restoredAccountCount: 1,
      movedBackVoucherCount: 0,
      splitBackVoucherCount: 1,
    });
    expect(await accountCompany(migratedAccountId)).toBe(ctx.companyId);
    expect(await voucherCompany(postMigrationVoucherId)).toBe(destinationCompanyId);

    const sourceRows = await pool.query<{ voucher_id: number; company_id: number }>(
      `SELECT ve.voucher_id, v.company_id
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = $1`,
      [migratedAccountId]
    );
    expect(sourceRows.rows.some((row) => row.company_id === ctx.companyId)).toBe(true);
    expect(sourceRows.rows.some((row) => row.voucher_id === postMigrationVoucherId)).toBe(false);
  }, 60_000);
});
