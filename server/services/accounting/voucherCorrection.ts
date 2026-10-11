/**
 * Correction policy for posted vouchers (accounting audit phase 22 A,
 * PE9/G4/G10; owner decision):
 *   - a posted voucher may be edited in place only in an OPEN period, and the
 *     edit writes an explicit application audit row with the full before/after
 *     snapshot in the edit's transaction (the phase 21 database trigger records
 *     the row images as well);
 *   - in a CLOSED period it is corrected by reversal and re-post only: an edit
 *     there is refused with 409 VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD, which
 *     names POST /api/vouchers/:id/reverse;
 *   - posted → optional is refused in a closed period and is an audited edit in
 *     an open one (it is an edit like any other).
 *
 * Writers use three helpers, inside their own transaction:
 *   const ctx = await assertVoucherEditableTx(tx, voucherId, { companyId, newVoucherDate });
 *   ... change the voucher ...
 *   await recordVoucherEditAuditTx(tx, { voucherId, before: ctx.before, actor, reason });
 * and reverseVoucherTx to reverse instead.
 *
 * "Closed" is the books lock the database closed-period guard enforces
 * (closedPeriodGuard.ts): the latest CLOSED fiscal_period_closures end date of
 * the company. The trigger stays the backstop; these helpers refuse first with
 * a code the UI can act on.
 */
import Decimal from "decimal.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Response } from "express";

import { vouchers, type Voucher } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpError";
import { resultRows } from "../../lib/queryResult";
import {
  readVoucherAuditState,
  writeVoucherAuditTx,
  type VoucherAuditActor,
  type VoucherAuditState,
} from "../../routes/helpers/voucherAuditTrail";
import { writeAuditEvent, type AuditChanges } from "../audit";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import type { PostedVoucher, PostedVoucherEntry, VoucherEntryInsertFields } from "./accountingTypes";
import { postBalancedVoucherTx, type CentralPostingDependencies, type PostingActor } from "./centralPostingEngine";
import { companyBusinessDate } from "./companyBusinessDate";
import { applyEmployeeBalanceDeltasTx } from "./employeeBalancePosting";
import { assertExactReversalAllowedTx, buildExactVoucherReversal } from "./voucherReversal";

export const VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD = "VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD";

export const VOUCHER_CORRECTION_MESSAGES = {
  notFound: "Voucher not found",
  deleted: "This voucher is deleted and cannot be changed or reversed.",
  closedPeriod:
    "This voucher is dated in a closed period and cannot be edited. Reverse it and post a corrected voucher dated in an open period instead.",
  reversedLocked:
    "This voucher has been reversed, or is itself a reversal, and cannot be edited. Post a new voucher instead.",
  reasonRequired: "A reason is required to reverse a voucher.",
  alreadyReversed: "This voucher has already been reversed.",
  reversalOfReversal: "A reversal voucher cannot itself be reversed.",
  optionalNotPosted: "An optional voucher is not posted to the ledger, so there is nothing to reverse.",
  reversalDateClosed: "The reversal date is in a closed period. Choose a date in an open period.",
  reversalDateInvalid: "The reversal date must be a YYYY-MM-DD date.",
} as const;

/** A refusal of the correction policy, with a stable code for the UI. */
export class VoucherCorrectionError extends HttpError {
  constructor(
    statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(statusCode, message);
    this.name = "VoucherCorrectionError";
  }

  body(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

/** Sends a VoucherCorrectionError as `{ code, message, ...details }`; false for any other error. */
export function sendVoucherCorrectionRefusal(res: Response, error: unknown): boolean {
  if (!(error instanceof VoucherCorrectionError)) return false;
  res.status(error.statusCode).json(error.body());
  return true;
}

/** The latest closed date of the company's books (inclusive), or null when nothing is closed. */
export async function companyClosedThroughTx(
  tx: Pick<DbTransaction, "execute">,
  companyId: number
): Promise<string | null> {
  const row = resultRows<{ closed_through: string | null }>(
    await tx.execute(sql`
      SELECT max(period_end_date)::text AS closed_through
        FROM fiscal_period_closures
       WHERE company_id = ${companyId} AND status = 'CLOSED'
    `)
  )[0];
  return row?.closed_through ?? null;
}

function dateOnly(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/**
 * Locks the voucher in its company. Without an explicit company, the voucher's
 * own company must be the transaction's scoped company
 * (assertTransactionCompanyScope), so a voucher id from another company is
 * refused rather than locked.
 */
async function lockVoucherTx(tx: DbTransaction, voucherId: number, companyId?: number): Promise<Voucher> {
  let ownerCompanyId = companyId;
  if (ownerCompanyId === undefined) {
    const owner = resultRows<{ company_id: number }>(
      await tx.execute(sql`SELECT company_id FROM vouchers WHERE id = ${voucherId}`)
    )[0];
    if (!owner) throw new VoucherCorrectionError(404, "VOUCHER_NOT_FOUND", VOUCHER_CORRECTION_MESSAGES.notFound);
    ownerCompanyId = Number(owner.company_id);
    await assertTransactionCompanyScope(tx, ownerCompanyId);
  }
  const locked = resultRows(
    await tx.execute(sql`SELECT id FROM vouchers WHERE id = ${voucherId} AND company_id = ${ownerCompanyId} FOR UPDATE`)
  );
  if (locked.length === 0) {
    throw new VoucherCorrectionError(404, "VOUCHER_NOT_FOUND", VOUCHER_CORRECTION_MESSAGES.notFound);
  }
  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, ownerCompanyId)))
    .limit(1);
  if (!voucher) throw new VoucherCorrectionError(404, "VOUCHER_NOT_FOUND", VOUCHER_CORRECTION_MESSAGES.notFound);
  return voucher;
}

