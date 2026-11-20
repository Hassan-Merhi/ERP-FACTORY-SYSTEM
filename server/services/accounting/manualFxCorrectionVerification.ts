/**
 * Phase 4 recovery evidence: company-scoped, read-only accounting provenance.
 * The existing audited routes perform reviewed writes. This service only
 * verifies whether an original manual FX voucher was EXACTLY reversed and
 * replaced by one correct native-zero unrealized FX journal.
 */
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { getMonetaryFxValuation } from "./monetaryFxValuationService";
import {
  assessManualFxCorrection,
  type FxRepairAuditLine,
  type FxRepairAuditVoucher,
  type FxRepairAuditResult,
} from "./manualFxCorrectionAudit";

interface EvidenceRow extends Record<string, unknown> {
  voucher_id: number;
  voucher_number: string;
  reversal_of_voucher_id: number | null;
  source_type: string | null;
  deleted: boolean;
  optional: boolean;
  line_id: number;
  ledger_id: number | null;
  bank_id: number | null;
  customer_id: number | null;
  debit_usd: string;
  credit_usd: string;
  transaction_currency: string | null;
  native_debit: string | null;
  native_credit: string | null;
  rate_convention: string | null;
  account_code: string | null;
  account_name: string | null;
  account_type: string | null;
}

function voucherFromEvidence(rows: EvidenceRow[]): FxRepairAuditVoucher[] {
  const vouchers = new Map<number, FxRepairAuditVoucher>();
  for (const row of rows) {
    let voucher = vouchers.get(Number(row.voucher_id));
    if (!voucher) {
      voucher = {
        id: Number(row.voucher_id),
        voucherNumber: row.voucher_number,
        reversalOfVoucherId: row.reversal_of_voucher_id == null ? null : Number(row.reversal_of_voucher_id),
        sourceType: row.source_type,
        deleted: Boolean(row.deleted),
        optional: Boolean(row.optional),
        lines: [],
      };
      vouchers.set(voucher.id, voucher);
    }
    const line: FxRepairAuditLine = {
      voucherId: voucher.id,
      lineId: Number(row.line_id),
      ledgerId: row.ledger_id === null ? null : Number(row.ledger_id),
      bankId: row.bank_id === null ? null : Number(row.bank_id),
      customerId: row.customer_id === null ? null : Number(row.customer_id),
      debitUsd: String(row.debit_usd),
      creditUsd: String(row.credit_usd),
      currency: row.transaction_currency,
      nativeDebit: row.native_debit,
      nativeCredit: row.native_credit,
      rateConvention: row.rate_convention,
      accountCode: row.account_code,
      accountName: row.account_name,
      accountType: row.account_type,
    };
    voucher.lines.push(line);
  }
  return [...vouchers.values()];
}

/**
 * The valuation is independently snapshot-consistent, but this is a review
 * tool, never a write authorization. Always recheck under an exclusive
 * transaction lock before any financial write.
 */
export async function verifyManualFxCorrection(companyId: number, voucherId: number): Promise<FxRepairAuditResult> {
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !Number.isSafeInteger(voucherId) || voucherId <= 0) {
    throw new RangeError("FX_REPAIR_AUDIT_INVALID_COMPANY_OR_VOUCHER");
  }
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await assertTransactionCompanyScope(tx, companyId);
    return resultRows<EvidenceRow>(
      await tx.execute(sql`
        SELECT
          v.id AS voucher_id,
          v.voucher_number::text AS voucher_number,
          v.reversal_of_voucher_id,
          p.source_type,
          (v.deleted_at IS NOT NULL) AS deleted,
          v.optional,
          e.id AS line_id,
          e.ledger_account_id AS ledger_id,
          e.bank_account_id AS bank_id,
          e.customer_id,
          e.debit_amount::text AS debit_usd,
          e.credit_amount::text AS credit_usd,
          e.transaction_currency,
          e.transaction_debit_amount::text AS native_debit,
          e.transaction_credit_amount::text AS native_credit,
          e.rate_convention,
          a.code AS account_code,
          a.name AS account_name,
          a.account_type
        FROM vouchers v
        JOIN voucher_entries e ON e.voucher_id = v.id AND e.company_id = v.company_id
        LEFT JOIN ledger_accounts a ON a.id = e.ledger_account_id AND a.company_id = v.company_id
        LEFT JOIN LATERAL (
          SELECT apr.source_type
          FROM accounting_posting_requests apr
          WHERE apr.company_id = v.company_id AND apr.voucher_id = v.id
          ORDER BY apr.id LIMIT 1
        ) p ON TRUE
        WHERE v.company_id = ${companyId}
          AND (
            v.id = ${voucherId}
            OR v.reversal_of_voucher_id = ${voucherId}
            OR (
              p.source_type = 'fx-unrealized-revaluation'
              AND v.voucher_date >= (
                SELECT original.voucher_date
                FROM vouchers original
                WHERE original.company_id = ${companyId} AND original.id = ${voucherId}
              )
            )
          )
        ORDER BY v.id, e.id
      `)
    );
  });
  const vouchers = voucherFromEvidence(rows);
  const original = vouchers.find((v) => v.id === voucherId) ?? null;
  const reversal = vouchers.filter((v) => v.reversalOfVoucherId === voucherId && v.id !== voucherId);
  const automatic = vouchers.filter((v) => v.sourceType === "fx-unrealized-revaluation");
  const valuation = await getMonetaryFxValuation(companyId);
  return assessManualFxCorrection({
    originalVoucherId: voucherId,
    original,
    reversals: reversal,
    automaticFxVouchers: automatic,
    balances: valuation.accounts.map((row) => ({
      accountKey: row.accountKey,
      bookClosingUsd: row.bookClosingUsd,
      currentTranslatedUsd: row.currentTranslatedUsd,
      nativeBalancesByCurrency: row.nativeBalancesByCurrency,
      provisional: row.provisional,
    })),
  });
}
