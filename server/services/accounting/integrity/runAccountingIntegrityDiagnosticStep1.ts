// Extracted from ./accountingIntegrityDiagnostic.ts to keep that module under the source-size cap.
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { LEDGER_ACCOUNT_TREE_TRIGGER } from "../ledgerIntegrityGuard";
import { VOUCHER_BALANCE_GUARD_TRIGGERS } from "../voucherBalanceGuard";
import { OPENING_BALANCE_LOCK_TABLES, openingBalanceLockTriggerName } from "../openingBalanceLock";
import { CURRENCY_NORMALIZATION_TRIGGER } from "../currencyNormalizationGuard";
import { classifyVoucherLedgerExpectation } from "../voucherLedgerExpectation";
import { buildTrialBalance } from "./trialBalance";

export type IntegrityStatus = "pass" | "warn" | "fail";

export interface IntegrityCheck {
  key: string;
  status: IntegrityStatus;
  count: number;
  amount: string | null;
  explanation: string;
  samples: Record<string, unknown>[];
}

const SAMPLE_LIMIT = 20;

type Row = Record<string, unknown>;

export function check(
  key: string,
  status: IntegrityStatus,
  count: number,
  explanation: string,
  samples: Row[] = [],
  amount: string | null = null
): IntegrityCheck {
  return { key, status, count, amount, explanation, samples: samples.slice(0, SAMPLE_LIMIT) };
}

export async function rows<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute<T>(query);
  return result.rows as unknown as T[];
}

export const LIVE = sql`v.deleted_at IS NULL AND v.optional = false`;

/** Wave 12 (A): the balance guard v3 triggers and the opening-balance lock triggers. */
export const LEDGER_INTEGRITY_WAVE12_TRIGGERS: readonly string[] = [
  ...VOUCHER_BALANCE_GUARD_TRIGGERS.map(([, name]) => name),
  ...OPENING_BALANCE_LOCK_TABLES.map(openingBalanceLockTriggerName),
  // Wave 14 (A): the voucher-entry currency normalization trigger (migrations/20260720_005).
  CURRENCY_NORMALIZATION_TRIGGER,
  // Phase 19 (B): the account tree guard (ledgerIntegrityGuard.ts v4).
  LEDGER_ACCOUNT_TREE_TRIGGER,
];

