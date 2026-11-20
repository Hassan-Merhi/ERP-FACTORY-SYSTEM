// Extracted from ./voucherCorrection.ts
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { type Voucher } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import {
  readVoucherAuditState,
  writeVoucherAuditTx,
  type VoucherAuditActor,
  type VoucherAuditState,
} from "../../routes/helpers/voucherAuditTrail";
import { type AuditChanges } from "../audit";
import type { PostedVoucher, PostedVoucherEntry, VoucherEntryInsertFields } from "./accountingTypes";
import { type PostingActor } from "./centralPostingEngine";

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

export function dateOnly(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

/** The live voucher reversing `voucherId`, by link (phase 22) or by the legacy exact-reversal identity. */
export async function liveReversalOfTx(
  tx: DbTransaction,
  companyId: number,
  voucherId: number
): Promise<number | null> {
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

export function ledgerExactMirrorLine(entry: VoucherEntryInsertFields): VoucherEntryInsertFields {
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
