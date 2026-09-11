import type { DbTransaction, DatabaseOrTransaction } from "../../db";
import { createHash } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { accountingPostingRequests, auditLog, voucherEntries, vouchers } from "@shared/schema";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { PostingValidationError, type PostingSourceIdentity } from "./centralPostingEngine";

type VoucherInsert = typeof vouchers.$inferInsert;
type VoucherRow = typeof vouchers.$inferSelect;

interface DatabaseLike {
  transaction: <T>(callback: (tx: DbTransaction) => Promise<T>) => Promise<T>;
}

function requiredText(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new PostingValidationError("POSTING_SOURCE_REQUIRED", `${field} is required`);
  }
  return normalized;
}

export function assertPostingSourceIdentity(source: PostingSourceIdentity): PostingSourceIdentity {
  return {
    sourceType: requiredText(source?.sourceType, "sourceType"),
    sourceId: requiredText(source?.sourceId, "sourceId"),
    idempotencyKey: requiredText(source?.idempotencyKey, "idempotencyKey"),
  };
}

/**
 * Deterministic source identity for lower-level infrastructure writers.
 * The key is deliberately derived only from stable business identifiers — never
 * timestamps, random suffixes, or display voucher numbers.
 */
export function infrastructurePostingIdentity(
  sourceType: string,
  sourceId: string | number,
  phase = "voucher"
): PostingSourceIdentity {
  const normalizedType = requiredText(sourceType, "sourceType");
  const normalizedId = requiredText(sourceId, "sourceId");
  const normalizedPhase = requiredText(phase, "phase");
  return {
    sourceType: normalizedType,
    sourceId: `${normalizedId}:${normalizedPhase}`,
    idempotencyKey: `infra:${normalizedType}:${normalizedId}:${normalizedPhase}`,
  };
}

function stableVoucherFingerprint(
  voucher: VoucherInsert,
  source: PostingSourceIdentity,
  fingerprintPayload?: unknown
): string {
  // voucherNumber is intentionally excluded. A number may contain a legacy
  // Date.now/random display suffix; retry identity must come from the source.
  const { voucherNumber: _displayNumber, ...stableVoucher } = voucher;
  return createHash("sha256")
    .update(
      JSON.stringify({
        voucher: stableVoucher,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        fingerprintPayload: fingerprintPayload ?? null,
      })
    )
    .digest("hex");
}

function assertStoredIdentityMatches(input: {
  source: PostingSourceIdentity;
  requestFingerprint: string;
  stored: { sourceType: string; sourceId: string; requestFingerprint: string };
}) {
  const { source, requestFingerprint, stored } = input;
  if (stored.sourceType !== source.sourceType || stored.sourceId !== source.sourceId) {
    throw new PostingValidationError(
      "POSTING_IDEMPOTENCY_CONFLICT",
      `Idempotency key ${source.idempotencyKey} is already bound to ${stored.sourceType}:${stored.sourceId}`
    );
  }
  if (stored.requestFingerprint !== requestFingerprint) {
    throw new PostingValidationError(
      "POSTING_IDEMPOTENCY_CONFLICT",
      `Idempotency key ${source.idempotencyKey} was already used for a different infrastructure voucher payload`
    );
  }
}

/**
 * Transitional idempotent voucher-row boundary for infrastructure writers that
 * still build voucher entries themselves. The durable identity lives in the
 * same accounting_posting_requests table used by the Phase 2 central engine.
 *
 * Transaction-owned writers default to replace-in-transaction on replay: the
 * same voucher row is reused, old entry rows are cleared, and the caller's
 * existing code rebuilds them. If rebuilding fails, rollback restores the old
 * rows. Shell-only storage APIs can disable replacement until later phases move
 * their entry writes into the same transaction.
 */