/** The live voucher reversing `voucherId`, by link (phase 22) or by the legacy exact-reversal identity. */
async function liveReversalOfTx(tx: DbTransaction, companyId: number, voucherId: number): Promise<number | null> {
  const row = resultRows<{ id: number }>(
    await tx.execute(sql`
      SELECT v.id FROM vouchers v
       WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL
         AND (v.reversal_of_voucher_id = ${voucherId}
              OR v.id IN (SELECT apr.voucher_id FROM accounting_posting_requests apr
                           WHERE apr.company_id = ${companyId}
                             AND apr.idempotency_key = ${`voucher-reversal:${companyId}:${voucherId}`}))
       ORDER BY v.id LIMIT 1
    `)
  )[0];
  return row ? Number(row.id) : null;
}

export interface VoucherEditCheckOptions {
  /** When given, the voucher must belong to this company (else 404). */
  companyId?: number;
  /** The date the edit sets, when it changes it. */
  newVoucherDate?: string | null;
  newEffectiveDate?: string | null;
  /**
   * "delete" (a soft delete or retirement): a reversal voucher may be removed
   * (the original becomes reversible again), an original with a live reversal
   * may not. Default "edit": neither may be edited.
   */
  purpose?: "edit" | "delete";
}

export interface VoucherEditContext {
  voucher: Voucher;
  /** Header and lines before the edit, for recordVoucherEditAuditTx. */
  before: VoucherAuditState;
  closedThrough: string | null;
}

/**
 * Locks the voucher and refuses an in-place edit the correction policy does
 * not allow: a deleted voucher (409 VOUCHER_DELETED), a reversed voucher or a
 * reversal (409 VOUCHER_REVERSED_LOCKED), and a voucher whose current or new
 * date is in a closed period (409 VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD, with
 * `closedThrough` and `reverseRoute`). Call it for financial edits (amounts,
 * lines, dates, optional flag, deletion); description-only edits stay allowed.
 */
export async function assertVoucherEditableTx(
  tx: DbTransaction,
  voucherId: number,
  options: VoucherEditCheckOptions = {}
): Promise<VoucherEditContext> {
  const voucher = await lockVoucherTx(tx, voucherId, options.companyId);
  if (voucher.deletedAt) {
    throw new VoucherCorrectionError(409, "VOUCHER_DELETED", VOUCHER_CORRECTION_MESSAGES.deleted, { voucherId });
  }
  const closedThrough = await companyClosedThroughTx(tx, voucher.companyId);
  if (closedThrough) {
    const dates = [voucher.voucherDate, voucher.effectiveDate, options.newVoucherDate, options.newEffectiveDate]
      .map(dateOnly)
      .filter((date): date is string => date !== null);
    if (dates.some((date) => date <= closedThrough)) {
      throw new VoucherCorrectionError(
        409,
        VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD,
        VOUCHER_CORRECTION_MESSAGES.closedPeriod,
        { voucherId, closedThrough, reverseRoute: `/api/vouchers/${voucherId}/reverse` }
      );
    }
  }
  const isReversal = voucher.reversalOfVoucherId != null && options.purpose !== "delete";
  if (isReversal || (await liveReversalOfTx(tx, voucher.companyId, voucherId)) !== null) {
    throw new VoucherCorrectionError(409, "VOUCHER_REVERSED_LOCKED", VOUCHER_CORRECTION_MESSAGES.reversedLocked, {
      voucherId,
    });
  }
  return { voucher, before: await readVoucherAuditState(tx, voucherId), closedThrough };
}

