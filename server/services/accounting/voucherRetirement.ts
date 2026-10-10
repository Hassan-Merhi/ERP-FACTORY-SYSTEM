/**
 * Voucher retirement (accounting audit wave 16 A).
 *
 * The system no longer hard-deletes a posted voucher. A voucher the system
 * removes — a linked journal replaced on re-post, the journal of a deleted
 * source document, a voucher replaced by a rebuild — is soft-deleted the way
 * a user delete is (vouchers.deleted_at; its lines stay with it), in the
 * caller's transaction, with one audit row per voucher in that transaction
 * holding the header and every line as they were.
 *
 * Deterministic voucher numbers (COGS-{sale}, FPOS-RCPT-{sale},
 * FACTORY-COMM-{container}, INTERCO-SRC-{company}-{date}, …) are unique across
 * the table, and many readers look a journal up by its number. A retired
 * voucher therefore gives its number up: it is renumbered
 * `{number}~DEL{id}` (audited), so the source can post its number again and
 * every lookup by number still finds only the live voucher. Its posting
 * identity is released the same way (`{key}#retired:{voucherId}`): the marker
 * keeps pointing at the retired voucher, and the next post of the source is a
 * new identity generation, not a replay of the retired one.
 *
 * A retired voucher is not restorable from Deleted Items
 * (`isRetiredVoucherNumber`): its source posted a replacement.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { accountingPostingRequests, voucherEntries, vouchers } from "@shared/schema";

import type { DatabaseOrTransaction } from "../../db";
import { writeAuditEvent } from "../audit";

export const RETIRED_VOUCHER_NUMBER_MARK = "~DEL";
export const RETIRED_POSTING_IDENTITY_MARK = "#retired:";
const VOUCHER_NUMBER_MAX_LENGTH = 100;
const RETIRED_NUMBER_PATTERN = /~DEL\d+$/;

export const RETIRED_VOUCHER_NOT_RESTORABLE = "RETIRED_VOUCHER_NOT_RESTORABLE" as const;
export const RETIRED_VOUCHER_NOT_RESTORABLE_MESSAGE =
  "This voucher was replaced when its source document was posted again, so it cannot be restored. The replacement is the live voucher.";

/** The number a retired voucher carries: its own number with `~DEL{id}`, within the column's 100 characters. */
export function retiredVoucherNumber(voucherNumber: string, voucherId: number): string {
  if (RETIRED_NUMBER_PATTERN.test(voucherNumber)) return voucherNumber;
  const suffix = `${RETIRED_VOUCHER_NUMBER_MARK}${voucherId}`;
  return `${voucherNumber.slice(0, VOUCHER_NUMBER_MAX_LENGTH - suffix.length)}${suffix}`;
}

/** True for a voucher number given up by retireVouchersTx. */
export function isRetiredVoucherNumber(voucherNumber: string | null | undefined): boolean {
  return RETIRED_NUMBER_PATTERN.test(String(voucherNumber ?? ""));
}

export interface VoucherRetirementActor {
  userId: string | number;
  username: string;
}

export interface RetireVouchersOptions {
  companyId: number;
  voucherIds: readonly (number | null | undefined)[];
  /** Why the system removes them, recorded in the audit row (for example "linked-journal-rebuild"). */
  reason: string;
  /** The user whose action removes them; the system otherwise. */
  actor?: VoucherRetirementActor | null;
  /** Extra context for the audit row. */
  metadata?: Record<string, unknown>;
}

export interface RetiredVoucher {
  id: number;
  voucherNumber: string;
  retiredNumber: string;
  alreadyDeleted: boolean;
}

/**
 * Soft-deletes the company's vouchers among `voucherIds` in the caller's
 * transaction: deleted_at set (kept when the voucher was already deleted),
 * number given up, posting identity released, one audit row each. Lines stay.
 * Ids of another company, of no voucher or of a voucher retired before are ignored. A voucher dated in a
 * closed period is refused by the closed-period trigger, as its hard delete was.
 */
