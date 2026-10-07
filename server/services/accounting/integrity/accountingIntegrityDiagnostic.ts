/**
 * Read-only accounting integrity diagnostic for one company.
 *
 * Every check here was run by hand against production during the 2026-10
 * accounting audit; this service makes them repeatable so the books can be
 * verified after each remediation wave and after every deploy. It reads only.
 *
 * Each check reports a status:
 *   - "fail": the ledger is wrong and needs a correcting entry or a fix;
 *   - "warn": a known structural limitation or a value to review;
 *   - "pass": nothing found.
 * Samples are capped so the response stays small.
 */
import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { CANONICAL_ACCOUNT_TYPES } from "../accountClassification";
import { LEDGER_GUARD_CONSTRAINTS } from "../ledgerIntegrityGuard";
import { SYSTEM_ACCOUNTS, diagnoseSystemAccounts } from "../systemAccounts";
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

export interface AccountingIntegrityReport {
  companyId: number;
  generatedAt: string;
  status: IntegrityStatus;
  checks: IntegrityCheck[];
  trialBalance: {
    balanced: boolean;
    unexplainedDifference: string;
    differenceComponents: Record<string, string>;
  };
}

const SAMPLE_LIMIT = 20;

export { CANONICAL_ACCOUNT_TYPES };

type Row = Record<string, unknown>;

function check(
  key: string,
  status: IntegrityStatus,
  count: number,
  explanation: string,
  samples: Row[] = [],
  amount: string | null = null
): IntegrityCheck {
  return { key, status, count, amount, explanation, samples: samples.slice(0, SAMPLE_LIMIT) };
}

async function rows<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute<T>(query);
  return result.rows as unknown as T[];
}

const LIVE = sql`v.deleted_at IS NULL AND v.optional = false`;

