import { asc, eq } from "drizzle-orm";

import { voucherEntries, vouchers, type Voucher, type VoucherEntry } from "@shared/schema";
import type { DatabaseOrTransaction, DbTransaction } from "../../db";
import { writeAuditEvent, type AuditAction, type AuditChanges } from "../../services/audit";
import {
  buildVoucherChangesForCreate,
  buildVoucherChangesForDelete,
  buildVoucherChangesForUpdate,
  snapshotVoucherEntries,
} from "./auditHelpers";

/**
 * Wave 12 (audit trail, owner decision 2): every edit or delete of a voucher
 * writes a full before/after snapshot of the header and of every line to
 * audit_log INSIDE the transaction that changes it. If the audit insert fails
 * the transaction fails, so the change is refused rather than left unaudited.
 *
 * The audit row carries:
 *   - the readable summary the Audit Log page shows (voucherType, date,
 *     amount, description, `entries` as account/debit/credit), as before;
 *   - `voucher` — the complete header row before and after;
 *   - `entryRows` — every line row before and after, all columns, with no
 *     element cap (see FULL_SNAPSHOT_AUDIT_FIELDS in auditService).
 */
export type VoucherAuditState = { voucher: Voucher | null; entries: VoucherEntry[] };

export type VoucherAuditActor = {
  userId?: string | null;
  username?: string | null;
  companyId?: number | null;
};

/** Reads the voucher header and all of its lines on the given executor (normally the edit's transaction). */
export async function readVoucherAuditState(
  executor: DatabaseOrTransaction,
  voucherId: number
): Promise<VoucherAuditState> {
  const [voucher] = await executor.select().from(vouchers).where(eq(vouchers.id, voucherId));
  const entries = await executor
    .select()
    .from(voucherEntries)
    .where(eq(voucherEntries.voucherId, voucherId))
    .orderBy(asc(voucherEntries.id));
  return { voucher: voucher ?? null, entries };
}

/**
 * Writes the voucher's audit row on `tx`. `before` is null for a create and
 * `after` is null for a hard delete; a soft delete passes the state after
 * deleted_at was set. Throws when the insert fails, which rolls back `tx`.
 */
export async function writeVoucherAuditTx(
  tx: DbTransaction,
  params: {
    actor: VoucherAuditActor;
    action: AuditAction;
    voucherId: number;
    before: VoucherAuditState | null;
    after: VoucherAuditState | null;
    extra?: AuditChanges;
  }
): Promise<void> {
  const { before, after } = params;
  const beforeSnap = before ? await snapshotVoucherEntries(before.entries, tx) : [];
  const afterSnap = after ? await snapshotVoucherEntries(after.entries, tx) : [];

  let summary: AuditChanges;
  if (before?.voucher && after?.voucher && params.action !== "delete") {
    summary = buildVoucherChangesForUpdate(before.voucher, after.voucher, beforeSnap, afterSnap);
  } else if (before?.voucher && params.action === "delete") {
    summary = buildVoucherChangesForDelete(before.voucher, beforeSnap);
  } else if (after?.voucher) {
    summary = buildVoucherChangesForCreate(after.voucher, afterSnap);
  } else {
    summary = {};
  }

  const snapshot: AuditChanges = {
    voucher: {
      ...(before ? { old: before.voucher } : {}),
      ...(after ? { new: after.voucher } : {}),
    },
    entryRows: {
      ...(before ? { old: before.entries } : {}),
      ...(after ? { new: after.entries } : {}),
    },
  };

  const voucher = after?.voucher ?? before?.voucher ?? null;
  await writeAuditEvent(
    {
      userId: params.actor.userId ?? "unknown",
      username: params.actor.username || "unknown",
      companyId: params.actor.companyId ?? voucher?.companyId ?? null,
      action: params.action,
      tableName: "vouchers",
      recordId: params.voucherId,
      recordIdentifier: voucher?.voucherNumber ?? null,
      changes: { ...summary, ...snapshot, ...(params.extra ?? {}) },
    },
    tx
  );
}
