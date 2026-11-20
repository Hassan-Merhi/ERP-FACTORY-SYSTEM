/**
 * Read-only preflight for a legacy manual FX revaluation correction.
 *
 * A successful preview NEVER authorizes a write on its own. The original
 * voucher, ledger account classifications and company rate must be checked
 * again inside the eventual corrective posting transaction.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { getMonetaryFxValuation } from "./monetaryFxValuationService";
import { postedFxRevaluationAdjustmentUsd } from "./fxRevaluationAmount";
import { findLegacyManualFxConflicts } from "./legacyManualFxGuard";

interface VoucherHeader extends Record<string, unknown> {
  id: number;
  voucher_number: string;
  voucher_date: string;
  source_type: string | null;
  deleted: boolean;
  optional: boolean;
  reversed: boolean;
  reversal_of_voucher_id: number | null;
}

interface VoucherLine extends Record<string, unknown> {
  id: number;
  ledger_account_id: number | null;
  bank_account_id: number | null;
  customer_id: number | null;
  account_code: string | null;
  account_name: string | null;
  account_type: string | null;
  debit_amount: string;
  credit_amount: string;
  transaction_currency: string | null;
  transaction_debit_amount: string | null;
  transaction_credit_amount: string | null;
  rate_convention: string | null;
}

export interface ManualFxCorrectionCandidate {
  accountKey: string;
  accountName: string;
  bookClosingUsd: string;
  currentTranslatedUsd: string;
  nativeBalancesByCurrency: Record<string, string>;
  expectedBaseOnlyAdjustmentUsd: string;
}

export interface ManualFxCorrectionPreflight {
  companyId: number;
  voucherId: number;
  voucherNumber: string | null;
  voucherDate: string | null;
  businessDate: string;
  rateEvidence: Array<{ currency: string; rate: string; direction: string; effectiveDate: string }>;
  status: "not_found" | "blocked" | "requires_review" | "ready_for_review" | "already_reversed";
  /** Machine-readable blockers, never silent accounting guesses. */
  blockers: string[];
  manualFxCounterDebitUsd: string;
  manualCashMovementUsd: string;
  fxCounterAccount: { id: number; code: string; type: string } | null;
  candidates: ManualFxCorrectionCandidate[];
  candidateNetAdjustmentUsd: string;
  /** This preview is never an authority to mutate financial records. */
  readOnly: true;
}

export function classifyManualFxCorrectionPreflight(input: {
  found: boolean;
  sourceType: string | null;
  deleted: boolean;
  optional: boolean;
  reversed: boolean;
  reversalOfVoucherId: number | null;
  fxCounterType: string | null;
  monetaryMovementCount: number;
  otherLegacyVoucherCount: number;
  unresolvedAccountCount: number;
  baseCurrency: string;
  nonEmptyCandidates: boolean;
  amountsReconcile: boolean;
}): { status: ManualFxCorrectionPreflight["status"]; blockers: string[] } {
  if (!input.found) return { status: "not_found", blockers: ["VOUCHER_NOT_FOUND"] };
  const blockers: string[] = [];
  if (input.deleted || input.optional || input.reversalOfVoucherId !== null) blockers.push("VOUCHER_NOT_ACTIVE_OR_ORIGINAL");
  if (input.sourceType !== "manual-journal") blockers.push("VOUCHER_NOT_MANUAL_JOURNAL");
  if (input.fxCounterType === null) blockers.push("FX_COUNTER_ACCOUNT_MISSING");
  else if (input.fxCounterType !== "Indirect Expense") blockers.push("FX_ACCOUNT_RECLASSIFICATION_REQUIRED");
  if (input.monetaryMovementCount === 0) blockers.push("LEGACY_NATIVE_USD_LINES_MISSING");
  if (input.baseCurrency !== "USD") blockers.push("BASE_CURRENCY_NOT_USD");
  if (input.unresolvedAccountCount > 0) blockers.push("MONETARY_FX_UNRESOLVED");
  if (input.otherLegacyVoucherCount > 0) blockers.push("OTHER_MANUAL_FX_VOUCHERS");
  if (!input.nonEmptyCandidates) blockers.push("NO_FX_CORRECTION_CANDIDATES");
  if (!input.amountsReconcile) blockers.push("FX_CORRECTION_AMOUNT_MISMATCH");
  if (input.reversed) return { status: "already_reversed", blockers };
  if (blockers.some((code) => code !== "FX_ACCOUNT_RECLASSIFICATION_REQUIRED")) {
    return { status: "blocked", blockers };
  }
  return {
    status: blockers.length ? "requires_review" : "ready_for_review",
    blockers,
  };
}

