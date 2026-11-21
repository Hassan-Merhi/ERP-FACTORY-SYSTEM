/** Controlled, audited replacement of a misdated automatic FX journal. */
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { writeAuditEvent } from "../audit";
import type { VoucherEntryInsertFields } from "./accountingTypes";
import { companyBusinessDate } from "./companyBusinessDate";
import {
  applyFxUsdAdjustmentOverrides,
  FxUsdAdjustmentOverrideError,
  type FxUsdAdjustmentOverride,
} from "./fxCorrectionAmountOverrides";
import { createDatabasePostingDependencies } from "./databasePostingDependencies";
import { postErpEntriesTx } from "./erpVoucherPosting";
import { postedFxRevaluationAdjustmentUsd } from "./fxRevaluationAmount";
import { FX_REVALUATION_RATE_CONVENTION, FX_REVALUATION_SOURCE_TYPE } from "./fxRevaluationPosting";
import { getMonetaryFxValuation } from "./monetaryFxValuationService";
import { ensureSystemAccounts } from "./systemAccounts";
import { companyClosedThroughTx, reverseVoucherTx } from "./voucherCorrection";

type Source = {
  id: number; voucher_number: string; voucher_date: string; effective_date: string | null;
  total_amount: string; optional: boolean; deleted: boolean; reversed: boolean; later_fx: boolean;
};
type OriginalEntry = {
  id: number; rate_convention: string | null; transaction_currency: string | null;
  transaction_debit_amount: string | null; transaction_credit_amount: string | null;
  historical_exchange_rate: string | null;
};
export type FxCorrectionLine = {
  accountKind: "ledger" | "bank" | "customer"; accountId: number; accountName: string;
  currency: string; adjustmentUsd: string;
  automaticAdjustmentUsd: string; manuallyOverridden: boolean;
};
export type FxCorrectionPreview = {
  status: "ready" | "blocked"; originalVoucherId: number; originalVoucherNumber: string;
  originalDate: string; targetDate: string; reversalDate: string;
  originalUsdTotal: string; correctedUsdTotal: string; netGainUsd: string;
  lines: FxCorrectionLine[]; blockers: string[]; previewKey: string | null;
};
export class FxCorrectionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "FxCorrectionError";
  }
}

function validDate(value: string): string {
  const day = String(value).slice(0, 10);
  const ms = Date.parse(day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) {
    throw new FxCorrectionError(400, "FX_CORRECTION_DATE_INVALID", "Choose a valid accounting date.");
  }
  return day;
}
function foreignPerUsd(rate: { rate: string; direction: "FOREIGN_PER_USD" | "USD_PER_FOREIGN" }) {
  const n = new Decimal(rate.rate);
  return (rate.direction === "FOREIGN_PER_USD" ? n : new Decimal(1).div(n)).toDecimalPlaces(10).toFixed(10);
}

async function readSource(companyId: number, voucherId: number) {
  const source = resultRows<Source>(await db.execute(sql`
    SELECT v.id, v.voucher_number, v.voucher_date::text, v.effective_date::text,
      v.total_amount::text, v.optional, (v.deleted_at IS NOT NULL) AS deleted,
      EXISTS (SELECT 1 FROM vouchers r WHERE r.company_id=v.company_id
        AND r.reversal_of_voucher_id=v.id AND r.deleted_at IS NULL) AS reversed,
      EXISTS (SELECT 1 FROM accounting_posting_requests p2
        JOIN vouchers v2 ON v2.id=p2.voucher_id
        WHERE p2.company_id=v.company_id AND p2.source_type=${FX_REVALUATION_SOURCE_TYPE}
          AND v2.deleted_at IS NULL AND v2.id<>v.id
          AND (v2.voucher_date>v.voucher_date
            OR (v2.voucher_date=v.voucher_date AND v2.id>v.id))) AS later_fx
    FROM vouchers v JOIN accounting_posting_requests p ON p.voucher_id=v.id
      AND p.company_id=v.company_id AND p.source_type=${FX_REVALUATION_SOURCE_TYPE}
    WHERE v.company_id=${companyId} AND v.id=${voucherId} LIMIT 1
  `))[0];
  if (!source) throw new FxCorrectionError(404, "FX_CORRECTION_NOT_AUTOMATIC",
    "This voucher is not an automatic FX revaluation in the selected company.");
  const originalEntries = resultRows<OriginalEntry>(await db.execute(sql`
    SELECT id, rate_convention, transaction_currency, transaction_debit_amount::text,
      transaction_credit_amount::text, historical_exchange_rate::text
    FROM voucher_entries WHERE voucher_id=${voucherId} ORDER BY id
  `));
  return { source, originalEntries };
}