export async function insertInfrastructureVoucherTx(
  tx: DatabaseOrTransaction,
  voucher: VoucherInsert,
  sourceInput: PostingSourceIdentity,
  fingerprintPayload?: unknown,
  options: { replaceEntriesOnReplay?: boolean } = {}
): Promise<{ voucher: VoucherRow; replayed: boolean }> {
  const source = assertPostingSourceIdentity(sourceInput);
  const companyId = Number(voucher.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new PostingValidationError("POSTING_COMPANY_INVALID", "A valid companyId is required");
  }

  await assertTransactionCompanyScope(tx, companyId);
  const requestFingerprint = stableVoucherFingerprint(voucher, source, fingerprintPayload);
  const lockKey = `accounting-posting:${companyId}:${source.idempotencyKey}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

  const [marker] = await tx
    .select({
      id: accountingPostingRequests.id,
      sourceType: accountingPostingRequests.sourceType,
      sourceId: accountingPostingRequests.sourceId,
      requestFingerprint: accountingPostingRequests.requestFingerprint,
      voucherId: accountingPostingRequests.voucherId,
    })
    .from(accountingPostingRequests)
    .where(
      and(
        eq(accountingPostingRequests.companyId, companyId),
        eq(accountingPostingRequests.idempotencyKey, source.idempotencyKey)
      )
    )
    .limit(1);

  if (marker) {
    const [existing] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, Number(marker.voucherId)), eq(vouchers.companyId, companyId)))
      .limit(1);

    // A reversal/correction may intentionally retire the old voucher while an
    // older code path leaves the durable idempotency marker behind. Replaying
    // that marker must never attach fresh entries to a soft-deleted voucher or
    // permanently block because the old voucher was hard-deleted. Retire only
    // the stale marker here; the caller then creates a fresh active voucher and
    // marker in the same transaction. Active vouchers keep strict replay and
    // payload-conflict protection below.
    if (!existing || existing.deletedAt) {
      await tx.delete(accountingPostingRequests).where(eq(accountingPostingRequests.id, marker.id));
    } else {
      // Historical failed infrastructure writes can leave a voucher shell and
      // durable idempotency marker behind with zero voucher entries. A corrected
      // retry then has a different fingerprint and would otherwise be blocked
      // forever. Self-heal only that provably orphaned state: same deterministic
      // source identity, changed fingerprint, and no posted entry rows. Real
      // posted vouchers keep strict conflict protection.
      if (
        marker.sourceType === source.sourceType &&
        marker.sourceId === source.sourceId &&
        marker.requestFingerprint !== requestFingerprint
      ) {
        const [entry] = await tx
          .select({ id: voucherEntries.id })
          .from(voucherEntries)
          .where(eq(voucherEntries.voucherId, existing.id))
          .limit(1);

        if (!entry) {
          const { id: _id, ...replacement } = voucher as VoucherInsert & { id?: unknown };
          const [repaired] = await tx
            .update(vouchers)
            .set(replacement)
            .where(and(eq(vouchers.id, existing.id), eq(vouchers.companyId, companyId)))
            .returning();

          await tx
            .update(accountingPostingRequests)
            .set({ requestFingerprint })
            .where(eq(accountingPostingRequests.id, marker.id));

          if (!repaired) {
            throw new PostingValidationError(
              "POSTING_IDEMPOTENCY_CORRUPT",
              `Idempotency marker ${source.idempotencyKey} could not repair its empty voucher shell`
            );
          }
          return { voucher: repaired, replayed: true };
        }
      }

      assertStoredIdentityMatches({ source, requestFingerprint, stored: marker });
      if (options.replaceEntriesOnReplay !== false) {
        await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, existing.id));
      }
      return { voucher: existing, replayed: true };
    }
  }

  const [created] = await tx.insert(vouchers).values(voucher).returning();
  if (!created) throw new Error("Voucher insert did not return a persisted voucher");

  await tx.insert(accountingPostingRequests).values({
    companyId,
    idempotencyKey: source.idempotencyKey,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    requestFingerprint,
    voucherId: created.id,
  });

  await tx.insert(auditLog).values({
    userId: "system",
    username: "infrastructure-voucher-writer",
    companyId,
    action: "create",
    tableName: "accounting_postings",
    recordId: created.id,
    recordIdentifier: source.idempotencyKey,
    changes: {
      sourceType: { new: source.sourceType },
      sourceId: { new: source.sourceId },
      idempotencyKey: { new: source.idempotencyKey },
      writer: { new: "infrastructure" },
    },
  });

  return { voucher: created, replayed: false };
}

export async function insertInfrastructureVoucher(
  database: DatabaseLike,
  voucher: VoucherInsert,
  source: PostingSourceIdentity,
  fingerprintPayload?: unknown
): Promise<{ voucher: VoucherRow; replayed: boolean }> {
  return database.transaction((tx) =>
    insertInfrastructureVoucherTx(tx, voucher, source, fingerprintPayload, { replaceEntriesOnReplay: false })
  );
}

/** Remove the durable marker before an intentional hard delete/rebuild. */
export async function deleteInfrastructurePostingIdentityForVoucherTx(
  tx: DatabaseOrTransaction,
  voucherId: number
): Promise<void> {
  await tx.delete(accountingPostingRequests).where(eq(accountingPostingRequests.voucherId, voucherId));
}

export async function deleteInfrastructurePostingIdentityForVoucher(
  database: DatabaseLike,
  voucherId: number
): Promise<void> {
  await database.transaction((tx) => deleteInfrastructurePostingIdentityForVoucherTx(tx, voucherId));
}
