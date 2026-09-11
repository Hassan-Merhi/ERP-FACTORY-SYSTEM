import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db } from "../server/db";
import { accountingPostingRequests, auditLog, voucherEntries, vouchers } from "../shared/schema";
import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../server/services/accounting/infrastructureVoucherIdentity";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "infraidem";
let ctx: TestContext;

function identity() {
  return infrastructurePostingIdentity("phase3-test-writer", ctx.companyId, "journal");
}

function voucher(amount = "30.00") {
  return {
    companyId: ctx.companyId,
    voucherNumber: `INFRA-IDEM-${ctx.companyId}-${Date.now()}`,
    voucherType: "Journal",
    voucherDate: "2026-08-17",
    totalAmount: amount,
    description: "Phase 3 infrastructure writer idempotency proof",
    currency: "USD",
    sourceModule: "ERP",
  };
}

async function postInfrastructureVoucher(amount = "30.00") {
  return db.transaction(async (tx) => {
    const result = await insertInfrastructureVoucherTx(tx, voucher(amount), identity(), { amount });
    await tx.insert(voucherEntries).values([
      {
        voucherId: result.voucher.id,
        ledgerAccountId: ctx.cashAccountId,
        debitAmount: amount,
        creditAmount: "0",
        narration: "Infrastructure debit",
      },
      {
        voucherId: result.voucher.id,
        ledgerAccountId: ctx.salesAccountId,
        debitAmount: "0",
        creditAmount: amount,
        narration: "Infrastructure credit",
      },
    ]);
    return result;
  });
}

async function clearPosting() {
  const key = ctx ? identity().idempotencyKey : "";
  if (!ctx) return;

  await db
    .delete(accountingPostingRequests)
    .where(
      and(eq(accountingPostingRequests.companyId, ctx.companyId), eq(accountingPostingRequests.idempotencyKey, key))
    );
  await db.delete(auditLog).where(and(eq(auditLog.companyId, ctx.companyId), eq(auditLog.recordIdentifier, key)));

  const rows = await db
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, ctx.companyId),
        eq(vouchers.description, "Phase 3 infrastructure writer idempotency proof")
      )
    );
  for (const row of rows) {
    await db.delete(voucherEntries).where(eq(voucherEntries.voucherId, row.id));
    await db.delete(vouchers).where(eq(vouchers.id, row.id));
  }
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await clearPosting();
}, 60000);

afterAll(async () => {
  if (ctx) await clearPosting();
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("infrastructure voucher identity", () => {
  it("requires a complete stable source identity before inserting", async () => {
    await expect(
      db.transaction((tx) =>
        insertInfrastructureVoucherTx(
          tx,
          voucher(),
          { sourceType: "phase3-test", sourceId: "", idempotencyKey: "phase3-test-missing" },
          { amount: "30.00" }
        )
      )
    ).rejects.toMatchObject({ code: "POSTING_SOURCE_REQUIRED" });
  });

  it("collapses concurrent retries to one voucher and one rebuilt entry set", async () => {
    const [first, second] = await Promise.all([postInfrastructureVoucher(), postInfrastructureVoucher()]);

    expect(first.voucher.id).toBe(second.voucher.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);

    const markers = await db
      .select()
      .from(accountingPostingRequests)
      .where(
        and(
          eq(accountingPostingRequests.companyId, ctx.companyId),
          eq(accountingPostingRequests.idempotencyKey, identity().idempotencyKey)
        )
      );
    expect(markers).toHaveLength(1);
    expect(markers[0].voucherId).toBe(first.voucher.id);

    const persistedVouchers = await db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(
        and(
          eq(vouchers.companyId, ctx.companyId),
          eq(vouchers.description, "Phase 3 infrastructure writer idempotency proof")
        )
      );
    expect(persistedVouchers).toHaveLength(1);

    const persistedEntries = await db
      .select({ id: voucherEntries.id })
      .from(voucherEntries)
      .where(eq(voucherEntries.voucherId, first.voucher.id));
    expect(persistedEntries).toHaveLength(2);
  });

  it("rejects the same source key when the financial payload changes", async () => {
    await expect(postInfrastructureVoucher("31.00")).rejects.toMatchObject({
      name: "PostingValidationError",
      code: "POSTING_IDEMPOTENCY_CONFLICT",
    });
  });

  it("creates a fresh active voucher after the previous posting was reversed and soft-deleted", async () => {
    const [beforeMarker] = await db
      .select()
      .from(accountingPostingRequests)
      .where(
        and(
          eq(accountingPostingRequests.companyId, ctx.companyId),
          eq(accountingPostingRequests.idempotencyKey, identity().idempotencyKey)
        )
      )
      .limit(1);
    expect(beforeMarker).toBeTruthy();
    const oldVoucherId = Number(beforeMarker.voucherId);

    await db.transaction(async (tx) => {
      await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, oldVoucherId));
      await tx.update(vouchers).set({ deletedAt: new Date() }).where(eq(vouchers.id, oldVoucherId));
    });

    const reposted = await postInfrastructureVoucher();
    expect(reposted.replayed).toBe(false);
    expect(reposted.voucher.id).not.toBe(oldVoucherId);
    expect(reposted.voucher.deletedAt).toBeNull();

    const [afterMarker] = await db
      .select()
      .from(accountingPostingRequests)
      .where(
        and(
          eq(accountingPostingRequests.companyId, ctx.companyId),
          eq(accountingPostingRequests.idempotencyKey, identity().idempotencyKey)
        )
      )
      .limit(1);
    expect(afterMarker?.voucherId).toBe(reposted.voucher.id);

    const newEntries = await db
      .select({ id: voucherEntries.id })
      .from(voucherEntries)
      .where(eq(voucherEntries.voucherId, reposted.voucher.id));
    expect(newEntries).toHaveLength(2);
  });
});
