/**
 * Phase 8: restricted cloud posting adapter for an already staged voucher.
 *
 * No HTTP endpoint or timer calls this adapter. A supervised operator must
 * freeze LAN writes and open an exclusive cloud DB epoch first. Posting and
 * the Phase 8 receipt always share the SAME PostgreSQL transaction/client.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and, inArray } from "drizzle-orm";
import type { PoolClient } from "pg";
import * as schema from "@shared/schema";
import { ledgerAccounts } from "@shared/schema";
import type { DbTransaction } from "../db";
import { postBalancedVoucherTx } from "../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../services/accounting/databasePostingDependencies";
import { buildGenericVoucherPostingRequest } from "../services/accounting/genericVoucherPosting";
import { Phase8ApplyRefusal } from "./phase8ApplyStore.mjs";
import { approvedPhase8JournalShape } from "./phase8VoucherPolicy.mjs";

type Phase8VoucherEvent = {
  siteId?: string;
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  localVoucherId: number;
  kind: string;
  payload: { voucher: Record<string, unknown>; entries: Array<Record<string, unknown>> };
};


const postingDeps = createDatabasePostingDependencies();

export async function postApprovedPhase8Journal(
  client: PoolClient,
  event: Phase8VoucherEvent,
  siteId: string
): Promise<{ cloudVoucherId: number; businessDate: string }> {
  const shape = approvedPhase8JournalShape(event);
  // A Drizzle session over the SAME leased pg client as the Phase 8 cursor.
  // The caller has already begun a transaction; do NOT call db.transaction()
  // or switch to another connection, because that breaks exactly-once atomicity.
  const tx = drizzle(client, { schema }) as unknown as DbTransaction;
  const accounts = await tx
    .select({ id: ledgerAccounts.id, code: ledgerAccounts.code, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, event.companyId), inArray(ledgerAccounts.id, shape.ledgerAccountIds)));
  if (accounts.length !== shape.ledgerAccountIds.length || accounts.some((a) =>
    /^(EMP-|INV-|STOCK-)/i.test(a.code ?? "") || /inventory|stock/i.test(a.accountType ?? "")
  )) {
    throw new Phase8ApplyRefusal("PHASE8_LEDGER_TARGET_NOT_APPROVED");
  }
  // NEVER apply the LAN voucher's original primary key or display number.
  // Database-posting dependencies recheck tenant ownership, fiscal period,
  // balanced amounts and idempotency against the target cloud company.
  const built = buildGenericVoucherPostingRequest({
    companyId: event.companyId,
    clientRequestId: `edge:${siteId}:${event.operationId}`,
    voucher: {
      voucherType: "Journal",
      voucherDate: shape.date,
      description: shape.voucher.description ?? null,
      currency: "USD",
      voucherNumber: undefined,
      optional: false,
    },
    entries: shape.entries,
    exchangeRate: shape.voucher.exchangeRate == null ? null : String(shape.voucher.exchangeRate),
    actor: {
      userId: event.actorUserId,
      username: "phase8-factory-replay",
      reason: `Approved factory replay ${siteId} seq ${event.sequence}`,
    },
  });
  const posted = await postBalancedVoucherTx(tx, built.request, postingDeps);
  if (posted.replayed) {
    // Only a receipt on this cursor can prove that the cloud posting and its
    // sequence mapping committed together. A preexisting idempotency marker
    // without the receipt is ambiguous and must NOT be silently acknowledged.
    throw new Phase8ApplyRefusal("PHASE8_ORPHANED_POSTING_IDENTITY");
  }
  const postedDate: unknown = posted.voucher.voucherDate;
  const cloudDate = postedDate instanceof Date
    ? postedDate.toISOString().slice(0, 10)
    : String(postedDate).slice(0, 10);
  if (cloudDate !== shape.date || posted.voucher.companyId !== event.companyId ||
      posted.entries.length !== shape.entries.length) {
    throw new Phase8ApplyRefusal("PHASE8_POSTING_RECONCILIATION_FAILED");
  }
  return { cloudVoucherId: posted.voucher.id, businessDate: shape.date };
}
