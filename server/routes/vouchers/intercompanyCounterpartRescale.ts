/**
 * The intercompany counterpart of a journal edit (wave 18 B; phase 22 B, D8).
 *
 * When an active Journal named by `inter_company_transfers` is edited, the
 * other company's voucher follows inside the edit's transaction (a failure
 * rolls the edit back; nothing is swallowed):
 *
 *  - its lines are rescaled by the edit's ratio (new total / old total) in
 *    their own transaction currency, in Decimal: each line is the old amount
 *    times the ratio at cents, and the LAST line of each side takes the
 *    remainder, so both sides equal the rescaled side total exactly;
 *  - a normalized line gets its transaction_* and base amounts written
 *    together at its stored rate and convention (base at 6 places, as the
 *    currency trigger v2 computes it); a base remainder of that per-line
 *    conversion goes to the ROUNDING line of an engine voucher
 *    (`rebalanceVoucherRoundingTx`);
 *  - the correction policy applies to the counterpart too: dated in a closed
 *    period of its company, the edit is refused (409, reverse instead);
 *  - the transfer link follows: `inter_company_transfers.amount` and
 *    `transfer_date` take the edited journal's total and date (they used to
 *    keep the original values);
 *  - its total, factory daybook mirror and audit (under its own company) are
 *    written in the same transaction.
 *
 * A counterpart with lines in several currencies or rates, or a zero old
 * total, refuses the edit (409).
 */
