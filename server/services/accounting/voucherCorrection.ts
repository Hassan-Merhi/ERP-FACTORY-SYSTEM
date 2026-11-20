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
import { and, eq, sql } from "drizzle-orm";
import type { Response } from "express";

import { vouchers, type Voucher } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpError";
import { isIntercompanyPairedVoucher, INTERCOMPANY_PAIRED_VOUCHER_LOCK_MESSAGE } from "../../lib/migratedVoucherGuard";
import { resultRows } from "../../lib/queryResult";
import { isAutomaticFxRevaluationVoucherTx } from "./automaticFxVoucherGuard";
import { readVoucherAuditState } from "../../routes/helpers/voucherAuditTrail";
import { writeAuditEvent } from "../audit";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { isDispatchFinancialVoucherTx } from "../factory/dispatchTripFinancialGuards";
import { postBalancedVoucherTx, type CentralPostingDependencies } from "./centralPostingEngine";
import { companyBusinessDate } from "./companyBusinessDate";
import { applyEmployeeBalanceDeltasTx } from "./employeeBalancePosting";
import { assertExactReversalAllowedTx, buildExactVoucherReversal } from "./voucherReversal";
import {
  isFxAgentSettlementVoucherTx,
  FX_AGENT_VOUCHER_LOCKED,
  FX_AGENT_VOUCHER_LOCKED_MESSAGE,
} from "./fxAgentVoucherLock";
import {
  VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD,
  VOUCHER_CORRECTION_MESSAGES,
  companyClosedThroughTx,
  dateOnly,
  liveReversalOfTx,
  ledgerExactMirrorLine,
  type VoucherEditCheckOptions,
  type VoucherEditContext,
  type ReverseVoucherInput,
  type ReverseVoucherResult,
} from "./voucherCorrectionHelpers";
export {
  VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD,
  VOUCHER_CORRECTION_MESSAGES,
  companyClosedThroughTx,
  recordVoucherEditAuditTx,
  type VoucherEditCheckOptions,
  type VoucherEditContext,
  type ReverseVoucherInput,
  type ReverseVoucherResult,
} from "./voucherCorrectionHelpers";

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
  if (isIntercompanyPairedVoucher(voucher)) {
    throw new VoucherCorrectionError(409, "IC_VOUCHER_IMMUTABLE", INTERCOMPANY_PAIRED_VOUCHER_LOCK_MESSAGE, {
      voucherId,
    });
  }
  if (await isDispatchFinancialVoucherTx(tx, voucher.companyId, voucherId)) {
    throw new VoucherCorrectionError(
      409,
      "DISPATCH_TRIP_VOUCHER_LOCKED",
      "This voucher belongs to a finalized Factory truck. Correct it through the Dispatch Management financial reversal workflow.",
      { voucherId }
    );
  }
  if (await isFxAgentSettlementVoucherTx(tx, voucher.companyId, [voucherId])) {
    throw new VoucherCorrectionError(409, FX_AGENT_VOUCHER_LOCKED, FX_AGENT_VOUCHER_LOCKED_MESSAGE, { voucherId });
  }
  if (voucher.deletedAt) {
    throw new VoucherCorrectionError(409, "VOUCHER_DELETED", VOUCHER_CORRECTION_MESSAGES.deleted, { voucherId });
  }
  // System FX revaluation lines are base-only: the generic Journal editor
  // rebuilds lines as USD/IDENTITY, silently manufacturing native USD movements.
  // Reject ordinary edits/deletion of these engine-owned journals. Repairs must
  // use a dedicated audited path that preserves the original currency evidence.
  await assertTransactionCompanyScope(tx, voucher.companyId);
  if (await isAutomaticFxRevaluationVoucherTx(tx, voucher.companyId, voucherId)) {
    throw new VoucherCorrectionError(
      409,
      "FX_REVALUATION_VOUCHER_IMMUTABLE",
      "Automatic FX revaluation vouchers cannot be edited using the general voucher editor. Use the audited FX correction workflow.",
      { voucherId }
    );
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
  if (isIntercompanyPairedVoucher(original)) {
    throw new VoucherCorrectionError(409, "IC_VOUCHER_IMMUTABLE", INTERCOMPANY_PAIRED_VOUCHER_LOCK_MESSAGE, {
      voucherId: original.id,
    });
  }
  const companyId = original.companyId;
  await assertTransactionCompanyScope(tx, companyId);
  if (await isDispatchFinancialVoucherTx(tx, companyId, original.id)) {
    throw new VoucherCorrectionError(
      409,
      "DISPATCH_TRIP_VOUCHER_LOCKED",
      "Trip-owned vouchers cannot be individually reversed. Use Dispatch Management financial reversal.",
      { voucherId: original.id }
    );
  }
  if (await isFxAgentSettlementVoucherTx(tx, companyId, [original.id])) {
    throw new VoucherCorrectionError(409, FX_AGENT_VOUCHER_LOCKED, FX_AGENT_VOUCHER_LOCKED_MESSAGE, {
      voucherId: original.id,
    });
  }

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
