/**
 * A Journal voucher, posted the one way both the live route
 * (POST /api/vouchers/journal) and the offline replay
 * (server/edge/phase9JournalApply.ts) post it: entries normalized to the
 * historical base (USD) at the voucher's rate, the central posting engine
 * (an optional journal is a direct insert, off the ledger), order charges
 * synced, employee balances updated and the audit row written, all on the
 * caller's transaction. A repeat of the same source id is a replay.
 */
import type { DbTransaction } from "../../db";
import { syncEmployeeBalancesFromEntries } from "../../routes/_helpers";
import { writeVoucherAuditTx } from "../../routes/helpers/voucherAuditTrail";
import {
  journalBaseTotal,
  journalRate,
  journalTotals,
  syncJournalToOrderCharge,
} from "../../routes/vouchers/syncJournalToOrderCharge";
import { normalizeVoucherEntryAmounts } from "./currencyAmounts";
import type { PostingActor } from "./centralPostingEngine";
import { postManualVoucherTx } from "./erpVoucherPosting";
import { isVoucherAccountType, voucherEntryAccountLink } from "./voucherEntryAccountLink";
import { assertApprovedZmwVoucherRate } from "./zambiaVoucherRatePolicy";

export interface JournalVoucherEntryInput {
  type: "DR" | "CR";
  accountType: string;
  accountId: number;
  amount: string;
  narration?: string | null;
}

export interface JournalVoucherInput {
  companyId: number;
  voucherDate: string;
  entries: JournalVoucherEntryInput[];
  notes: string | null;
  optional: boolean;
  currency: string;
  exchangeRate: string | number | null;
  effectiveDate: string | null;
  /** Unique per request: a repeat posts nothing and returns the first voucher. */
  sourceId: string;
  sourceType: string;
  /** As the route builds it (sessionPostingActor). */
  postingActor: PostingActor;
  /** As the route writes it to the audit row. */
  auditActor: { userId?: string | null; username?: string | null };
}

/** The input itself is wrong (the route answers 400; a replay records a conflict). */
export class JournalVoucherInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JournalVoucherInputError";
  }
}

/**
 * The checks that need no database: required fields, and debits equal credits
 * (in the voucher's currency) unless the journal is optional. The route runs
 * them before opening a transaction; the posting runs them again.
 */
export function checkJournalVoucherInput(input: {
  voucherDate: unknown;
  entries: unknown;
  optional: boolean;
}): asserts input is { voucherDate: string; entries: JournalVoucherEntryInput[]; optional: boolean } {
  if (!input.voucherDate || !Array.isArray(input.entries) || input.entries.length === 0) {
    throw new JournalVoucherInputError("Missing required fields");
  }
  const totals = journalTotals(input.entries);
  if (!input.optional && totals.debits.minus(totals.credits).abs().greaterThanOrEqualTo(0.01)) {
    throw new JournalVoucherInputError("Total debits must equal total credits");
  }
}

export async function postJournalVoucherTx(tx: DbTransaction, input: JournalVoucherInput) {
  checkJournalVoucherInput(input);
  const vCurrency = input.currency || "USD";
  const vRateRaw = await assertApprovedZmwVoucherRate(
    input.companyId,
    input.voucherDate,
    vCurrency,
    input.exchangeRate
  );
  const cfaPerUsd = journalRate(vCurrency, vRateRaw);
  const totals = journalTotals(input.entries);
  const baseTotalMax = journalBaseTotal(vCurrency, totals, cfaPerUsd);

  const voucherEntriesToCreate = input.entries.map((entry) => {
    const accountField = isVoucherAccountType(entry.accountType)
      ? voucherEntryAccountLink(entry.accountType, entry.accountId)
      : {};
    const norm = normalizeVoucherEntryAmounts({
      transactionCurrency: vCurrency,
      baseCurrency: "USD",
      transactionDebitAmount: entry.type === "DR" ? entry.amount : "0",
      transactionCreditAmount: entry.type === "CR" ? entry.amount : "0",
      historicalRate: vRateRaw,
    });
    return {
      ...accountField,
      debitAmount: norm.debitAmount,
      creditAmount: norm.creditAmount,
      transactionCurrency: norm.transactionCurrency,
      transactionDebitAmount: norm.transactionDebitAmount,
      transactionCreditAmount: norm.transactionCreditAmount,
      baseDebitAmount: norm.baseDebitAmount,
      baseCreditAmount: norm.baseCreditAmount,
      historicalExchangeRate: norm.historicalExchangeRate,
      rateConvention: norm.rateConvention,
      narration: entry.narration || null,
    };
  });

  // Phase 22 (B): an active journal posts through the central engine (number
  // allocated there); an optional one keeps a direct insert with an allocated
  // number (it is off the ledger and may be unbalanced).
  const posted = await postManualVoucherTx(tx, {
    companyId: input.companyId,
    voucherType: "Journal",
    voucherDate: input.voucherDate,
    description: input.notes || null,
    currency: vCurrency,
    exchangeRate: vRateRaw ? String(vRateRaw) : null,
    effectiveDate: input.effectiveDate || null,
    optional: input.optional === true,
    optionalTotalAmount: baseTotalMax.toFixed(6),
    entries: voucherEntriesToCreate,
    source: { type: input.sourceType, id: input.sourceId },
    actor: input.postingActor,
  });
  if (posted.replayed) return { voucher: posted.voucher, entries: posted.entries, replayed: true };
  const createdVoucher = posted.voucher;
  const createdEntries = posted.entries;
  // Sync order charges automatically, in this transaction.
  await syncJournalToOrderCharge(tx, input.companyId, createdEntries, createdVoucher.id);
  // Wave 12: employee balances and the audit row are written in this transaction.
  if (!createdVoucher.optional) {
    await syncEmployeeBalancesFromEntries(createdEntries, input.companyId, false, tx);
  }
  await writeVoucherAuditTx(tx, {
    actor: { ...input.auditActor, companyId: input.companyId },
    action: "create",
    voucherId: createdVoucher.id,
    before: null,
    after: { voucher: createdVoucher, entries: createdEntries },
  });
  return { voucher: createdVoucher, entries: createdEntries, replayed: false };
}