import type Decimal from "decimal.js";
import { and, eq, or } from "drizzle-orm";
import { factoryDaybookEntries, interCompanyTransfers, voucherEntries, vouchers } from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpError";
import { MONEY_DECIMAL_PLACES, MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import { rebalanceVoucherRoundingTx } from "../../services/accounting/engineRounding";
import { assertVoucherEditableTx, recordVoucherEditAuditTx } from "../../services/accounting/voucherCorrection";

export const INTERCOMPANY_COUNTERPART_MIXED_CURRENCY_MESSAGE =
  "The intercompany counterpart voucher has lines in more than one currency or rate, so this edit cannot rescale it. Delete the journal and post the transfer again instead.";
export const INTERCOMPANY_COUNTERPART_ZERO_TOTAL_MESSAGE =
  "The journal had a zero total, so its intercompany counterpart cannot be rescaled. Delete the journal and post the transfer again instead.";

class CounterpartSyncRefused extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

export interface IntercompanyCounterpart {
  transferId: number;
  otherVoucherId: number;
  otherCompanyId: number;
}

/** The intercompany transfer naming the voucher and the other company, when there is one. */
export async function findIntercompanyCounterpart(
  voucherId: number,
  companyId: number
): Promise<IntercompanyCounterpart | null> {
  const [transfer] = await db
    .select()
    .from(interCompanyTransfers)
    .where(or(eq(interCompanyTransfers.fromVoucherId, voucherId), eq(interCompanyTransfers.toVoucherId, voucherId)))
    .limit(1);
  if (!transfer) return null;
  const isSource = transfer.fromVoucherId === voucherId;
  const otherVoucherId = isSource ? transfer.toVoucherId : transfer.fromVoucherId;
  const ownCompanyId = isSource ? transfer.fromCompanyId : transfer.toCompanyId;
  if (!otherVoucherId || otherVoucherId === voucherId || ownCompanyId !== companyId) return null;
  return {
    transferId: transfer.id,
    otherVoucherId,
    otherCompanyId: isSource ? transfer.toCompanyId : transfer.fromCompanyId,
  };
}

/** Base amount of a transaction amount under the line's stored rate (as the currency trigger computes it). */
function baseOf(amount: Decimal, convention: string | null, rate: string | null): Decimal {
  if (!convention || convention === "IDENTITY") return amount;
  const exactRate = toMoney(rate);
  if (!exactRate.gt(0)) throw new Error("Counterpart line has no positive historical rate");
  const base = convention === "BASE_PER_TRANSACTION" ? amount.times(exactRate) : amount.dividedBy(exactRate);
  return base.toDecimalPlaces(6);
}

/**
 * The amounts times `ratio` at cents, the last one taking the remainder so the
 * result adds up to `total` exactly.
 */
export function rescaleWithRemainderOnLast(amounts: readonly Decimal[], ratio: Decimal, total: Decimal): Decimal[] {
  if (amounts.length === 0) return [];
  const scaled = amounts.map((amount) =>
    amount.times(ratio).toDecimalPlaces(MONEY_DECIMAL_PLACES, MoneyDecimal.ROUND_HALF_UP)
  );
  const head = scaled.slice(0, -1);
  return [...head, total.minus(sumMoney(head))];
}

export async function syncIntercompanyCounterpartTx(
  tx: DbTransaction,
  params: {
    voucherId: number;
    counterpart: IntercompanyCounterpart;
    oldTotal: string | null;
    newTotal: string | null;
    /** The edited journal's date after the edit (the transfer date follows it). */
    newVoucherDate: string;
    actor: { userId?: string | null; username?: string | null };
  }
): Promise<void> {
  const { voucherId, counterpart } = params;
  const { otherVoucherId, otherCompanyId } = counterpart;
  const oldTotal = toMoney(params.oldTotal);
  const newTotal = toMoney(params.newTotal);

  const [transfer] = await tx
    .select({ amount: interCompanyTransfers.amount, transferDate: interCompanyTransfers.transferDate })
    .from(interCompanyTransfers)
    .where(eq(interCompanyTransfers.id, counterpart.transferId))
    .for("update");
  if (oldTotal.equals(newTotal)) {
    if (transfer && transfer.transferDate !== params.newVoucherDate) {
      await tx
        .update(interCompanyTransfers)
        .set({ transferDate: params.newVoucherDate })
        .where(eq(interCompanyTransfers.id, counterpart.transferId));
    }
    return;
  }
  if (!oldTotal.gt(0)) throw new CounterpartSyncRefused(INTERCOMPANY_COUNTERPART_ZERO_TOTAL_MESSAGE);
  const ratio = newTotal.dividedBy(oldTotal);
  // The link's amount is in the transfer's own currency: it moves by the same ratio.
  const newTransferAmount = transfer
    ? toMoney(transfer.amount).times(ratio).toDecimalPlaces(MONEY_DECIMAL_PLACES, MoneyDecimal.ROUND_HALF_UP).toFixed(2)
    : null;

  // Locks the counterpart; refused when it is deleted, reversed or dated in a
  // closed period of its company.
  const [live] = await tx
    .select({ id: vouchers.id, deletedAt: vouchers.deletedAt })
    .from(vouchers)
    .where(and(eq(vouchers.id, otherVoucherId), eq(vouchers.companyId, otherCompanyId)));
  if (!live || live.deletedAt) return;
  const editContext = await assertVoucherEditableTx(tx, otherVoucherId, { companyId: otherCompanyId });

  const otherEntries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, otherVoucherId));
  const shapes = new Set(
    otherEntries.map((entry) =>
      entry.transactionCurrency
        ? `${entry.transactionCurrency}|${entry.rateConvention ?? ""}|${toMoney(entry.historicalExchangeRate).toFixed()}`
        : "legacy"
    )
  );
  if (shapes.size > 1) throw new CounterpartSyncRefused(INTERCOMPANY_COUNTERPART_MIXED_CURRENCY_MESSAGE);

  type Entry = (typeof otherEntries)[number];
  const txDebit = (entry: Entry) =>
    toMoney(entry.transactionCurrency ? entry.transactionDebitAmount : entry.debitAmount);
  const txCredit = (entry: Entry) =>
    toMoney(entry.transactionCurrency ? entry.transactionCreditAmount : entry.creditAmount);
  const debitLines = otherEntries.filter((entry) => txDebit(entry).gt(0));
  const creditLines = otherEntries.filter((entry) => txCredit(entry).gt(0));
  const newSideTotal = sumMoney(debitLines.map(txDebit))
    .times(ratio)
    .toDecimalPlaces(MONEY_DECIMAL_PLACES, MoneyDecimal.ROUND_HALF_UP);
  // Each side to the same exact total, so the voucher balances in its own currency.
  const newDebits = rescaleWithRemainderOnLast(debitLines.map(txDebit), ratio, newSideTotal);
  const newCredits = rescaleWithRemainderOnLast(creditLines.map(txCredit), ratio, newSideTotal);

  let newBaseTotal = new MoneyDecimal(0);
  const writeLine = async (entry: Entry, amount: Decimal, side: "debit" | "credit") => {
    if (!entry.transactionCurrency) {
      // Legacy line (no transaction amounts): the base column is the amount.
      if (side === "debit") newBaseTotal = newBaseTotal.plus(amount);
      await tx
        .update(voucherEntries)
        .set(side === "debit" ? { debitAmount: amount.toFixed(2) } : { creditAmount: amount.toFixed(2) })
        .where(eq(voucherEntries.id, entry.id));
      return;
    }
    const base = baseOf(amount, entry.rateConvention, entry.historicalExchangeRate);
    if (side === "debit") newBaseTotal = newBaseTotal.plus(base);
    const transaction = amount.toFixed(6);
    const baseText = base.toFixed(6);
    await tx
      .update(voucherEntries)
      .set(
        side === "debit"
          ? {
              transactionDebitAmount: transaction,
              transactionCreditAmount: "0.000000",
              baseDebitAmount: baseText,
              baseCreditAmount: "0.000000",
              debitAmount: baseText,
              creditAmount: "0",
            }
          : {
              transactionDebitAmount: "0.000000",
              transactionCreditAmount: transaction,
              baseDebitAmount: "0.000000",
              baseCreditAmount: baseText,
              debitAmount: "0",
              creditAmount: baseText,
            }
      )
      .where(eq(voucherEntries.id, entry.id));
  };
  for (const [index, entry] of debitLines.entries()) await writeLine(entry, newDebits[index], "debit");
  for (const [index, entry] of creditLines.entries()) await writeLine(entry, newCredits[index], "credit");

  await tx
    .update(vouchers)
    .set({ totalAmount: newBaseTotal.toFixed(6) })
    .where(eq(vouchers.id, otherVoucherId));
  // The base remainder of the per-line conversion (a non-USD counterpart).
  await rebalanceVoucherRoundingTx(tx, { companyId: otherCompanyId, voucherId: otherVoucherId });
  await tx
    .update(factoryDaybookEntries)
    .set({ amountCurrency: newSideTotal.toFixed(2), amountUsd: newBaseTotal.toFixed(2) })
    .where(
      and(eq(factoryDaybookEntries.referenceTable, "vouchers"), eq(factoryDaybookEntries.referenceId, otherVoucherId))
    );
  // The transfer link follows the edited journal (D8).
  if (transfer && newTransferAmount !== null) {
    await tx
      .update(interCompanyTransfers)
      .set({ amount: newTransferAmount, transferDate: params.newVoucherDate })
      .where(eq(interCompanyTransfers.id, counterpart.transferId));
  }
  // The counterpart's rescaled lines are audited under its own company, in this transaction.
  await recordVoucherEditAuditTx(tx, {
    voucherId: otherVoucherId,
    before: editContext.before,
    actor: { ...params.actor, companyId: otherCompanyId },
    reason: "Intercompany counterpart of a journal edit",
    extra: {
      interCompanyCounterpartOf: { new: { voucherId } },
      rescale: { old: oldTotal.toFixed(), new: newTotal.toFixed() },
      interCompanyTransfer: {
        old: transfer ? { amount: transfer.amount, transferDate: transfer.transferDate } : null,
        new: { amount: newTransferAmount, transferDate: params.newVoucherDate },
      },
    },
  });
}
