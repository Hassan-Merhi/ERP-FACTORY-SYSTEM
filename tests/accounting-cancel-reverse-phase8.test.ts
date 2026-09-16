import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "p8acctrev";
const VOUCHER_DATE = "2026-09-11";

let ctx: TestContext;
let agent: request.SuperAgentTest;

type EntryRow = {
  id: number;
  ledger_account_id: number | null;
  debit_amount: string | null;
  credit_amount: string | null;
};

function extractVoucherId(body: Record<string, unknown>): number {
  const voucher = body.voucher as { id?: number } | undefined;
  const id = voucher?.id ?? (body.id as number | undefined) ?? (body.voucherId as number | undefined);
  if (!id) throw new Error(`Voucher id missing from response: ${JSON.stringify(body)}`);
  return Number(id);
}

function paymentReceiptBody(voucherType: "Payment" | "Receipt", amount: string) {
  return {
    voucherType,
    voucherDate: VOUCHER_DATE,
    paymentAccountType: "ledger",
    paymentAccountId: ctx.cashAccountId,
    paymentAccountName: "Cash",
    entries: [
      {
        accountType: "ledger",
        accountId: ctx.salesAccountId,
        accountName: "Sales",
        amount,
      },
    ],
    notes: `${voucherType} phase 8 lifecycle`,
    currency: "USD",
  };
}

function journalBody(amount: string, notes: string) {
  return {
    voucherDate: VOUCHER_DATE,
    notes,
    currency: "USD",
    entries: [
      {
        type: "DR",
        accountType: "ledger",
        accountId: ctx.cashAccountId,
        amount,
        narration: `${notes} debit`,
      },
      {
        type: "CR",
        accountType: "ledger",
        accountId: ctx.salesAccountId,
        amount,
        narration: `${notes} credit`,
      },
    ],
  };
}

async function entriesFor(voucherId: number): Promise<EntryRow[]> {
  const result = await pool.query<EntryRow>(
    `SELECT id, ledger_account_id, debit_amount, credit_amount
       FROM voucher_entries
      WHERE voucher_id = $1
      ORDER BY id`,
    [voucherId]
  );
  return result.rows;
}

async function deletedAt(voucherId: number): Promise<string | null> {
  const result = await pool.query<{ deleted_at: string | null }>(
    `SELECT deleted_at::text FROM vouchers WHERE id = $1`,
    [voucherId]
  );
  return result.rows[0]?.deleted_at ?? null;
}

function assertBalanced(entries: EntryRow[]): void {
  const debit = entries.reduce((sum, entry) => sum + Number(entry.debit_amount || 0), 0);
  const credit = entries.reduce((sum, entry) => sum + Number(entry.credit_amount || 0), 0);
  expect(debit).toBeCloseTo(credit, 6);
  expect(debit).toBeGreaterThan(0);
}