export async function previewFxCorrection(
  companyId: number,
  voucherId: number,
  date: string,
  amountOverrides: readonly FxUsdAdjustmentOverride[] = []
) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !Number.isSafeInteger(voucherId) || voucherId <= 0) {
    throw new FxCorrectionError(400, "FX_CORRECTION_SCOPE_INVALID", "Invalid company or voucher.");
  }
  const targetDate = validDate(date);
  const { source, originalEntries } = await readSource(companyId, voucherId);
  const originalDate = validDate(source.effective_date || source.voucher_date);
  const reversalDate = validDate(source.voucher_date);
  const today = await companyBusinessDate(companyId);
  const closedThrough = await db.transaction(tx => companyClosedThroughTx(tx, companyId));
  const blockers: string[] = [];
  if (source.deleted || source.optional || source.reversed) blockers.push("Source voucher is deleted, optional or already reversed.");
  if (source.later_fx) blockers.push("Later FX revaluations depend on this journal. Review those first.");
  if (originalDate !== reversalDate) blockers.push("Original voucher has a different effective date; an accountant must review it.");
  if (targetDate >= originalDate) blockers.push("Choose an accounting date before the original journal.");
  if (targetDate > today) blockers.push("Future dates cannot be used.");
  if (closedThrough && (targetDate <= closedThrough || reversalDate <= closedThrough)) {
    blockers.push("Original or replacement date is in a closed accounting period.");
  }
  const sourceFx = originalEntries.filter(e => e.rate_convention === FX_REVALUATION_RATE_CONVENTION);
  if (originalEntries.length < 2 || !sourceFx.length ||
      originalEntries.some(e => ![FX_REVALUATION_RATE_CONVENTION, "IDENTITY"].includes(e.rate_convention ?? ""))) {
    blockers.push("Source lines are not a valid protected FX journal.");
  }
  for (const entry of sourceFx) {
    if (!entry.transaction_debit_amount || !entry.transaction_credit_amount ||
        new Decimal(entry.transaction_debit_amount).abs().gt(0) ||
        new Decimal(entry.transaction_credit_amount).abs().gt(0)) {
      blockers.push("An original FX line has unverified native-currency amounts.");
    }
  }
  // The dated ledger excludes this later-dated original journal. No current
  // balance is substituted for the selected accounting date.
  const valuation = await getMonetaryFxValuation(companyId, {}, targetDate);
  if (valuation.baseCurrency !== "USD") blockers.push("Only USD-base companies are supported.");
  const rates = new Map(valuation.rates.map(r => [r.currency, r]));
  for (const entry of sourceFx) {
    const c = entry.transaction_currency ?? "";
    const rate = rates.get(c);
    if (!rate || !entry.historical_exchange_rate ||
        new Decimal(foreignPerUsd(rate)).minus(entry.historical_exchange_rate).abs().gt("0.000001")) {
      blockers.push("The original " + c + " rate is not recorded for " + targetDate +
        ". Verify its effective date in Settings before correcting.");
    }
  }
  const lines: Omit<FxCorrectionLine, "automaticAdjustmentUsd" | "manuallyOverridden">[] = [];
  const entries: VoucherEntryInsertFields[] = [];
  for (const account of valuation.accounts) {
    if (account.deleted || !["cash_bank", "customer", "loan"].includes(account.eligibility)) continue;
    const foreign = Object.entries(account.nativeBalancesByCurrency)
      .filter(([currency, amount]) => currency !== "USD" && !new Decimal(amount).isZero())
      .sort((a, b) => new Decimal(b[1]).abs().comparedTo(new Decimal(a[1]).abs()));
    if (!foreign.length) continue;
    if (account.provisional || account.currentTranslatedUsd === null || account.translationDifferenceUsd === null) {
      blockers.push("Cannot verify historical monetary balance for " + account.name);
      continue;
    }
    const currency = foreign[0][0];
    const rate = rates.get(currency);
    if (!rate) {
      blockers.push("Historic rate missing for " + currency + " on " + targetDate);
      continue;
    }
    const delta = new Decimal(postedFxRevaluationAdjustmentUsd(account.currentTranslatedUsd, account.bookClosingUsd));
    if (delta.abs().lt("0.01")) continue;
    const amount = delta.abs().toFixed(2), debit = delta.gt(0);
    const entry: VoucherEntryInsertFields = {
      debitAmount: debit ? amount : "0", creditAmount: debit ? "0" : amount,
      narration: "FX revaluation: " + currency + " " + foreign[0][1] +
        " at " + foreignPerUsd(rate) + " per USD",
      transactionCurrency: currency, transactionDebitAmount: "0", transactionCreditAmount: "0",
      baseDebitAmount: debit ? amount : "0", baseCreditAmount: debit ? "0" : amount,
      historicalExchangeRate: foreignPerUsd(rate), rateConvention: FX_REVALUATION_RATE_CONVENTION,
    };
    if (account.accountKind === "bank") entry.bankAccountId = account.id;
    else if (account.accountKind === "customer") {
      entry.customerId = account.id;
      if (account.linkedLedgerId != null) entry.ledgerAccountId = account.linkedLedgerId;
    } else entry.ledgerAccountId = account.id;
    entries.push(entry);
    lines.push({ accountKind: account.accountKind, accountId: account.id,
      accountName: account.name, currency, adjustmentUsd: delta.toFixed(2) });
  }
  // Overrides may alter USD book valuation only, not the original CFA quantity,
  // FX currency, account, rate or native debit/credit. The counter-entry is
  // always derived afresh from the final signed account adjustments.
  let revisedLines: FxCorrectionLine[];
  try {
    revisedLines = applyFxUsdAdjustmentOverrides(lines, amountOverrides);
  } catch (error) {
    if (error instanceof FxUsdAdjustmentOverrideError) {
      throw new FxCorrectionError(400, error.code, error.message);
    }
    throw error;
  }
  const revisedEntries = entries.flatMap((entry, index) => {
    const line = revisedLines[index];
    const delta = new Decimal(line.adjustmentUsd);
    if (delta.isZero()) return [];
    const amount = delta.abs().toFixed(2);
    const debit = delta.gt(0);
    return [{
      ...entry,
      debitAmount: debit ? amount : "0",
      creditAmount: debit ? "0" : amount,
      baseDebitAmount: debit ? amount : "0",
      baseCreditAmount: debit ? "0" : amount,
      narration: line.manuallyOverridden
        ? "Manual USD FX valuation override: " + (entry.narration ?? "")
        : entry.narration,
    }];
  });
  const net = revisedLines.reduce((total, line) => total.plus(line.adjustmentUsd), new Decimal(0));
  if (!revisedEntries.length) blockers.push("At least one nonzero USD adjustment is required.");
  if (!lines.length) blockers.push("No eligible historical FX adjustment was found on the selected date.");
  const base = {
    originalVoucherId: voucherId, originalVoucherNumber: source.voucher_number,
    originalDate, targetDate, reversalDate,
    originalUsdTotal: new Decimal(source.total_amount).toFixed(2),
    correctedUsdTotal: Decimal.max(
      revisedEntries.reduce((sum, e) => sum.plus(e.debitAmount ?? "0"), new Decimal(0)),
      revisedEntries.reduce((sum, e) => sum.plus(e.creditAmount ?? "0"), new Decimal(0))
    ).toFixed(2),
    netGainUsd: net.toFixed(2), lines: revisedLines, blockers: [...new Set(blockers)],
  };
  const previewKey = base.blockers.length ? null : createHash("sha256").update(JSON.stringify({
    base, originalEntries, accounts: valuation.accounts, rates: valuation.rates, today,
  })).digest("hex");
  const preview: FxCorrectionPreview = {
    ...base, status: previewKey ? "ready" : "blocked", previewKey,
  };
  return { preview, entries: revisedEntries };
}

