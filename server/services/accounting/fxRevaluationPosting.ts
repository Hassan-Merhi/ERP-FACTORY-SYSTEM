/**
 * Automatic unrealized FX revaluation journal (owner decision, 2026-11-19).
 *
 * When a company exchange rate is saved, the USD book value of every
 * foreign-currency monetary balance (cash and bank, customers, loans) is
 * brought to the current rate with ONE balanced Journal against
 * "FX Revaluation Gain/Loss". This replaces the journal that was being
 * entered by hand after each rate change.
 *
 * The figures come from the monetary FX valuation used by Net Position
 * (getMonetaryFxValuation): for each account,
 *   adjustment = rounded current USD translation - rounded posted USD closing.
 * The six-decimal historical USD basis is retained for diagnostics, but using
 * it for postings would generate per-account one-cent reporting residues.
 * Each adjusted account gets a base-only line: it carries the account's own
 * foreign currency with a zero native amount, so native balances never move
 * and the account's historical USD basis becomes its current valuation. A
 * second run at the same rate therefore finds nothing to post.
 *
 * Never posted: accounts whose original currency is unresolved, generic
 * assets awaiting review, deleted accounts, a closed accounting date, and
 * differences below one cent. Those are reported back, not guessed.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import type { VoucherEntryInsertFields } from "./accountingTypes";
import { writeAuditEvent } from "../audit";
import { postErpEntriesTx } from "./erpVoucherPosting";
import { getMonetaryFxValuation, type MonetaryFxValuationRow } from "./monetaryFxValuationService";
import type { MonetaryFxCategory, MonetaryFxRate } from "./monetaryFxValuationCore";
import { ensureSystemAccounts } from "./systemAccounts";
import { findLegacyManualFxConflicts, legacyManualFxConflictReason } from "./legacyManualFxGuard";
import { postedFxRevaluationAdjustmentUsd } from "./fxRevaluationAmount";

export const FX_REVALUATION_SOURCE_TYPE = "fx-unrealized-revaluation";
/** The only line kind the database accepts with a base amount and no native amount (migration 0011). */
export const FX_REVALUATION_RATE_CONVENTION = "BASE_ONLY_REVALUATION";
const REVALUED_CATEGORIES: ReadonlySet<string> = new Set<MonetaryFxCategory>(["cash_bank", "customer", "loan"]);
const ONE_CENT = new Decimal("0.01");

export interface FxRevaluationLine {
  accountKind: MonetaryFxValuationRow["accountKind"];
  accountId: number;
  accountName: string;
  currency: string;
  nativeBalance: string;
  /** Positive raises the account's USD book value (debit), negative lowers it. */
  adjustmentUsd: string;
}

export interface FxRevaluationResult {
  status: "posted" | "nothing_to_post" | "skipped";
  reason?: string;
  businessDate: string;
  voucherId?: number;
  voucherNumber?: string;
  /** Net FX gain (+) or loss (-) booked by this journal, in USD. */
  netGainUsd: string;
  lines: FxRevaluationLine[];
  /** Eligible accounts that could not be revalued (unresolved currency or opening). */
  unresolvedAccounts: string[];
}

function foreignPerUsd(rate: MonetaryFxRate): string {
  const value = new Decimal(rate.rate);
  return (rate.direction === "FOREIGN_PER_USD" ? value : new Decimal(1).div(value)).toDecimalPlaces(10).toFixed(10);
}

/** The foreign currency a base-only adjustment line is carried in: the account's largest holding. */
function adjustmentCurrency(row: MonetaryFxValuationRow, rates: ReadonlyMap<string, MonetaryFxRate>): string | null {
  let best: string | null = null;
  let bestAbs = new Decimal(-1);
  for (const [currency, native] of Object.entries(row.nativeBalancesByCurrency)) {
    if (currency === "USD" || !rates.has(currency)) continue;
    const abs = new Decimal(native).abs();
    if (abs.gt(bestAbs)) {
      best = currency;
      bestAbs = abs;
    }
  }
  return best;
}