/**
 * The application audit row of an open-period edit: the full header and every
 * line before (from assertVoucherEditableTx) and after (read now), in the
 * edit's transaction, so a failed audit refuses the edit.
 */
export async function recordVoucherEditAuditTx(
  tx: DbTransaction,
  input: {
    voucherId: number;
    before: VoucherAuditState;
    actor: VoucherAuditActor;
    reason?: string | null;
    /** Defaults to "update"; a soft delete passes "delete". */
    action?: "update" | "delete";
    extra?: AuditChanges;
  }
): Promise<VoucherAuditState> {
  const after = await readVoucherAuditState(tx, input.voucherId);
  await writeVoucherAuditTx(tx, {
    actor: { ...input.actor, companyId: input.actor.companyId ?? input.before.voucher?.companyId ?? null },
    action: input.action ?? "update",
    voucherId: input.voucherId,
    before: input.before,
    after,
    extra: { ...(input.extra ?? {}), correctionPolicy: { new: "open-period-edit" } },
    reason: input.reason ?? null,
  });
  return after;
}

function present(value: unknown): boolean {
  return value != null && String(value).trim() !== "";
}

function ledgerExactMirrorLine(entry: VoucherEntryInsertFields): VoucherEntryInsertFields {
  const normalized =
    present(entry.transactionCurrency) &&
    present(entry.transactionDebitAmount) &&
    present(entry.transactionCreditAmount) &&
    present(entry.baseDebitAmount) &&
    present(entry.baseCreditAmount) &&
    present(entry.historicalExchangeRate) &&
    present(entry.rateConvention);
  if (normalized) {
    return { ...entry, debitAmount: String(entry.baseDebitAmount), creditAmount: String(entry.baseCreditAmount) };
  }
  const debit = new Decimal(entry.debitAmount ?? "0");
  const credit = new Decimal(entry.creditAmount ?? "0");
  return {
    ...entry,
    debitAmount: debit.toFixed(2),
    creditAmount: credit.toFixed(2),
    transactionCurrency: "USD",
    transactionDebitAmount: debit.toFixed(6),
    transactionCreditAmount: credit.toFixed(6),
    baseDebitAmount: debit.toFixed(6),
    baseCreditAmount: credit.toFixed(6),
    historicalExchangeRate: "1.0000000000",
    rateConvention: "IDENTITY",
  };
}

export interface ReverseVoucherInput {
  voucherId: number;
  /** When given, the voucher must belong to this company. */
  companyId?: number;
  /** YYYY-MM-DD in an open period; defaults to the company's business date. */
  reversalDate?: string | null;
  reason: string;
  actor: PostingActor;
  description?: string | null;
}

export interface ReverseVoucherResult {
  original: Voucher;
  reversal: PostedVoucher;
  entries: PostedVoucherEntry[];
}

/**
 * Reverses a posted voucher: one mirror voucher (debits and credits swapped,
 * both currency sides and every target inherited), numbered and posted through
 * the central engine on `reversalDate`, linked by
 * `vouchers.reversal_of_voucher_id`, audited (`reverse`, with the reason) in
 * the same transaction. The original is never changed. Refused: a deleted or
 * optional original, a reversal, a voucher already reversed (409
 * VOUCHER_ALREADY_REVERSED; the partial unique index is the backstop), a
 * reversal date in a closed period, and a stock voucher after the
 * perpetual-inventory cut-over (409 PERPETUAL_INVENTORY_ACTIVE). Employee
 * balances follow the reversal lines. Linked sub-ledger documents (stock,
 * invoices, order charges) are not changed: correct them through their own
 * documents.
 */