export async function applyFxCorrection(input: {
  companyId: number; voucherId: number; targetDate: string; previewKey: string;
  amountOverrides?: readonly FxUsdAdjustmentOverride[];
  reason: string; actor: { userId: string; username: string };
}) {
  if (!input.reason || input.reason.trim().length < 10) {
    throw new FxCorrectionError(400, "FX_CORRECTION_REASON_REQUIRED",
      "Provide an audit reason of at least 10 characters.");
  }
  return db.transaction(async tx => {
    const lockKey = "fx-unrealized-revaluation:" + input.companyId;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const { preview, entries } = await previewFxCorrection(
      input.companyId, input.voucherId, input.targetDate, input.amountOverrides
    );
    if (preview.lines.some((line) => line.manuallyOverridden) &&
        (input.reason.trim().length < 20 ||
         input.reason.trim() === "FX revaluation posted on the wrong business date")) {
      throw new FxCorrectionError(400, "FX_CORRECTION_OVERRIDE_REASON_REQUIRED",
        "Explain why the manually adjusted USD amounts differ from the automatic calculation.");
    }
    if (preview.status !== "ready" || preview.previewKey !== input.previewKey) {
      throw new FxCorrectionError(409, "FX_CORRECTION_PREVIEW_STALE",
        "The rate, voucher or ledger changed. Refresh the preview before confirming.");
    }
    const status = (await ensureSystemAccounts(tx, input.companyId, ["FX-REVALUATION"]))[0];
    if (!status || !("accountId" in status) || !["ok", "created", "reused_by_name"].includes(status.state)) {
      throw new FxCorrectionError(409, "FX_CORRECTION_COUNTER_INVALID",
        "FX Revaluation Gain/Loss must have the correct account classification.");
    }
    const nowClosed = await companyClosedThroughTx(tx, input.companyId);
    if (nowClosed && (preview.targetDate <= nowClosed || preview.reversalDate <= nowClosed)) {
      throw new FxCorrectionError(409, "FX_CORRECTION_PERIOD_CLOSED", "Accounting period was closed.");
    }
    const net = new Decimal(preview.netGainUsd);
    if (!net.isZero()) {
      const amount = net.abs().toFixed(2), gain = net.gt(0);
      entries.push({
        ledgerAccountId: status.accountId,
        debitAmount: gain ? "0" : amount, creditAmount: gain ? amount : "0",
        narration: gain ? "Unrealized FX gain (dated correction)" : "Unrealized FX loss (dated correction)",
        transactionCurrency: "USD",
        transactionDebitAmount: gain ? "0" : amount, transactionCreditAmount: gain ? amount : "0",
        baseDebitAmount: gain ? "0" : amount, baseCreditAmount: gain ? amount : "0",
        historicalExchangeRate: "1.0000000000", rateConvention: "IDENTITY",
      });
    }
    // One transaction: if the replacement fails, the exact original reversal
    // and the audit writes are also rolled back.
    const reversed = await reverseVoucherTx(tx, {
      voucherId: input.voucherId, companyId: input.companyId,
      reversalDate: preview.reversalDate, reason: input.reason, actor: input.actor,
    }, createDatabasePostingDependencies());
    const { n } = resultRows<{ n: string }>(await tx.execute(sql`
      SELECT COUNT(*)::text AS n FROM accounting_posting_requests
       WHERE company_id=${input.companyId} AND source_type=${FX_REVALUATION_SOURCE_TYPE}
    `))[0] ?? { n: "0" };
    const corrected = await postErpEntriesTx(tx, {
      companyId: input.companyId, voucherType: "Journal",
      voucherDate: preview.targetDate, effectiveDate: preview.targetDate,
      description: "Corrected automatic FX revaluation for " + preview.targetDate +
        " (replaces " + preview.originalVoucherNumber + ")",
      currency: "USD",
      source: { type: FX_REVALUATION_SOURCE_TYPE,
        id: input.companyId + ":" + preview.targetDate, revision: Number(n) + 1 },
      actor: { ...input.actor, reason: input.reason }, entries,
    });
    await writeAuditEvent({
      companyId: input.companyId, userId: input.actor.userId,
      username: input.actor.username, action: "repair", tableName: "vouchers",
      reason: input.reason,
      recordId: input.voucherId, recordIdentifier: preview.originalVoucherNumber,
      changes: { fxCorrection: { new: {
        originalVoucherId: input.voucherId,
        reversalVoucherId: reversed.reversal.id,
        replacementVoucherId: corrected.voucher.id,
        targetDate: preview.targetDate,
        previewKey: preview.previewKey, reason: input.reason,
        manualUsdAdjustments: preview.lines
          .filter((line) => line.manuallyOverridden)
          .map((line) => ({
            accountKind: line.accountKind, accountId: line.accountId, currency: line.currency,
            automaticUsd: line.automaticAdjustmentUsd, approvedUsd: line.adjustmentUsd,
          })),
      } } },
    }, tx);
    return {
      originalVoucherNumber: preview.originalVoucherNumber,
      reversalVoucherNumber: reversed.reversal.voucherNumber,
      correctedVoucherNumber: corrected.voucher.voucherNumber,
      correctedVoucherId: corrected.voucher.id,
      targetDate: preview.targetDate,
    };
  });
}