export async function runAccountingIntegrityDiagnostic(companyId: number): Promise<AccountingIntegrityReport> {
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

  // 6. Customers whose opening balance differs from their ledger account's.
  const customerOpenings = await rows<{
    id: number;
    legal_name: string;
    customer_opening: string;
    account_opening: string;
  }>(sql`
    SELECT c.id, c.legal_name,
           (CASE WHEN c.opening_balance_side = 'Cr' THEN -1 ELSE 1 END * COALESCE(c.opening_balance, 0))::text AS customer_opening,
           (CASE WHEN la.opening_balance_side = 'Cr' THEN -1 ELSE 1 END * COALESCE(la.opening_balance, 0))::text AS account_opening
      FROM customers c JOIN ledger_accounts la ON la.id = c.ledger_account_id
     WHERE c.company_id = ${companyId} AND c.deleted_at IS NULL
       AND (CASE WHEN c.opening_balance_side = 'Cr' THEN -1 ELSE 1 END * COALESCE(c.opening_balance, 0))
        <> (CASE WHEN la.opening_balance_side = 'Cr' THEN -1 ELSE 1 END * COALESCE(la.opening_balance, 0))
  `);
  checks.push(
    check(
      "customer_opening_differs_from_account",
      customerOpenings.length ? "warn" : "pass",
      customerOpenings.length,
      "Customer opening balance differs from the opening on its own ledger account; the trial balance uses the account's.",
      customerOpenings
    )
  );

  // 7. Employee cached balance against the ledger.
  const employeeDrift = await rows<{ id: number; name: string; cached: string; ledger: string }>(sql`
    SELECT e.id, TRIM(CONCAT(e.first_name, ' ', e.last_name)) AS name, COALESCE(e.current_balance, 0)::text AS cached,
           (CASE WHEN e.opening_balance_side = 'Dr' THEN 1 ELSE -1 END * COALESCE(e.opening_balance, 0)
             + COALESCE((SELECT SUM(ve.debit_amount - ve.credit_amount) FROM voucher_entries ve
                          JOIN vouchers v ON v.id = ve.voucher_id
                         WHERE ve.employee_id = e.id AND ${LIVE}), 0))::text AS ledger
      FROM employees e
     WHERE e.company_id = ${companyId} AND e.deleted_at IS NULL
  `);
  const drift = employeeDrift.filter((row) => {
    const cached = toMoney(row.cached).abs();
    const ledger = toMoney(row.ledger).abs();
    return cached.minus(ledger).abs().greaterThan(0.01);
  });
  checks.push(
    check(
      "employee_cached_balance_drift",
      drift.length ? "fail" : "pass",
      drift.length,
      "employees.current_balance (read by Net Position) disagrees with the employee's ledger balance.",
      drift
    )
  );

  // 8. Chart of accounts classification.
  const accounts = await rows<{ id: number; code: string; name: string; account_type: string }>(sql`
    SELECT id, code, name, account_type FROM ledger_accounts WHERE company_id = ${companyId} AND deleted_at IS NULL
  `);
  const nonCanonical = accounts.filter((account) => !CANONICAL_ACCOUNT_TYPES.has(account.account_type));
  checks.push(
    check(
      "non_canonical_account_types",
      nonCanonical.length ? "fail" : "pass",
      nonCanonical.length,
      "Accounts whose type is not one the reports recognise (for example 'EXPENSE' or 'LIABILITY'); they are missed or misclassified by every balance engine.",
      nonCanonical
    )
  );
  const systemAccounts = await diagnoseSystemAccounts(db, companyId);
  const requiredCodes = new Set(SYSTEM_ACCOUNTS.filter((definition) => definition.required).map((d) => d.code));
  const missingRequired = systemAccounts.filter(
    (status) => status.state === "missing" && requiredCodes.has(status.code)
  );
  const needsReview = systemAccounts.filter(
    (status) => status.state === "type_differs" || status.state === "deleted" || status.state === "reused_by_name"
  );
  checks.push(
    check(
      "required_system_accounts_missing",
      missingRequired.length ? "fail" : "pass",
      missingRequired.length,
      "Required system accounts (retained earnings, opening balance equity) that do not exist; they are created at boot and by POST /api/accounting/system-accounts/ensure.",
      missingRequired
    ),
    check(
      "system_accounts_needing_review",
      needsReview.length ? "warn" : "pass",
      needsReview.length,
      "System accounts whose type differs from the registry, that are deleted, or that are only matched by name. They are never changed automatically because posted history may depend on them.",
      needsReview
    )
  );
  const hasEquity = accounts.some((account) => account.account_type === "Equity");
  checks.push(
    check(
      "no_equity_account",
      hasEquity ? "pass" : "fail",
      hasEquity ? 0 : 1,
      "The company has no Equity account, so capital and retained earnings cannot be shown."
    )
  );

  // 9. Database guards installed (ensureLedgerIntegrityGuard / ensureClosedPeriodGuard).
  const guards = await rows<{ name: string }>(sql`
    SELECT tgname AS name FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgname IN ('voucher_entries_target_guard', 'ledger_accounts_delete_guard',
                      'voucher_entries_closed_period_guard', 'vouchers_closed_period_guard')
    UNION ALL
    SELECT conname AS name FROM pg_constraint
     WHERE conrelid = 'voucher_entries'::regclass
       AND conname IN (${sql.join(
         LEDGER_GUARD_CONSTRAINTS.map((name) => sql`${name}`),
         sql`, `
       )})
  `);
  const missingGuards = [
    "voucher_entries_target_guard",
    "ledger_accounts_delete_guard",
    "voucher_entries_closed_period_guard",
    "vouchers_closed_period_guard",
    ...LEDGER_GUARD_CONSTRAINTS,
  ].filter((name) => !guards.some((guard) => guard.name === name));
  checks.push(
    check(
      "database_guards_installed",
      missingGuards.length ? "fail" : "pass",
      missingGuards.length,
      "Ledger integrity and closed-period triggers that must exist on the ledger tables.",
      missingGuards.map((name) => ({ missing: name }))
    )
  );

  // 10. Legacy stored plug left by the old import-cycle auto-adjustment.
  const plug = await rows<{ value: string; updated_at: string }>(sql`
    SELECT value, updated_at::text FROM system_settings WHERE key = ${`equity_adjustment_${companyId}`}
  `);
  const plugValue = plug[0] ? toMoney(plug[0].value) : new MoneyDecimal(0);
  checks.push(
    check(
      "legacy_equity_plug",
      plugValue.isZero() ? "pass" : "warn",
      plugValue.isZero() ? 0 : 1,
      "A balancing figure the dashboard used to store to show the import cycle as 0. It is no longer written or used; it is the size of the difference that was being hidden.",
      plug,
      plugValue.toFixed(2)
    )
  );

  const status: IntegrityStatus = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "pass";

  return {
    companyId,
    generatedAt: new Date().toISOString(),
    status,
    checks,
    trialBalance: {
      balanced: trialBalance.balanced,
      unexplainedDifference: trialBalance.unexplainedDifference,
      differenceComponents: trialBalance.differenceComponents,
    },
  };
}
