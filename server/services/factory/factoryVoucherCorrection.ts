/**
 * Edits of posted factory / supplier-partner vouchers (accounting audit phase
 * 22 C: G4, PE9; owner decision "corrections" of 2026-10-10).
 *
 * Before: the container, container-freight, PO-reconciliation, finalize-loading
 * and order-charge writers rewrote posted lines in place with no audit row and
 * with the closed-period trigger as the only check (answered as a 400 / 500).
 *
 * Now every in-place edit of a posted voucher goes through
 * `editPostedFactoryVoucherTx` inside the writer's transaction, on the phase
 * 22 A correction policy (services/accounting/voucherCorrection.ts):
 *  - each voucher is locked and checked by `assertVoucherEditableTx`: dated
 *    (voucher or effective date, current or new) on or before the latest
 *    closed fiscal period → 409 VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD with the
 *    reverse route (correct it by reversal and re-post); a deleted, reversed
 *    or reversal voucher → 409; nothing is written;
 *  - in an open period the edit runs and `recordVoucherEditAuditTx` writes the
 *    application audit row (header and every line, before and after) in the
 *    same transaction.
 * Routes answer the refusal with `sendVoucherCorrectionRefusal`.
 */
import type { DbTransaction } from "../../db";
import {
  VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD,
  VOUCHER_CORRECTION_MESSAGES,
  VoucherCorrectionError,
  assertVoucherEditableTx,
  recordVoucherEditAuditTx,
  type VoucherEditContext,
} from "../accounting/voucherCorrection";

export { sendVoucherCorrectionRefusal, VoucherCorrectionError } from "../accounting/voucherCorrection";

export interface FactoryVoucherEditActor {
  userId?: string | number | null;
  username?: string | null;
}

/**
 * Run an in-place edit of posted vouchers: refused (409) when the policy does
 * not allow it; otherwise the edit plus one before/after audit row per
 * voucher, all in `tx`.
 */
export async function editPostedFactoryVoucherTx<T>(
  tx: DbTransaction,
  input: {
    companyId: number;
    voucherIds: number[];
    reason: string;
    actor?: FactoryVoucherEditActor;
    /** The date the edit sets, when it changes it. */
    newVoucherDate?: string | null;
  },
  edit: () => Promise<T>
): Promise<T> {
  const ids = [...new Set(input.voucherIds.filter((id) => Number.isInteger(id) && id > 0))];
  const contexts: VoucherEditContext[] = [];
  for (const voucherId of ids) {
    contexts.push(
      await assertVoucherEditableTx(tx, voucherId, {
        companyId: input.companyId,
        newVoucherDate: input.newVoucherDate ?? null,
      })
    );
  }
  const result = await edit();
  for (const context of contexts) {
    await recordVoucherEditAuditTx(tx, {
      voucherId: context.voucher.id,
      before: context.before,
      actor: {
        userId: input.actor?.userId == null ? undefined : String(input.actor.userId),
        username: input.actor?.username ?? undefined,
        companyId: input.companyId,
      },
      reason: input.reason,
    });
  }
  return result;
}

/** The minimal `pg` client surface the raw-client repair tools use. */
export interface RawQueryClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * The same correction policy for the Admin repair tools that run on a raw
 * `pg` client inside their own BEGIN/COMMIT: the voucher is locked; a voucher
 * dated (voucher or effective date) on or before the latest closed period is
 * refused with VoucherCorrectionError (409 VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD,
 * nothing written); otherwise the edit runs and one audit row with the header
 * and every line before and after is written on the same client.
 */
export async function editPostedVoucherWithClient<T>(
  client: RawQueryClient,
  input: { companyId: number; voucherId: number; reason: string; actor?: FactoryVoucherEditActor },
  edit: () => Promise<T>
): Promise<T> {
  const snapshot = async () => {
    const header = await client.query(`SELECT * FROM vouchers WHERE id = $1 AND company_id = $2`, [
      input.voucherId,
      input.companyId,
    ]);
    const lines = await client.query(`SELECT * FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`, [
      input.voucherId,
    ]);
    return { voucher: header.rows[0] ?? null, entries: lines.rows };
  };
  const locked = await client.query<{
    voucher_date: string | null;
    effective_date: string | null;
    voucher_number: string;
  }>(
    `SELECT voucher_date::text AS voucher_date, effective_date::text AS effective_date, voucher_number
       FROM vouchers WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [input.voucherId, input.companyId]
  );
  const row = locked.rows[0];
  if (!row) throw new VoucherCorrectionError(404, "VOUCHER_NOT_FOUND", "Voucher not found");
  const closed = await client.query<{ closed_through: string | null }>(
    `SELECT max(period_end_date)::text AS closed_through FROM fiscal_period_closures
      WHERE company_id = $1 AND status = 'CLOSED'`,
    [input.companyId]
  );
  const closedThrough = closed.rows[0]?.closed_through ?? null;
  if (closedThrough && [row.voucher_date, row.effective_date].some((date) => !!date && date <= closedThrough)) {
    throw new VoucherCorrectionError(
      409,
      VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD,
      VOUCHER_CORRECTION_MESSAGES.closedPeriod,
      { voucherId: input.voucherId, closedThrough, reverseRoute: `/api/vouchers/${input.voucherId}/reverse` }
    );
  }
  const before = await snapshot();
  const result = await edit();
  const after = await snapshot();
  await client.query(
    `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_id, record_identifier, changes)
     VALUES ($1, $2, $3, 'update', 'vouchers', $4, $5, $6::jsonb)`,
    [
      String(input.actor?.userId ?? "system"),
      String(input.actor?.username ?? input.actor?.userId ?? "system"),
      input.companyId,
      input.voucherId,
      row.voucher_number,
      JSON.stringify({
        voucher: { old: before.voucher, new: after.voucher },
        entries: { old: before.entries, new: after.entries },
        reason: { new: input.reason },
        correctionPolicy: { new: "open-period-edit" },
      }),
    ]
  );
  return result;
}