async function deleteAuditCount(voucherId: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM audit_log
      WHERE company_id = $1
        AND table_name = 'vouchers'
        AND record_id = $2
        AND action = 'delete'`,
    [ctx.companyId, voucherId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}, 120000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("Phase 8 — cancel/delete is replay-safe for major accounting documents", () => {
  for (const voucherType of ["Payment", "Receipt"] as const) {
    it(`${voucherType} soft-delete reverses once and an already-cancelled retry cannot duplicate the cancellation`, async () => {
      const created = await agent.post("/api/vouchers/payment-receipt").send(paymentReceiptBody(voucherType, "125.75"));
      expect(created.status).toBe(200);
      const voucherId = extractVoucherId(created.body);
      const beforeEntries = await entriesFor(voucherId);
      expect(beforeEntries).toHaveLength(2);
      assertBalanced(beforeEntries);

      const first = await agent.delete(`/api/vouchers/${voucherId}`);
      expect(first.status).toBe(200);
      expect(first.body.replayed).toBe(false);
      expect(await deletedAt(voucherId)).not.toBeNull();

      // Accounting evidence stays as an auditable tombstone, but balance
      // readers exclude the soft-deleted voucher. It must remain balanced.
      const afterFirst = await entriesFor(voucherId);
      expect(afterFirst).toEqual(beforeEntries);
      assertBalanced(afterFirst);
      expect(await deleteAuditCount(voucherId)).toBe(1);

      const second = await agent.delete(`/api/vouchers/${voucherId}`);
      expect(second.status).toBe(200);
      expect(second.body.replayed).toBe(true);

      const afterSecond = await entriesFor(voucherId);
      expect(afterSecond).toEqual(beforeEntries);
      assertBalanced(afterSecond);
      expect(await deleteAuditCount(voucherId)).toBe(1);
    });
  }

  it("Journal soft-delete is replay-safe and does not add or remove accounting legs on retry", async () => {
    const created = await agent.post("/api/vouchers/journal").send(journalBody("333.33", "Journal cancel"));
    expect(created.status).toBe(200);
    const voucherId = extractVoucherId(created.body);
    const beforeEntries = await entriesFor(voucherId);
    expect(beforeEntries).toHaveLength(2);
    assertBalanced(beforeEntries);

    const first = await agent.delete(`/api/vouchers/${voucherId}`);
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    expect(await deletedAt(voucherId)).not.toBeNull();
    expect(await entriesFor(voucherId)).toEqual(beforeEntries);
    expect(await deleteAuditCount(voucherId)).toBe(1);

    const second = await agent.delete(`/api/vouchers/${voucherId}`);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    const afterSecond = await entriesFor(voucherId);
    expect(afterSecond).toEqual(beforeEntries);
    assertBalanced(afterSecond);
    expect(await deleteAuditCount(voucherId)).toBe(1);
  });
});

describe("Phase 8 — exact reversal is balanced, append-only and idempotent", () => {
  it("posts one exact reversal, replays the same reversal on retry, and refuses reversal-of-reversal", async () => {
    const created = await agent.post("/api/vouchers/journal").send(journalBody("480.25", "Exact reversal source"));
    expect(created.status).toBe(200);
    const originalId = extractVoucherId(created.body);
    const originalEntries = await entriesFor(originalId);
    expect(originalEntries).toHaveLength(2);
    assertBalanced(originalEntries);

    const first = await agent.post(`/api/vouchers/${originalId}/exact-reversal`).send({
      reversalDate: "2026-09-12",
      reversalVoucherNumber: `${TEST_PREFIX.toUpperCase()}-REV-${originalId}`,
      description: "Phase 8 exact reversal",
    });
    expect(first.status).toBe(201);
    expect(first.body.replayed).toBe(false);
    const reversalId = extractVoucherId(first.body);
    expect(reversalId).not.toBe(originalId);

    const reversalEntries = await entriesFor(reversalId);
    expect(reversalEntries).toHaveLength(originalEntries.length);
    assertBalanced(reversalEntries);

    // Every target is preserved and every DR/CR side is swapped exactly.
    for (const original of originalEntries) {
      const reversed = reversalEntries.find((entry) => entry.ledger_account_id === original.ledger_account_id);
      expect(reversed).toBeDefined();
      expect(Number(reversed?.debit_amount)).toBeCloseTo(Number(original.credit_amount || 0), 6);
      expect(Number(reversed?.credit_amount)).toBeCloseTo(Number(original.debit_amount || 0), 6);
    }

    // Original + reversal must net to zero per account.
    const net = await pool.query<{ ledger_account_id: number; net: string }>(
      `SELECT ledger_account_id,
              SUM(COALESCE(debit_amount, 0)::numeric - COALESCE(credit_amount, 0)::numeric)::text AS net
         FROM voucher_entries
        WHERE voucher_id IN ($1, $2)
          AND ledger_account_id IS NOT NULL
        GROUP BY ledger_account_id
        ORDER BY ledger_account_id`,
      [originalId, reversalId]
    );
    expect(net.rows.length).toBeGreaterThan(0);
    expect(net.rows.every((row) => Math.abs(Number(row.net)) < 0.000001)).toBe(true);

    // A retry that carries the original payload replays the one reversal that
    // was already posted rather than posting a second one.
    const replay = await agent.post(`/api/vouchers/${originalId}/exact-reversal`).send({
      reversalDate: "2026-09-12",
      reversalVoucherNumber: `${TEST_PREFIX.toUpperCase()}-REV-${originalId}`,
      description: "Phase 8 exact reversal",
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(extractVoucherId(replay.body)).toBe(reversalId);

    // A retry that changes the payload under the same reversal identity is a
    // conflict, not a replay: the posting boundary must not silently discard
    // the caller's new voucher number, date and description, and it must not
    // post a competing second reversal either.
    const conflicting = await agent.post(`/api/vouchers/${originalId}/exact-reversal`).send({
      reversalDate: "2026-09-13",
      reversalVoucherNumber: `${TEST_PREFIX.toUpperCase()}-SHOULD-NOT-DUPLICATE`,
      description: "retry must not rewrite the posted reversal",
    });
    expect(conflicting.status).toBe(400);
    expect(conflicting.body.code).toBe("POSTING_IDEMPOTENCY_CONFLICT");

    const reversalMarkers = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM accounting_posting_requests
        WHERE company_id = $1
          AND source_type = 'voucher-reversal'
          AND source_id = $2`,
      [ctx.companyId, String(originalId)]
    );
    expect(Number(reversalMarkers.rows[0]?.count ?? 0)).toBe(1);
    expect(await entriesFor(reversalId)).toHaveLength(originalEntries.length);

    const reverseTheReversal = await agent.post(`/api/vouchers/${reversalId}/exact-reversal`).send({
      reversalDate: "2026-09-13",
    });
    expect(reverseTheReversal.status).toBe(400);
    expect(reverseTheReversal.body.code).toBe("VOUCHER_REVERSAL_CHAIN_FORBIDDEN");
  });

  it("refuses exact reversal of an already-cancelled voucher without creating accounting evidence", async () => {
    const created = await agent.post("/api/vouchers/journal").send(journalBody("91.25", "Cancelled reversal source"));
    expect(created.status).toBe(200);
    const originalId = extractVoucherId(created.body);

    const cancelled = await agent.delete(`/api/vouchers/${originalId}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.replayed).toBe(false);

    const beforeVoucherCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM vouchers WHERE company_id = $1`,
      [ctx.companyId]
    );

    const reversal = await agent.post(`/api/vouchers/${originalId}/exact-reversal`).send({
      reversalDate: "2026-09-13",
      reversalVoucherNumber: `${TEST_PREFIX.toUpperCase()}-DELETED-REV`,
    });
    expect(reversal.status).toBe(400);
    expect(reversal.body.code).toBe("VOUCHER_REVERSAL_ORIGINAL_DELETED");

    const afterVoucherCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM vouchers WHERE company_id = $1`,
      [ctx.companyId]
    );
    expect(afterVoucherCount.rows[0]?.count).toBe(beforeVoucherCount.rows[0]?.count);

    const marker = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM accounting_posting_requests
        WHERE company_id = $1
          AND source_type = 'voucher-reversal'
          AND source_id = $2`,
      [ctx.companyId, String(originalId)]
    );
    expect(Number(marker.rows[0]?.count ?? 0)).toBe(0);
  });
});
