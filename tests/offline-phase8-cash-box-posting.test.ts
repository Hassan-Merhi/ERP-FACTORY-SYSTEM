/**
 * Owner policy (2026-11-01) for offline payments: the Phase 8 cloud replay
 * posts factory cash-box Payment/Receipt vouchers through the central engine
 * on the full schema, and refuses any that would pay a supplier or a bank.
 * Each case runs in a transaction that is rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { pool } from "../server/db";
import { postApprovedPhase8Journal } from "../server/edge/phase8VoucherPosting";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p8cash";
const SITE = "3e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b";
let ctx: TestContext;

async function account(client: PoolClient, code: string, accountType: string): Promise<number> {
  const result = await client.query(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, '0', 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}_${code}`, `${PREFIX} ${code}`, accountType]
  );
  return Number(result.rows[0].id);
}

function event(voucherType: string, entries: Array<Record<string, unknown>>) {
  return {
    sequence: "1",
    operationId: randomUUID(),
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    localVoucherId: 77,
    kind: "voucher.with-entries.v1",
    payload: {
      voucher: {
        id: 77,
        companyId: ctx.companyId,
        voucherType,
        voucherDate: "2026-11-02",
        currency: "USD",
        description: "Offline factory cash",
      },
      entries,
    },
  };
}

async function inRolledBackTx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(ctx.companyId), async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await run(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
}, 120_000);

afterAll(async () => {
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 8 replay of offline factory cash-box payments and receipts", () => {
  it("posts a cash-box Payment to an expense account as a Payment voucher", async () => {
    await inRolledBackTx(async (client) => {
      const fuel = await account(client, "FUEL", "Direct Expense");
      const posted = await postApprovedPhase8Journal(
        client,
        event("Payment", [
          { ledgerAccountId: fuel, debitAmount: "40.00", creditAmount: "0" },
          { ledgerAccountId: ctx.cashAccountId, debitAmount: "0", creditAmount: "40.00" },
        ]),
        SITE
      );
      const voucher = await client.query(
        "SELECT voucher_type, total_amount::numeric AS total FROM vouchers WHERE id = $1",
        [posted.cloudVoucherId]
      );
      expect(voucher.rows[0].voucher_type).toBe("Payment");
      expect(Number(voucher.rows[0].total)).toBe(40);
    });
  });

  it("posts a cash-box Receipt from an income account", async () => {
    await inRolledBackTx(async (client) => {
      const posted = await postApprovedPhase8Journal(
        client,
        event("Receipt", [
          { ledgerAccountId: ctx.cashAccountId, debitAmount: "15.00", creditAmount: "0" },
          { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "15.00" },
        ]),
        SITE
      );
      expect(posted.businessDate).toBe("2026-11-02");
    });
  });

  it("refuses an offline payment to a supplier payable or from a bank account", async () => {
    await inRolledBackTx(async (client) => {
      const payable = await account(client, "AP", "Accounts Payable");
      const bank = await account(client, "BANK", "Bank");
      const fuel = await account(client, "FUEL2", "Direct Expense");
      await expect(
        postApprovedPhase8Journal(
          client,
          event("Payment", [
            { ledgerAccountId: payable, debitAmount: "40.00", creditAmount: "0" },
            { ledgerAccountId: ctx.cashAccountId, debitAmount: "0", creditAmount: "40.00" },
          ]),
          SITE
        )
      ).rejects.toThrow("PHASE8_CASH_BOX_COUNTER_ACCOUNT_NOT_APPROVED");
      await expect(
        postApprovedPhase8Journal(
          client,
          event("Payment", [
            { ledgerAccountId: fuel, debitAmount: "40.00", creditAmount: "0" },
            { ledgerAccountId: bank, debitAmount: "0", creditAmount: "40.00" },
          ]),
          SITE
        )
      ).rejects.toThrow("PHASE8_CASH_BOX_COUNTER_ACCOUNT_NOT_APPROVED");
    });
  });
});