export async function retireVouchersTx(
  tx: DatabaseOrTransaction,
  options: RetireVouchersOptions
): Promise<RetiredVoucher[]> {
  const ids = [...new Set(options.voucherIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))].sort(
    (a, b) => a - b
  );
  if (ids.length === 0) return [];
  const { companyId } = options;

  const found = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.companyId, companyId), inArray(vouchers.id, ids)))
    .orderBy(vouchers.id)
    .for("update");
  if (found.length === 0) return [];

  const lines = await tx
    .select()
    .from(voucherEntries)
    .where(
      inArray(
        voucherEntries.voucherId,
        found.map((voucher) => voucher.id)
      )
    )
    .orderBy(voucherEntries.id);

  const actor = options.actor ?? { userId: "system", username: `voucher-retirement:${options.reason}` };
  const retired: RetiredVoucher[] = [];
  for (const voucher of found) {
    // Retired before: nothing left to give up.
    if (voucher.deletedAt && isRetiredVoucherNumber(voucher.voucherNumber)) continue;
    const alreadyDeleted = voucher.deletedAt !== null;
    const deletedAt = voucher.deletedAt ?? new Date();
    const retiredNumber = retiredVoucherNumber(voucher.voucherNumber, voucher.id);
    await tx
      .update(vouchers)
      .set({ deletedAt, voucherNumber: retiredNumber })
      .where(and(eq(vouchers.id, voucher.id), eq(vouchers.companyId, companyId)));
    const released = await tx
      .update(accountingPostingRequests)
      .set({
        idempotencyKey: sql`${accountingPostingRequests.idempotencyKey} || ${RETIRED_POSTING_IDENTITY_MARK} || ${accountingPostingRequests.voucherId}::text`,
      })
      .where(
        and(
          eq(accountingPostingRequests.companyId, companyId),
          eq(accountingPostingRequests.voucherId, voucher.id),
          sql`position(${RETIRED_POSTING_IDENTITY_MARK} in ${accountingPostingRequests.idempotencyKey}) = 0`
        )
      )
      .returning({ id: accountingPostingRequests.id });

    await writeAuditEvent(
      {
        userId: actor.userId,
        username: actor.username,
        companyId,
        action: "delete",
        tableName: "vouchers",
        recordId: voucher.id,
        recordIdentifier: voucher.voucherNumber,
        changes: {
          softDelete: { new: true },
          deletedAt: { old: voucher.deletedAt, new: deletedAt },
          voucherNumber: { old: voucher.voucherNumber, new: retiredNumber },
          voucher: {
            old: {
              voucherType: voucher.voucherType,
              voucherDate: voucher.voucherDate,
              effectiveDate: voucher.effectiveDate,
              totalAmount: voucher.totalAmount,
              currency: voucher.currency,
              exchangeRate: voucher.exchangeRate,
              optional: voucher.optional,
              sourceModule: voucher.sourceModule,
              description: voucher.description,
            },
          },
          entries: { old: lines.filter((line) => line.voucherId === voucher.id) },
          reason: { new: options.reason },
          postingIdentityReleased: { new: released.length },
          ...(options.metadata ? { metadata: { new: options.metadata } } : {}),
        },
      },
      tx
    );
    retired.push({ id: voucher.id, voucherNumber: voucher.voucherNumber, retiredNumber, alreadyDeleted });
  }
  return retired;
}

/** Retires the company's vouchers with these numbers (live or deleted, not yet retired). */
export async function retireVouchersByNumberTx(
  tx: DatabaseOrTransaction,
  options: Omit<RetireVouchersOptions, "voucherIds"> & { voucherNumbers: readonly string[] }
): Promise<RetiredVoucher[]> {
  const numbers = [...new Set(options.voucherNumbers.filter((number) => number.length > 0))];
  if (numbers.length === 0) return [];
  const rows = await tx
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(and(eq(vouchers.companyId, options.companyId), inArray(vouchers.voucherNumber, numbers)));
  return retireVouchersTx(tx, { ...options, voucherIds: rows.map((row) => row.id) });
}

/** The signed-in user of a request, as the actor of a retirement. */
export function sessionRetirementActor(req: {
  session?: { userId?: string | number | null; username?: string | null } | null;
}): VoucherRetirementActor {
  const userId = req.session?.userId ?? "unknown";
  return { userId, username: req.session?.username || String(userId) };
}

