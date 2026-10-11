import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { accountingPostingRequests, voucherEntries, vouchers } from "../shared/schema";
import {
  buildPostingRequestFingerprint,
  postBalancedVoucherTx,
  PostingValidationError,
  type CentralPostingRequest,
} from "../server/services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../server/services/accounting/databasePostingDependencies";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "postidem";
const IDEMPOTENCY_KEY = "phase2-concurrent-request";

let ctx: TestContext;

function postingRequest(overrides: Partial<CentralPostingRequest["voucher"]> = {}): CentralPostingRequest {
  return {
    voucher: {
      companyId: ctx.companyId,
      voucherNumber: `IDEM-${ctx.companyId}`,
      voucherType: "Journal",
      voucherDate: "2026-08-17",
      totalAmount: "25.00",
      description: "Phase 2 concurrent idempotency proof",
      currency: "USD",
      sourceModule: "ERP",
      ...overrides,
    },
    entries: [
      {
        ledgerAccountId: ctx.cashAccountId,
        debitAmount: "25.00",
        creditAmount: "0",
        narration: "Idempotency debit",
      },
      {
        ledgerAccountId: ctx.salesAccountId,
        debitAmount: "0",
        creditAmount: "25.00",
        narration: "Idempotency credit",
      },
    ],
    source: {
      sourceType: "phase2-test",
      sourceId: `company-${ctx.companyId}`,
      idempotencyKey: IDEMPOTENCY_KEY,
    },
  };
}

async function clearPosting() {
  await db
    .delete(accountingPostingRequests)
    .where(
      and(
        eq(accountingPostingRequests.companyId, ctx.companyId),
        eq(accountingPostingRequests.idempotencyKey, IDEMPOTENCY_KEY)
      )
    );
  await deleteAuditLogRowsForTests(pool, "company_id = $1 AND record_identifier = $2", [
    ctx.companyId,
    IDEMPOTENCY_KEY,
  ]);

  const rows = await db
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(and(eq(vouchers.companyId, ctx.companyId), eq(vouchers.voucherNumber, `IDEM-${ctx.companyId}`)));
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

describe("canonical accounting posting idempotency", () => {
  it("fingerprints numerically equivalent retries identically", () => {
    const first = postingRequest();
    const retry = postingRequest({ totalAmount: "25.000" });
    retry.entries[0].debitAmount = "25.0";
    retry.entries[1].creditAmount = "25.0000";

    expect(buildPostingRequestFingerprint(retry)).toBe(buildPostingRequestFingerprint(first));
  });

  it("commits only one voucher when the same request arrives concurrently", async () => {
    const dependencies = createDatabasePostingDependencies();
    const request = postingRequest();

    const [first, second] = await Promise.all([
      db.transaction((tx) => postBalancedVoucherTx(tx, request, dependencies)),
      db.transaction((tx) => postBalancedVoucherTx(tx, request, dependencies)),
    ]);

    expect(first.voucher.id).toBe(second.voucher.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);

    const markers = await db
      .select()
      .from(accountingPostingRequests)
      .where(
        and(
          eq(accountingPostingRequests.companyId, ctx.companyId),
          eq(accountingPostingRequests.idempotencyKey, IDEMPOTENCY_KEY)
        )
      );
    expect(markers).toHaveLength(1);
    expect(markers[0].voucherId).toBe(first.voucher.id);
    expect(markers[0].requestFingerprint).toBe(buildPostingRequestFingerprint(request));

    const persisted = await db
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(and(eq(vouchers.companyId, ctx.companyId), eq(vouchers.voucherNumber, request.voucher.voucherNumber)));
    expect(persisted).toHaveLength(1);
  });

  it("rejects reuse of the same key for a changed financial payload", async () => {
    const dependencies = createDatabasePostingDependencies();
    const changed = postingRequest({ description: "This is a different financial request" });

    await expect(db.transaction((tx) => postBalancedVoucherTx(tx, changed, dependencies))).rejects.toMatchObject({
      name: "PostingValidationError",
      code: "POSTING_IDEMPOTENCY_CONFLICT",
    } satisfies Partial<PostingValidationError>);
  });
});