async function revaluationCount(executor: Pick<typeof db, "execute">, companyId: number): Promise<number> {
  const rows = resultRows<{ n: string }>(
    await executor.execute(sql`
      SELECT COUNT(*)::text AS n FROM accounting_posting_requests
       WHERE company_id = ${companyId} AND source_type = ${FX_REVALUATION_SOURCE_TYPE}
    `)
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Value the company's monetary balances at the current saved rate and post the
 * difference. Safe to call after every rate save: it posts only what is still
 * outstanding, and two simultaneous calls cannot both post the same difference.
 */
export async function postFxRevaluation(input: {
  companyId: number;
  actor: { userId: string; username: string };
  reason: string;
}): Promise<FxRevaluationResult> {
  const { companyId, actor } = input;
  for (let attempt = 0; attempt < 3; attempt++) {
    const sequence = await revaluationCount(db, companyId);
    const valuation = await getMonetaryFxValuation(companyId);
    const businessDate = valuation.businessDate;
    const rates = new Map(valuation.rates.map((rate) => [rate.currency, rate]));
    const lines: FxRevaluationLine[] = [];
    const targets: MonetaryFxValuationRow[] = [];
    const unresolvedAccounts: string[] = [];
    for (const row of valuation.accounts) {
      if (!REVALUED_CATEGORIES.has(row.eligibility) || row.deleted) continue;
      const holdsForeign = Object.entries(row.nativeBalancesByCurrency).some(
        ([currency, native]) => currency !== "USD" && !new Decimal(native).isZero()
      );
      if (row.provisional || row.translationDifferenceUsd === null) {
        if (holdsForeign || row.unresolvedOpening || row.unresolvedEntryCount > 0) unresolvedAccounts.push(row.name);
        continue;
      }
      // Reports display the posted book in cents. The six-decimal historic
      // base is diagnostic precision, not the amount to post again. Reconcile
      // each monetary target to its displayed translated USD balance exactly.
      if (row.currentTranslatedUsd === null) continue;
      const adjustment = new Decimal(postedFxRevaluationAdjustmentUsd(row.currentTranslatedUsd, row.bookClosingUsd));
      if (adjustment.abs().lt(ONE_CENT)) continue;
      const currency = adjustmentCurrency(row, rates);
      if (!currency) continue;
      targets.push(row);
      lines.push({
        accountKind: row.accountKind,
        accountId: row.id,
        accountName: row.name,
        currency,
        nativeBalance: row.nativeBalancesByCurrency[currency] ?? "0",
        adjustmentUsd: adjustment.toFixed(2),
      });
    }
    const netGain = lines.reduce((sum, line) => sum.plus(line.adjustmentUsd), new Decimal(0));
    const base = { businessDate, netGainUsd: netGain.toFixed(2), lines, unresolvedAccounts };
    if (valuation.baseCurrency !== "USD") {
      return { ...base, status: "skipped", reason: "The company's accounting base currency is not USD." };
    }
    // Old manual revaluations posted ordinary USD movements into foreign-currency
    // cash. Revaluing again would double-count the same loss. Fail closed until
    // that original journal is reversed and corrected with native-zero entries.
    const legacyConflicts = await findLegacyManualFxConflicts(db, companyId, businessDate);
    if (legacyConflicts.length) {
      return { ...base, status: "skipped", reason: legacyManualFxConflictReason(legacyConflicts) };
    }
    if (!lines.length) return { ...base, status: "nothing_to_post" };

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fx-unrealized-revaluation:${companyId}`}))`);
      // Another revaluation was posted since the balances were read: value again.
      if ((await revaluationCount(tx, companyId)) !== sequence) return "retry" as const;
      const open = await tx
        .execute(sql`SELECT erp_assert_accounting_date_open(${companyId}, ${businessDate}::date)`)
        .then(() => true)
        .catch(() => false);
      if (!open) return "closed" as const;
      return "open" as const;
    });
    if (outcome === "retry") continue;
    if (outcome === "closed") {
      return { ...base, status: "skipped", reason: `The accounting period for ${businessDate} is closed.` };
    }

    const posted = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`fx-unrealized-revaluation:${companyId}`}))`);
      if ((await revaluationCount(tx, companyId)) !== sequence) return null;
      // Recheck under the posting lock; a manual journal could have appeared
      // after the preflight valuation. Never post another FX adjustment over it.
      const conflicts = await findLegacyManualFxConflicts(tx, companyId, businessDate);
      if (conflicts.length) return { conflictReason: legacyManualFxConflictReason(conflicts) } as const;
      const status = (await ensureSystemAccounts(tx, companyId, ["FX-REVALUATION"]))[0];
      if (status?.state === "type_differs") {
        throw new Error(
          `FX Revaluation Gain/Loss account is typed "${status.actualType}" but must be "${status.expectedType}". Review the account before revaluation.`
        );
      }
      if (!status || !("accountId" in status) || !["ok", "created", "reused_by_name"].includes(status.state)) {
        throw new Error("The FX Revaluation Gain/Loss account is unavailable");
      }
      const entries: VoucherEntryInsertFields[] = [];
      lines.forEach((line, index) => {
        const row = targets[index];
        const amount = new Decimal(line.adjustmentUsd);
        const text = amount.abs().toFixed(2);
        const debit = amount.gt(0);
        const rate = rates.get(line.currency)!;
        const perUsd = foreignPerUsd(rate);
        const entry: VoucherEntryInsertFields = {
          debitAmount: debit ? text : "0",
          creditAmount: debit ? "0" : text,
          narration: `FX revaluation: ${line.currency} ${new Decimal(line.nativeBalance).toFixed(2)} at ${new Decimal(perUsd).toFixed(4)} per USD`,
          // Base-only: the native balance is unchanged, only its USD value moves.
          transactionCurrency: line.currency,
          transactionDebitAmount: "0",
          transactionCreditAmount: "0",
          baseDebitAmount: debit ? text : "0",
          baseCreditAmount: debit ? "0" : text,
          historicalExchangeRate: perUsd,
          rateConvention: FX_REVALUATION_RATE_CONVENTION,
        };
        if (row.accountKind === "bank") entry.bankAccountId = row.id;
        else if (row.accountKind === "customer") {
          entry.customerId = row.id;
          if (row.linkedLedgerId !== null) entry.ledgerAccountId = row.linkedLedgerId;
        } else entry.ledgerAccountId = row.id;
        entries.push(entry);
      });
      if (!netGain.isZero()) {
        const text = netGain.abs().toFixed(2);
        const gain = netGain.gt(0);
        entries.push({
          ledgerAccountId: status.accountId,
          debitAmount: gain ? "0" : text,
          creditAmount: gain ? text : "0",
          narration: gain ? "Unrealized FX gain on rate change" : "Unrealized FX loss on rate change",
          transactionCurrency: "USD",
          transactionDebitAmount: gain ? "0" : text,
          transactionCreditAmount: gain ? text : "0",
          baseDebitAmount: gain ? "0" : text,
          baseCreditAmount: gain ? text : "0",
          historicalExchangeRate: "1.0000000000",
          rateConvention: "IDENTITY",
        });
      }
      const rateText = [...new Set(lines.map((line) => line.currency))]
        .map((currency) => `1 USD = ${new Decimal(foreignPerUsd(rates.get(currency)!)).toFixed(4)} ${currency}`)
        .join(", ");
      const voucher = await postErpEntriesTx(tx, {
        companyId,
        voucherType: "Journal",
        voucherDate: businessDate,
        description: `Automatic FX revaluation (${rateText})`,
        currency: "USD",
        source: { type: FX_REVALUATION_SOURCE_TYPE, id: `${companyId}:${businessDate}`, revision: sequence + 1 },
        actor: { userId: actor.userId, username: actor.username, reason: input.reason },
        entries,
      });
      await writeAuditEvent(
        {
          companyId,
          userId: actor.userId,
          username: actor.username,
          action: "create",
          tableName: "vouchers",
          recordId: Number(voucher.voucher.id),
          recordIdentifier: String(voucher.voucher.voucherNumber),
          changes: {
            fxRevaluation: { new: { businessDate, rates: rateText, netGainUsd: netGain.toFixed(2), lines } },
            reason: { new: input.reason },
          },
        },
        tx
      );
      return { voucher: voucher.voucher } as const;
    });
    if (!posted) continue;
    if ("conflictReason" in posted) {
      return { ...base, status: "skipped", reason: posted.conflictReason };
    }
    return {
      ...base,
      status: "posted",
      voucherId: Number(posted.voucher.id),
      voucherNumber: String(posted.voucher.voucherNumber),
    };
  }
  throw new Error("FX revaluation is being posted by another request. Try again.");
}