/** The part of a pg client (pool connection inside BEGIN) the raw-SQL retirement uses. */
export interface RetirementPgClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * retireVouchersTx for code that holds a raw pg client inside its own BEGIN:
 * the same soft delete, renumbering, identity release and one audit row per
 * voucher (header and lines as they were), in the client's transaction.
 * Vouchers of every company in `voucherIds` are retired, each audited under
 * its own company. Returns the retired ids.
 */
export async function retireVouchersWithClient(
  client: RetirementPgClient,
  options: { voucherIds: readonly number[]; reason: string; actor?: VoucherRetirementActor | null }
): Promise<number[]> {
  const ids = [...new Set(options.voucherIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];
  const actor = options.actor ?? { userId: "system", username: `voucher-retirement:${options.reason}` };
  const found = await client.query<{
    id: number;
    company_id: number;
    voucher_number: string;
    deleted_at: Date | null;
    header: Record<string, unknown>;
    entries: Record<string, unknown>[];
  }>(
    `SELECT v.id, v.company_id, v.voucher_number, v.deleted_at,
            jsonb_build_object('voucherType', v.voucher_type, 'voucherDate', v.voucher_date,
              'effectiveDate', v.effective_date, 'totalAmount', v.total_amount, 'currency', v.currency,
              'exchangeRate', v.exchange_rate, 'optional', v.optional, 'sourceModule', v.source_module,
              'description', v.description) AS header,
            COALESCE((SELECT jsonb_agg(to_jsonb(ve) ORDER BY ve.id) FROM voucher_entries ve WHERE ve.voucher_id = v.id),
                     '[]'::jsonb) AS entries
       FROM vouchers v
      WHERE v.id = ANY($1::int[])
      ORDER BY v.id
      FOR UPDATE OF v`,
    [ids]
  );
  const retired: number[] = [];
  for (const voucher of found.rows) {
    if (voucher.deleted_at && isRetiredVoucherNumber(voucher.voucher_number)) continue;
    const retiredNumber = retiredVoucherNumber(voucher.voucher_number, voucher.id);
    const updated = await client.query<{ deleted_at: Date }>(
      `UPDATE vouchers SET deleted_at = COALESCE(deleted_at, NOW()), voucher_number = $2
        WHERE id = $1 AND company_id = $3 RETURNING deleted_at`,
      [voucher.id, retiredNumber, voucher.company_id]
    );
    const released = await client.query(
      `UPDATE accounting_posting_requests
          SET idempotency_key = idempotency_key || $2 || voucher_id::text
        WHERE voucher_id = $1 AND company_id = $3 AND position($2 in idempotency_key) = 0`,
      [voucher.id, RETIRED_POSTING_IDENTITY_MARK, voucher.company_id]
    );
    await client.query(
      `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_id, record_identifier, changes)
       VALUES ($1, $2, $3, 'delete', 'vouchers', $4, $5, $6::jsonb)`,
      [
        String(actor.userId),
        actor.username,
        voucher.company_id,
        voucher.id,
        voucher.voucher_number,
        JSON.stringify({
          softDelete: { new: true },
          deletedAt: { old: voucher.deleted_at, new: updated.rows[0]?.deleted_at ?? null },
          voucherNumber: { old: voucher.voucher_number, new: retiredNumber },
          voucher: { old: voucher.header },
          entries: { old: voucher.entries },
          reason: { new: options.reason },
          postingIdentityReleased: { new: released.rowCount ?? 0 },
        }),
      ]
    );
    retired.push(voucher.id);
  }
  return retired;
}

/** retireVouchersTx with the request's signed-in user as the actor. */
export function retireVouchersForRequestTx(
  tx: DatabaseOrTransaction,
  req: Parameters<typeof sessionRetirementActor>[0],
  companyId: number,
  voucherIds: readonly (number | null | undefined)[],
  reason: string
): Promise<RetiredVoucher[]> {
  return retireVouchersTx(tx, { companyId, voucherIds, reason, actor: sessionRetirementActor(req) });
}
