/**
 * Phase 19 (B): ledger shape checks, listed (warn), never changed.
 *
 *   voucher_shape_new — D5: an active, non-optional voucher created since the
 *     balance guard marked history (not history) that has fewer than two lines
 *     or whose header total is not its line total (base debits, or the
 *     transaction-currency debits when every line shares one currency). The
 *     stock-transfer types (no GL line by design) are exempt from both; the
 *     types whose header is a document amount (Credit/Debit Note, the stock
 *     adjustment types) from the total.
 *   ledger_account_parent_invalid — C5: live accounts whose parent is the
 *     account itself, missing, another company's, deleted or of another class.
 *     New or changed links are refused by the tree guard
 *     (ledgerIntegrityGuard.ts); older links are listed here.
 */
import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { VOUCHER_HISTORY_MARKER_COLUMN } from "../voucherBalanceGuard";
import { voucherTypesWithLedgerExpectation } from "../voucherLedgerExpectation";
import type { IntegrityCheck } from "./accountingIntegrityDiagnostic";

const SAMPLE_LIMIT = 20;
// A catalogue read, not tenant data.
const HISTORY_MARKER_TABLE = "vouchers";
type Row = Record<string, unknown>;

async function rows<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute<T>(query)).rows as unknown as T[];
}

function warnCheck(key: string, explanation: string, samples: Row[]): IntegrityCheck {
  return {
    key,
    status: samples.length ? "warn" : "pass",
    count: samples.length,
    amount: null,
    explanation,
    samples: samples.slice(0, SAMPLE_LIMIT),
  };
}

const typeList = (types: readonly string[]) =>
  sql.join(
    types.map((type) => sql`${type}`),
    sql`, `
  );

export async function ledgerShapeChecks(companyId: number): Promise<IntegrityCheck[]> {
  const lineless = voucherTypesWithLedgerExpectation("none");
  const documentTotal = [
    ...voucherTypesWithLedgerExpectation("balanced-only"),
    ...voucherTypesWithLedgerExpectation("single-sided"),
    ...voucherTypesWithLedgerExpectation("inventory-sided"),
  ];
  const markerPresent = (
    await rows<{ present: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = current_schema() AND table_name = ${HISTORY_MARKER_TABLE}
                        AND column_name = ${VOUCHER_HISTORY_MARKER_COLUMN}) AS present`)
  )[0]?.present;
  const shape = markerPresent
    ? await rows<Row>(sql`
        SELECT v.id, v.voucher_number, v.voucher_type, v.voucher_date::text AS voucher_date,
               v.total_amount::text AS total_amount, s.line_count, s.base_debit::text AS line_total,
               CASE WHEN s.line_count < 2 THEN 'too_few_lines' ELSE 'total_mismatch' END AS reason
          FROM vouchers v
          JOIN LATERAL (
            SELECT COUNT(*)::int AS line_count, COALESCE(SUM(debit_amount), 0) AS base_debit,
                   COALESCE(SUM(transaction_debit_amount), 0) AS txn_debit,
                   COUNT(DISTINCT transaction_currency) FILTER (WHERE transaction_currency IS NOT NULL) AS currencies,
                   COALESCE(bool_and(transaction_currency IS NOT NULL), false) AS all_in_currency
              FROM voucher_entries e WHERE e.voucher_id = v.id) s ON true
         WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
           AND NOT v.${sql.raw(VOUCHER_HISTORY_MARKER_COLUMN)}
           AND v.voucher_type NOT IN (${typeList(lineless)})
           AND (s.line_count < 2
                OR (v.voucher_type NOT IN (${typeList(documentTotal)})
                    AND abs(round(COALESCE(v.total_amount, 0), 2) - round(s.base_debit, 2)) > 0.01
                    AND NOT (s.currencies = 1 AND s.all_in_currency
                             AND round(COALESCE(v.total_amount, 0), 2) = round(s.txn_debit, 2))))
         ORDER BY v.id`)
    : [];
  const parents = await rows<Row>(sql`
    SELECT a.id, a.code, a.name, a.parent_id,
           CASE WHEN a.parent_id = a.id THEN 'self'
                WHEN p.id IS NULL OR p.company_id <> a.company_id THEN 'parent_missing_or_other_company'
                WHEN p.deleted_at IS NOT NULL THEN 'parent_deleted'
                ELSE 'parent_other_class' END AS reason
      FROM ledger_accounts a
      LEFT JOIN ledger_accounts p ON p.id = a.parent_id
     WHERE a.company_id = ${companyId} AND a.deleted_at IS NULL AND a.parent_id IS NOT NULL
       AND (a.parent_id = a.id OR p.id IS NULL OR p.company_id <> a.company_id OR p.deleted_at IS NOT NULL
            OR erp_ledger_account_class(p.account_type, p.sub_type) <> erp_ledger_account_class(a.account_type, a.sub_type))
     ORDER BY a.id
  `).catch(() => [] as Row[]);
  return [
    warnCheck(
      "voucher_shape_new",
      "Vouchers created since the balance guard was installed that have fewer than two lines, or whose header total is not their line total. Stock transfers (no ledger line by design) are exempt; Credit/Debit Notes and stock adjustments keep a document total. Correct by reversal or re-posting.",
      shape
    ),
    warnCheck(
      "ledger_account_parent_invalid",
      "Live accounts whose parent is the account itself, missing, another company's, deleted or of another class (asset, liability, equity, income, expense, party). New or changed links are refused by the tree guard; these older links are listed for review.",
      parents
    ),
  ];
}