export async function runAccountingIntegrityDiagnosticStep1(companyId: number) {
  const checks: IntegrityCheck[] = [];

  // 1. Unbalanced posted vouchers, split by what the voucher type owes.
  const unbalanced = await rows<{
    id: number;
    voucher_number: string;
    voucher_type: string;
    diff: string;
    lines: number;
  }>(sql`
    SELECT v.id, v.voucher_number, v.voucher_type, SUM(ve.debit_amount - ve.credit_amount)::text AS diff,
           COUNT(*)::int AS lines
      FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id
     WHERE v.company_id = ${companyId} AND ${LIVE}
     GROUP BY v.id
    HAVING SUM(ve.debit_amount) <> SUM(ve.credit_amount)
     ORDER BY ABS(SUM(ve.debit_amount - ve.credit_amount)) DESC
  `);
  const byDesign = unbalanced.filter((row) => {
    const expectation = classifyVoucherLedgerExpectation(row.voucher_type);
    return expectation === "single-sided" || expectation === "inventory-sided";
  });
  const defects = unbalanced.filter((row) => !byDesign.includes(row));
  const sum = (list: { diff: string }[]) => list.reduce((acc, row) => acc.plus(toMoney(row.diff)), new MoneyDecimal(0));
  checks.push(
    check(
      "unbalanced_vouchers",
      defects.length > 0 ? "fail" : "pass",
      defects.length,
      "Posted vouchers of a balanced type whose debits do not equal their credits.",
      defects,
      sum(defects).toFixed(2)
    ),
    check(
      "single_sided_stock_vouchers",
      byDesign.length > 0 ? "warn" : "pass",
      byDesign.length,
      "Stock adjustment vouchers post one side only; the inventory sub-ledger is the other side, so the ledger cannot balance until inventory is carried in the ledger.",
      byDesign,
      sum(byDesign).toFixed(2)
    )
  );

  // 2. Line targets.
  const targetIssues = await rows<{
    issue: string;
    id: number;
    voucher_number: string;
    debit: string;
    credit: string;
    narration: string | null;
  }>(sql`
    SELECT CASE
             WHEN num_nonnulls(ve.ledger_account_id, ve.bank_account_id, ve.fixed_asset_id, ve.supplier_id,
                               ve.employee_id, ve.customer_id, ve.factory_supplier_id) = 0 THEN 'no_target'
             ELSE 'multiple_targets'
           END AS issue,
           ve.id, v.voucher_number, ve.debit_amount::text AS debit, ve.credit_amount::text AS credit, ve.narration
      FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = ${companyId} AND ${LIVE}
       AND (
         num_nonnulls(ve.ledger_account_id, ve.bank_account_id, ve.fixed_asset_id, ve.supplier_id,
                      ve.employee_id, ve.customer_id, ve.factory_supplier_id) = 0
         OR (num_nonnulls(ve.ledger_account_id, ve.bank_account_id, ve.fixed_asset_id, ve.supplier_id,
                          ve.employee_id, ve.customer_id, ve.factory_supplier_id) > 1
             AND NOT (num_nonnulls(ve.bank_account_id, ve.fixed_asset_id, ve.supplier_id, ve.employee_id,
                                   ve.factory_supplier_id) = 0 AND ve.ledger_account_id IS NOT NULL
                      AND ve.customer_id IS NOT NULL))
       )
     ORDER BY ve.id DESC
  `);
  const noTarget = targetIssues.filter((row) => row.issue === "no_target");
  const multiTarget = targetIssues.filter((row) => row.issue === "multiple_targets");
  const lineAmount = (list: { debit: string; credit: string }[]) =>
    list.reduce((acc, row) => acc.plus(toMoney(row.debit)).minus(toMoney(row.credit)), new MoneyDecimal(0)).toFixed(2);
  checks.push(
    check(
      "lines_without_account",
      noTarget.length ? "fail" : "pass",
      noTarget.length,
      "Posted lines that post to no account; their amount is missing from every balance.",
      noTarget,
      lineAmount(noTarget)
    ),
    check(
      "lines_with_several_accounts",
      multiTarget.length ? "fail" : "pass",
      multiTarget.length,
      "Posted lines that name more than one account, so reports can count them twice or under the wrong account.",
      multiTarget,
      lineAmount(multiTarget)
    )
  );

  // 3. Account references.
  const accountRefs = await rows<{
    issue: string;
    id: number;
    voucher_number: string;
    ledger_account_id: number;
    account_name: string | null;
    debit: string;
    credit: string;
  }>(sql`
    SELECT CASE WHEN la.id IS NULL THEN 'missing_or_other_company'
                WHEN la.deleted_at IS NOT NULL THEN 'deleted_account'
                ELSE 'inactive_account' END AS issue,
           ve.id, v.voucher_number, ve.ledger_account_id, la.name AS account_name,
           ve.debit_amount::text AS debit, ve.credit_amount::text AS credit
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
      LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id AND la.company_id = v.company_id
     WHERE v.company_id = ${companyId} AND ${LIVE} AND ve.ledger_account_id IS NOT NULL
       AND (la.id IS NULL OR la.deleted_at IS NOT NULL OR la.active = false)
     ORDER BY ve.id DESC
  `);
  for (const [key, status, text] of [
    [
      "missing_or_other_company",
      "fail",
      "Posted lines on an account that does not exist in this company (hard-deleted, or another company's account).",
    ],
    [
      "deleted_account",
      "fail",
      "Posted lines on a soft-deleted account; reports that hide deleted accounts drop these balances.",
    ],
    ["inactive_account", "warn", "Posted lines on an inactive account."],
  ] as const) {
    const list = accountRefs.filter((row) => row.issue === key);
    checks.push(check(`lines_on_${key}`, list.length ? status : "pass", list.length, text, list, lineAmount(list)));
  }

  // 4. Foreign-currency lines without their native amount.
  const unnormalized = await rows<{
    voucher_number: string;
    currency: string;
    exchange_rate: string | null;
    lines: number;
    debit: string;
  }>(sql`
    SELECT v.voucher_number, v.currency, v.exchange_rate::text, COUNT(*)::int AS lines, SUM(ve.debit_amount)::text AS debit
      FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = ${companyId} AND ${LIVE}
       AND UPPER(COALESCE(v.currency, 'USD')) <> 'USD' AND ve.transaction_currency IS NULL
     GROUP BY v.id ORDER BY v.id DESC
  `);
  checks.push(
    check(
      "foreign_currency_lines_without_native_amount",
      unnormalized.length ? "fail" : "pass",
      unnormalized.reduce((acc, row) => acc + row.lines, 0),
      "Lines of non-USD vouchers with no transaction currency: their debit/credit (meant to be USD) may hold the native amount.",
      unnormalized
    )
  );

  // 4b. Who still writes them (wave 17 C). The currency trigger normalizes only
  // USD and CFA; a line of another currency written without its transaction
  // amounts keeps the native amount in the USD columns. Lines written in the
  // last 90 days, by currency and voucher-number family, show a live writer
  // (production, 2026-10-09: FACTORY-FREIGHT EUR/AUD from main). Since wave
  // 17 D the factory writers refuse a document with no confirmed rate and the
  // trigger (v2) refuses this shape for new lines; what is listed is history.
  const recentUnnormalized = await rows<{
    currency: string;
    family: string;
    lines: number;
    last_written: string;
  }>(sql`
    SELECT UPPER(COALESCE(v.currency, 'USD')) AS currency,
           COALESCE(substring(v.voucher_number from '^[A-Za-z_-]+'), '') AS family,
           COUNT(*)::int AS lines, MAX(ve.created_at)::date::text AS last_written
      FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
     WHERE v.company_id = ${companyId} AND ${LIVE}
       AND UPPER(COALESCE(v.currency, 'USD')) NOT IN ('USD', 'CFA', 'XOF')
       AND ve.transaction_debit_amount IS NULL AND ve.transaction_credit_amount IS NULL
       AND ve.created_at >= now() - interval '90 days'
     GROUP BY 1, 2 ORDER BY 1, 2
  `);
  checks.push(
    check(
      "foreign_currency_lines_written_recently_without_native_amount",
      recentUnnormalized.length ? "warn" : "pass",
      recentUnnormalized.reduce((acc, row) => acc + row.lines, 0),
      "Lines of non-USD, non-CFA vouchers written in the last 90 days without transaction amounts, by currency and voucher family: a writer that still stores the native amount in the USD columns.",
      recentUnnormalized
    )
  );

  // 5. Opening balances (not journal entries in this system).
  const trialBalance = await buildTrialBalance(companyId, null);
  const openingNet = toMoney(trialBalance.differenceComponents.openingBalances);
  checks.push(
    check(
      "opening_balances_unbalanced",
      openingNet.isZero() ? "pass" : "fail",
      openingNet.isZero() ? 0 : 1,
      "Opening balances on master records do not net to zero, so they bring an unexplained difference into the books.",
      [{ openingDebit: trialBalance.totals.openingDebit, openingCredit: trialBalance.totals.openingCredit }],
      openingNet.toFixed(2)
    ),
    check(
      "opening_sides_assumed",
      trialBalance.openingSidesAssumed ? "warn" : "pass",
      trialBalance.openingSidesAssumed,
      "Opening balances stored without a Dr/Cr side; the trial balance assumes the usual side for the record type."
    )
  );
  return { checks, lineAmount, trialBalance };
}