export async function getManualFxCorrectionPreflight(
  companyId: number,
  voucherId: number
): Promise<ManualFxCorrectionPreflight> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !Number.isSafeInteger(voucherId) || voucherId <= 0) {
    throw new RangeError("FX_CORRECTION_INVALID_ID");
  }
  const snapshot = await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await assertTransactionCompanyScope(tx, companyId);
    const header = resultRows<VoucherHeader>(
      await tx.execute(sql`
        SELECT v.id, v.voucher_number, v.voucher_date::text,
               (v.deleted_at IS NOT NULL) AS deleted, v.optional,
               v.reversal_of_voucher_id,
               p.source_type,
               (
                 EXISTS (
                   SELECT 1 FROM vouchers r
                   WHERE r.company_id = v.company_id AND r.reversal_of_voucher_id = v.id
                     AND r.deleted_at IS NULL
                 )
                 OR EXISTS (
                   SELECT 1 FROM accounting_posting_requests pr
                     JOIN vouchers r ON r.id=pr.voucher_id AND r.company_id=pr.company_id
                   WHERE pr.company_id=v.company_id
                     AND pr.idempotency_key=('voucher-reversal:' || v.company_id::text || ':' || v.id::text)
                     AND r.deleted_at IS NULL
                 )
               ) AS reversed
          FROM vouchers v
          LEFT JOIN LATERAL (
            SELECT p.source_type FROM accounting_posting_requests p
             WHERE p.company_id=v.company_id AND p.voucher_id=v.id
             ORDER BY p.id LIMIT 1
          ) p ON TRUE
         WHERE v.company_id=${companyId} AND v.id=${voucherId}
      `)
    )[0] ?? null;
    const lines = header ? resultRows<VoucherLine>(
      await tx.execute(sql`
        SELECT e.id, e.ledger_account_id, e.bank_account_id, e.customer_id,
               a.code AS account_code, a.name AS account_name, a.account_type,
               e.debit_amount::text, e.credit_amount::text,
               e.transaction_currency, e.transaction_debit_amount::text,
               e.transaction_credit_amount::text, e.rate_convention
          FROM voucher_entries e
          LEFT JOIN ledger_accounts a ON a.company_id=e.company_id AND a.id=e.ledger_account_id
         WHERE e.company_id=${companyId} AND e.voucher_id=${voucherId}
         ORDER BY e.id
      `)
    ) : [];
    return { header, lines };
  });
  const valuation = await getMonetaryFxValuation(companyId);
  const conflicts = await findLegacyManualFxConflicts(db, companyId, valuation.businessDate);
  const fxCounter = snapshot.lines.find(
    (row) => row.account_code === "FXREVGAI" || row.account_code === "FX-REVALUATION" ||
      row.account_name?.toLowerCase().trim() === "fx revaluation gain/loss"
  );
  const foreignTargetKeys = new Set<string>();
  const monetaryMovements = snapshot.lines.filter((row) => {
    const originalUsd = row.transaction_currency?.trim().toUpperCase() === "USD";
    const monetary = ["Cash", "Bank", "Loan", "Loans", "Customer"].includes(row.account_type ?? "") ||
      row.bank_account_id !== null || row.customer_id !== null;
    if (!originalUsd || row.rate_convention !== "IDENTITY" || !monetary) return false;
    if (row.ledger_account_id !== null) foreignTargetKeys.add(`ledger:${row.ledger_account_id}`);
    else if (row.bank_account_id !== null) foreignTargetKeys.add(`bank:${row.bank_account_id}`);
    else if (row.customer_id !== null) foreignTargetKeys.add(`customer:${row.customer_id}`);
    return true;
  });
  const candidates: ManualFxCorrectionCandidate[] = [];
  let unresolved = 0;
  for (const row of valuation.accounts) {
    if (!foreignTargetKeys.has(row.accountKey)) continue;
    if (row.provisional || row.currentTranslatedUsd === null ||
        !["cash_bank", "loan", "customer"].includes(row.eligibility)) {
      unresolved++;
      continue;
    }
    const foreignHolding = Object.entries(row.nativeBalancesByCurrency).some(
      ([currency, amount]) => currency !== "USD" && !new Decimal(amount).isZero()
    );
    if (!foreignHolding) {
      unresolved++;
      continue;
    }
    candidates.push({
      accountKey: row.accountKey,
      accountName: row.name,
      bookClosingUsd: row.bookClosingUsd,
      currentTranslatedUsd: row.currentTranslatedUsd,
      nativeBalancesByCurrency: row.nativeBalancesByCurrency,
      expectedBaseOnlyAdjustmentUsd: postedFxRevaluationAdjustmentUsd(row.currentTranslatedUsd, row.bookClosingUsd),
    });
  }
  // A balanced voucher totals zero across all accounts. Its FX counter-line
  // is the amount of the original loss, not the sum of the entire journal.
  const netAdjustment = candidates.reduce(
    (sum, row) => sum.plus(row.expectedBaseOnlyAdjustmentUsd), new Decimal(0)
  );
  const cashMovement = monetaryMovements.reduce(
    (sum, row) => sum.plus(row.debit_amount).minus(row.credit_amount), new Decimal(0)
  );
  const originalCounter = fxCounter
    ? new Decimal(fxCounter.debit_amount).minus(fxCounter.credit_amount) : new Decimal(0);
  const wholeVoucher = snapshot.lines.reduce(
    (sum, row) => sum.plus(row.debit_amount).minus(row.credit_amount), new Decimal(0)
  );
  // A legacy cash/FX journal may not be equivalent to today's outstanding
  // amount if other movements or rates have changed. Flag it for independent
  // accounting review; never silently treat it as a safe correction.
  const amountsReconcile = wholeVoucher.abs().lt("0.005") &&
    cashMovement.plus(originalCounter).abs().lt("0.005") &&
    netAdjustment.minus(cashMovement).abs().lt("0.005");
  const classified = classifyManualFxCorrectionPreflight({
    found: snapshot.header !== null,
    sourceType: snapshot.header?.source_type ?? null,
    deleted: snapshot.header?.deleted ?? false,
    optional: snapshot.header?.optional ?? false,
    reversed: snapshot.header?.reversed ?? false,
    reversalOfVoucherId: snapshot.header?.reversal_of_voucher_id ?? null,
    fxCounterType: fxCounter?.account_type ?? null,
    monetaryMovementCount: monetaryMovements.length,
    otherLegacyVoucherCount: conflicts.filter((v) => v.voucherId !== voucherId).length,
    unresolvedAccountCount: unresolved,
    baseCurrency: valuation.baseCurrency,
    nonEmptyCandidates: candidates.length > 0,
    amountsReconcile,
  });
  return {
    companyId,
    voucherId,
    voucherNumber: snapshot.header?.voucher_number ?? null,
    voucherDate: snapshot.header?.voucher_date ?? null,
    businessDate: valuation.businessDate,
    rateEvidence: valuation.rates.map((r) => ({
      currency: r.currency, rate: r.rate, direction: r.direction, effectiveDate: r.effectiveDate,
    })),
    status: classified.status,
    blockers: classified.blockers,
    manualFxCounterDebitUsd: originalCounter.toFixed(2),
    manualCashMovementUsd: cashMovement.toFixed(2),
    fxCounterAccount: fxCounter?.ledger_account_id ? {
      id: fxCounter.ledger_account_id, code: fxCounter.account_code ?? "", type: fxCounter.account_type ?? "",
    } : null,
    candidates,
    candidateNetAdjustmentUsd: netAdjustment.toFixed(2),
    readOnly: true,
  };
}