export async function reverseVoucherTx(
  tx: DbTransaction,
  input: ReverseVoucherInput,
  dependencies: CentralPostingDependencies
): Promise<ReverseVoucherResult> {
  const reason = String(input.reason ?? "").trim();
  if (!reason) {
    throw new VoucherCorrectionError(
      400,
      "VOUCHER_REVERSAL_REASON_REQUIRED",
      VOUCHER_CORRECTION_MESSAGES.reasonRequired
    );
  }
  const original = await lockVoucherTx(tx, input.voucherId, input.companyId);
  const companyId = original.companyId;
  await assertTransactionCompanyScope(tx, companyId);

  if (original.deletedAt) {
    throw new VoucherCorrectionError(409, "VOUCHER_DELETED", VOUCHER_CORRECTION_MESSAGES.deleted, {
      voucherId: original.id,
    });
  }
  if (original.optional) {
    throw new VoucherCorrectionError(409, "VOUCHER_REVERSAL_OPTIONAL", VOUCHER_CORRECTION_MESSAGES.optionalNotPosted);
  }
  if (original.reversalOfVoucherId != null) {
    throw new VoucherCorrectionError(
      409,
      "VOUCHER_REVERSAL_CHAIN_FORBIDDEN",
      VOUCHER_CORRECTION_MESSAGES.reversalOfReversal
    );
  }
  const existingReversal = await liveReversalOfTx(tx, companyId, original.id);
  if (existingReversal !== null) {
    throw new VoucherCorrectionError(409, "VOUCHER_ALREADY_REVERSED", VOUCHER_CORRECTION_MESSAGES.alreadyReversed, {
      voucherId: original.id,
      reversalVoucherId: existingReversal,
    });
  }

  const reversalDate = input.reversalDate ? dateOnly(input.reversalDate) : await companyBusinessDate(companyId, tx);
  if (!reversalDate) {
    throw new VoucherCorrectionError(
      400,
      "VOUCHER_REVERSAL_DATE_INVALID",
      VOUCHER_CORRECTION_MESSAGES.reversalDateInvalid
    );
  }
  const closedThrough = await companyClosedThroughTx(tx, companyId);
  if (closedThrough && reversalDate <= closedThrough) {
    throw new VoucherCorrectionError(
      409,
      "VOUCHER_REVERSAL_DATE_CLOSED",
      VOUCHER_CORRECTION_MESSAGES.reversalDateClosed,
      {
        closedThrough,
      }
    );
  }
  await assertExactReversalAllowedTx(tx, companyId, original.id);

  const originalState = await readVoucherAuditState(tx, original.id);
  const built = buildExactVoucherReversal({
    companyId,
    originalVoucherId: original.id,
    original: { voucher: original, entries: originalState.entries },
    // Replaced below: the engine allocates the reversal's gapless number.
    reversalVoucherNumber: "allocated-by-engine",
    reversalDate,
    description: input.description ?? `Reversal of ${original.voucherNumber}: ${reason}`,
  });

  // The mirror is posted on the 6 dp base of each line (or, for a line without
  // its currency fields, on its 2 dp ledger amount as USD at rate 1), so every
  // line stores exactly the ledger amount of the original line, swapped.
  const entries = built.entries.map(ledgerExactMirrorLine);
  const totalAmount = entries
    .reduce((sum, entry) => sum.plus(new Decimal(entry.debitAmount ?? "0")), new Decimal(0))
    .toFixed();

  // A reversal retired later frees the original for a new one: each attempt has its own identity.
  const priorAttempts = resultRows<{ attempts: string | number }>(
    await tx.execute(sql`
      SELECT COUNT(*) AS attempts FROM vouchers
       WHERE company_id = ${companyId} AND reversal_of_voucher_id = ${original.id}
    `)
  )[0];
  const attempt = Number(priorAttempts?.attempts ?? 0) + 1;

  const posted = await postBalancedVoucherTx(
    tx,
    {
      voucher: {
        ...built.voucher,
        totalAmount,
        voucherNumber: undefined,
        optional: false,
        reversalOfVoucherId: original.id,
      },
      entries,
      source: {
        sourceType: "voucher-correction-reversal",
        sourceId: `${original.id}:${attempt}`,
        idempotencyKey: `voucher-correction-reversal:${companyId}:${original.id}:${attempt}`,
      },
      actor: { ...input.actor, reason },
    },
    dependencies
  );

  await applyEmployeeBalanceDeltasTx({
    tx,
    companyId,
    entries: posted.entries,
    direction: "apply",
    missingEmployeeBehavior: "skip",
  });

  await writeAuditEvent(
    {
      userId: input.actor.userId == null ? undefined : String(input.actor.userId),
      username: input.actor.username ?? undefined,
      companyId,
      action: "reverse",
      tableName: "vouchers",
      recordId: original.id,
      recordIdentifier: original.voucherNumber,
      changes: {
        reversal: {
          new: {
            voucherId: posted.voucher.id,
            voucherNumber: posted.voucher.voucherNumber,
            reversalDate,
          },
        },
        entryRows: { old: originalState.entries, new: posted.entries },
      },
      reason,
    },
    tx
  );

  return { original, reversal: posted.voucher, entries: posted.entries };
}

/** Whether a live voucher reverses `voucherId` (for read models and the UI). */
export async function isVoucherReversedTx(tx: DbTransaction, companyId: number, voucherId: number): Promise<boolean> {
  const [row] = await tx
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(
      and(eq(vouchers.companyId, companyId), eq(vouchers.reversalOfVoucherId, voucherId), isNull(vouchers.deletedAt))
    )
    .limit(1);
  return Boolean(row);
}
