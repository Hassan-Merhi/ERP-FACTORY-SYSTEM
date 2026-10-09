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
import { CANONICAL_ACCOUNT_TYPES, classifyAccountType } from "../accountClassification";
import { LEDGER_GUARD_CONSTRAINTS, LEDGER_INTEGRITY_GUARD_VERSION } from "../ledgerIntegrityGuard";
import {
  VOUCHER_BALANCE_GUARD_TRIGGERS,
  VOUCHER_BALANCE_GUARD_VERSION,
  VOUCHER_HISTORY_MARKER_COLUMN,
} from "../voucherBalanceGuard";
import {
  OPENING_BALANCE_LOCK_TABLES,
  OPENING_BALANCE_LOCK_VERSION,
  openingBalanceLockTriggerName,
} from "../openingBalanceLock";
import {
  CURRENCY_NORMALIZATION_FUNCTION,
  CURRENCY_NORMALIZATION_GUARD_VERSION,
  CURRENCY_NORMALIZATION_TRIGGER,
} from "../currencyNormalizationGuard";
import { SYSTEM_ACCOUNTS, diagnoseSystemAccounts } from "../systemAccounts";
import { classifyVoucherLedgerExpectation } from "../voucherLedgerExpectation";
import { buildTrialBalance } from "./trialBalance";
import { payrollAdvancePostingChecks } from "./payrollAdvancePostingChecks";
import { retailLedgerChecks } from "./retailLedgerChecks";
import { getPartyBalances, liveVouchersOf } from "../balances/ledgerBalanceEngine";

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
/** Tables whose runtime supplier-link columns the SP mismatch check needs (wave 16 A). */
const SP_LINK_TABLES = ["sp_containers", "vouchers"] as const;

/** Wave 12 (A): the balance guard v3 triggers and the opening-balance lock triggers. */
const LEDGER_INTEGRITY_WAVE12_TRIGGERS: readonly string[] = [
  ...VOUCHER_BALANCE_GUARD_TRIGGERS.map(([, name]) => name),
  ...OPENING_BALANCE_LOCK_TABLES.map(openingBalanceLockTriggerName),
  // Wave 14 (A): the voucher-entry currency normalization trigger (migrations/20260720_005).
  CURRENCY_NORMALIZATION_TRIGGER,
];

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

  // 6. Customer openings (wave 10): the customer record owns the opening; the
  // opening of its linked ledger account is not counted by any engine.
  const linkedOpenings = await rows<{
    customer_id: number;
    legal_name: string;
    ledger_account_id: number;
    account_code: string;
    customer_opening: string;
    account_opening: string;
    same_amount: boolean;
  }>(sql`
    SELECT c.id AS customer_id, c.legal_name, la.id AS ledger_account_id, la.code AS account_code,
           (CASE WHEN c.opening_balance_side = 'Cr' THEN -1 ELSE 1 END * COALESCE(c.opening_balance, 0))::text AS customer_opening,
           (CASE WHEN la.opening_balance_side = 'Cr' THEN -1 ELSE 1 END * COALESCE(la.opening_balance, 0))::text AS account_opening,
           (CASE WHEN c.opening_balance_side = 'Cr' THEN -1 ELSE 1 END * COALESCE(c.opening_balance, 0))
             = (CASE WHEN la.opening_balance_side = 'Cr' THEN -1 ELSE 1 END * COALESCE(la.opening_balance, 0)) AS same_amount
      FROM customers c
      JOIN ledger_accounts la ON la.id = c.ledger_account_id AND la.company_id = c.company_id
     WHERE c.company_id = ${companyId} AND COALESCE(la.opening_balance, 0) <> 0
     ORDER BY c.id
  `);
  checks.push(
    check(
      "customer_linked_ledger_has_opening",
      linkedOpenings.length ? "warn" : "pass",
      linkedOpenings.length,
      "Customers whose linked ledger account carries its own opening balance. The customer's opening is the one counted; the account's is ignored by every balance, so review whether it was a copy (same_amount) or a figure to move onto the customer.",
      linkedOpenings,
      linkedOpenings.reduce((acc, row) => acc.plus(toMoney(row.account_opening)), new MoneyDecimal(0)).toFixed(2)
    )
  );
  const sharedLinks = await rows<{ ledger_account_id: number; account_code: string; customer_ids: number[] }>(sql`
    SELECT la.id AS ledger_account_id, la.code AS account_code, array_agg(c.id ORDER BY c.id) AS customer_ids
      FROM customers c
      JOIN ledger_accounts la ON la.id = c.ledger_account_id AND la.company_id = c.company_id
     WHERE c.company_id = ${companyId}
     GROUP BY la.id, la.code
    HAVING COUNT(*) > 1
  `);
  checks.push(
    check(
      "ledger_account_linked_to_several_customers",
      sharedLinks.length ? "warn" : "pass",
      sharedLinks.length,
      "Ledger accounts linked by more than one customer; their lines are counted once, under the lowest customer id.",
      sharedLinks
    )
  );

  // 7. Employee cached balance against the ledger (the one balance engine).
  const employeeLedger = await getPartyBalances(db, { companyId, kind: "employee" });
  const cachedBalances = await rows<{ id: number; cached: string }>(sql`
    SELECT e.id, COALESCE(e.current_balance, 0)::text AS cached
      FROM employees e WHERE e.company_id = ${companyId} AND e.deleted_at IS NULL
  `);
  const ledgerByEmployee = new Map(employeeLedger.parties.map((party) => [party.id, party]));
  const drift = cachedBalances
    .map((row) => {
      const party = ledgerByEmployee.get(row.id);
      return { id: row.id, name: party?.name ?? null, cached: row.cached, ledger: party?.closing ?? "0.00" };
    })
    .filter((row) => toMoney(row.cached).abs().minus(toMoney(row.ledger).abs()).abs().greaterThan(0.01));
  checks.push(
    check(
      "employee_cached_balance_drift",
      drift.length ? "fail" : "pass",
      drift.length,
      "employees.current_balance (read by Net Position) disagrees with the employee's ledger balance.",
      drift
    )
  );
  const legacyEmployeeLedgers = await rows<{
    id: number;
    code: string;
    employee_id: number | null;
    opening: string;
    lines: number;
    net: string;
  }>(sql`
    SELECT la.id, la.code, e.id AS employee_id, COALESCE(la.opening_balance, 0)::text AS opening,
           COUNT(ve.id)::int AS lines, COALESCE(SUM(ve.debit_amount - ve.credit_amount), 0)::text AS net
      FROM ledger_accounts la
      LEFT JOIN employees e ON e.company_id = la.company_id AND la.code = 'EMP-' || e.code
      LEFT JOIN voucher_entries ve ON ve.ledger_account_id = la.id
       AND EXISTS (SELECT 1 FROM vouchers v WHERE v.id = ve.voucher_id AND ${liveVouchersOf(companyId, null)})
     WHERE la.company_id = ${companyId} AND la.code LIKE 'EMP-%' AND la.deleted_at IS NULL
     GROUP BY la.id, la.code, e.id, la.opening_balance
    HAVING COUNT(ve.id) > 0 OR COALESCE(la.opening_balance, 0) <> 0
     ORDER BY la.code
  `);
  checks.push(
    check(
      "legacy_employee_ledger_accounts",
      legacyEmployeeLedgers.length ? "warn" : "pass",
      legacyEmployeeLedgers.length,
      "Legacy EMP-<code> ledger accounts still holding lines or an opening. Their lines move employees.current_balance but count under the account, not the employee, in every ledger balance; migrate them onto the employee (POST /api/admin/migrate-employee-account/:id) after reviewing the opening, which the migration does not carry.",
      legacyEmployeeLedgers
    )
  );

  // 7b. Lines whose account or party belongs to another company than their
  // voucher (wave 10: a line belongs to its voucher's company). Group suppliers
  // shared between a parent and its subsidiaries are allowed, as by the ledger
  // guard (ledgerIntegrityGuard.ts).
  const crossCompany = await rows<{
    id: number;
    voucher_number: string;
    target: string;
    target_id: number;
    target_company_id: number | null;
    debit: string;
    credit: string;
  }>(sql`
    WITH lines AS (
      SELECT ve.*, v.voucher_number, v.company_id AS voucher_company_id
        FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
       WHERE v.company_id = ${companyId} AND ${LIVE}
    ), targets AS (
      SELECT l.id, l.voucher_number, 'line' AS target, l.id AS target_id, l.company_id AS target_company_id,
             l.debit_amount, l.credit_amount
        FROM lines l WHERE l.company_id IS DISTINCT FROM l.voucher_company_id
      UNION ALL
      SELECT l.id, l.voucher_number, 'ledger', la.id, la.company_id, l.debit_amount, l.credit_amount
        FROM lines l JOIN ledger_accounts la ON la.id = l.ledger_account_id
       WHERE la.company_id IS DISTINCT FROM l.voucher_company_id
      UNION ALL
      SELECT l.id, l.voucher_number, 'bank', b.id, b.company_id, l.debit_amount, l.credit_amount
        FROM lines l JOIN bank_accounts b ON b.id = l.bank_account_id
       WHERE b.company_id IS DISTINCT FROM l.voucher_company_id
      UNION ALL
      SELECT l.id, l.voucher_number, 'fixedAsset', f.id, f.company_id, l.debit_amount, l.credit_amount
        FROM lines l JOIN fixed_assets f ON f.id = l.fixed_asset_id
       WHERE f.company_id IS DISTINCT FROM l.voucher_company_id
      UNION ALL
      SELECT l.id, l.voucher_number, 'supplier', s.id, s.company_id, l.debit_amount, l.credit_amount
        FROM lines l JOIN suppliers s ON s.id = l.supplier_id
       WHERE s.company_id IS DISTINCT FROM l.voucher_company_id
         AND NOT EXISTS (SELECT 1 FROM companies vc WHERE vc.id = l.voucher_company_id
                            AND vc.parent_company_id IS NOT NULL AND vc.parent_company_id = s.company_id)
         AND NOT EXISTS (SELECT 1 FROM companies sc WHERE sc.id = s.company_id
                            AND sc.parent_company_id = l.voucher_company_id)
      UNION ALL
      SELECT l.id, l.voucher_number, 'employee', e.id, e.company_id, l.debit_amount, l.credit_amount
        FROM lines l JOIN employees e ON e.id = l.employee_id
       WHERE e.company_id IS DISTINCT FROM l.voucher_company_id
      UNION ALL
      SELECT l.id, l.voucher_number, 'factorySupplier', fs.id, fs.company_id, l.debit_amount, l.credit_amount
        FROM lines l JOIN factory_suppliers fs ON fs.id = l.factory_supplier_id
       WHERE fs.company_id IS DISTINCT FROM l.voucher_company_id
      UNION ALL
      SELECT l.id, l.voucher_number, 'customer', c.id, c.company_id, l.debit_amount, l.credit_amount
        FROM lines l JOIN customers c ON c.id = l.customer_id
       WHERE c.company_id IS DISTINCT FROM l.voucher_company_id
    )
    SELECT id, voucher_number, target, target_id, target_company_id,
           debit_amount::text AS debit, credit_amount::text AS credit
      FROM targets ORDER BY id DESC
  `);
  // A line naming two foreign targets is listed once per target but counted once.
  const crossCompanyLines = [...new Map(crossCompany.map((row) => [row.id, row])).values()];
  checks.push(
    check(
      "cross_company_lines",
      crossCompanyLines.length ? "fail" : "pass",
      crossCompanyLines.length,
      "Posted lines (legacy; the ledger guard now refuses them) whose account or party belongs to another company than their voucher. The line counts in the voucher's company, so the other company's balance for that account or party misses it.",
      crossCompany,
      lineAmount(crossCompanyLines)
    )
  );

  // 8. Chart of accounts classification.
  // Wave 13: flagged only when the shared classifier cannot class the type
  // (sub type included), so legacy spellings every engine reads (COGS,
  // Revenue, Current Asset, mis-cased types) are no longer reported.
  const accounts = await rows<{
    id: number;
    code: string;
    name: string;
    account_type: string;
    sub_type: string | null;
  }>(sql`
    SELECT id, code, name, account_type, sub_type FROM ledger_accounts WHERE company_id = ${companyId} AND deleted_at IS NULL
  `);
  const nonCanonical = accounts.filter(
    (account) => classifyAccountType(account.account_type, account.sub_type) === "unknown"
  );
  checks.push(
    check(
      "non_canonical_account_types",
      nonCanonical.length ? "fail" : "pass",
      nonCanonical.length,
      "Accounts whose type the shared account classifier does not know (neither the type nor the sub type is an asset, liability, equity, income, expense or party type); every balance engine leaves them unclassified.",
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
                      'voucher_entries_closed_period_guard', 'vouchers_closed_period_guard',
                      'audit_log_append_only', 'audit_log_no_truncate')
    UNION ALL
    -- Wave 12 (A): balance guard v3 and the opening-balance lock.
    SELECT tgname AS name FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgname IN (${sql.join(
         LEDGER_INTEGRITY_WAVE12_TRIGGERS.map((name) => sql`${name}`),
         sql`, `
       )})
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
    // Wave 12 (B): audit_log append-only (auditLogAppendOnlyGuard.ts).
    "audit_log_append_only",
    "audit_log_no_truncate",
    ...LEDGER_GUARD_CONSTRAINTS,
    // Wave 12 (A): balance guard v3 and the opening-balance lock.
    ...LEDGER_INTEGRITY_WAVE12_TRIGGERS,
  ].filter((name) => !guards.some((guard) => guard.name === name));
  // Wave 12 (A): the balance guard must be at its current version, with its history marker
  // (a catalogue read, not tenant data).
  const HISTORY_MARKER_TABLE = "vouchers";
  const [guardState] = await rows<{ version: string | null; marker: boolean }>(sql`
    SELECT obj_description(to_regprocedure('erp_voucher_balance_check(integer)'), 'pg_proc') AS version,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = ${HISTORY_MARKER_TABLE}
                      AND column_name = ${VOUCHER_HISTORY_MARKER_COLUMN}) AS marker
  `);
  if (guardState?.version !== VOUCHER_BALANCE_GUARD_VERSION) {
    missingGuards.push(`erp_voucher_balance_check ${VOUCHER_BALANCE_GUARD_VERSION}`);
  }
  if (!guardState?.marker) missingGuards.push(`vouchers.${VOUCHER_HISTORY_MARKER_COLUMN}`);
  // Wave 14 (A): the currency normalization trigger at its installer's version.
  const [currencyGuard] = await rows<{ version: string | null }>(sql`
    SELECT obj_description(to_regprocedure(${`${CURRENCY_NORMALIZATION_FUNCTION}()`}), 'pg_proc') AS version
  `);
  if (currencyGuard?.version !== CURRENCY_NORMALIZATION_GUARD_VERSION) {
    missingGuards.push(`${CURRENCY_NORMALIZATION_FUNCTION} ${CURRENCY_NORMALIZATION_GUARD_VERSION}`);
  }
  // Wave 16 (B): the line-target guard (exactly one target) and the opening
  // lock (factory suppliers and fixed assets) at their current versions.
  const [ledgerGuardVersions] = await rows<{ target: string | null; opening: string | null }>(sql`
    SELECT obj_description(to_regprocedure('erp_voucher_entry_target_guard()'), 'pg_proc') AS target,
           obj_description(to_regprocedure('erp_opening_balance_lock_guard()'), 'pg_proc') AS opening
  `);
  if (ledgerGuardVersions?.target !== LEDGER_INTEGRITY_GUARD_VERSION) {
    missingGuards.push(`erp_voucher_entry_target_guard ${LEDGER_INTEGRITY_GUARD_VERSION}`);
  }
  if (ledgerGuardVersions?.opening !== OPENING_BALANCE_LOCK_VERSION) {
    missingGuards.push(`erp_opening_balance_lock_guard ${OPENING_BALANCE_LOCK_VERSION}`);
  }
  checks.push(
    check(
      "database_guards_installed",
      missingGuards.length ? "fail" : "pass",
      missingGuards.length,
      "Ledger integrity (current version: one target per new line), closed-period, balance (current version, with its history marker), opening-balance lock (current version) and currency normalization (current version) guards that must exist on the ledger tables.",
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

  // 11. Revaluation journals that saving an exchange rate used to post (wave 9
  // stopped it). They revalued every Cash account as if it held CFA, so each is
  // a candidate for a reviewed reversal; none is changed here.
  const revaluations = await rows<{ id: number; voucher_number: string; voucher_date: string; amount: string }>(sql`
    SELECT v.id, v.voucher_number, v.voucher_date::text AS voucher_date, v.total_amount::text AS amount
      FROM vouchers v
     WHERE v.company_id = ${companyId} AND v.voucher_number LIKE 'FX-REVAL-%'
       AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
     ORDER BY v.voucher_date, v.id
  `);
  checks.push(
    check(
      "automatic_fx_revaluation_journals",
      revaluations.length ? "warn" : "pass",
      revaluations.length,
      "Journals posted automatically when an exchange rate was saved. They revalued every Cash account as if it held CFA, whatever its currency, so their amounts need review; no new ones are posted.",
      revaluations,
      revaluations.reduce((sum, row) => sum.plus(toMoney(row.amount)), new MoneyDecimal(0)).toFixed(2)
    )
  );

  // 12. Container commission with no FACTORY-COMM-{container} journal (wave 8.4
  // continuation). Commission is journalled when it is set or changed; legacy
  // containers are listed here and in the factory-supplier memo, not back-filled.
  const unjournalledCommission = await rows<{
    id: number;
    container_number: string;
    commission_amount: string;
    currency: string;
  }>(sql`
    SELECT fc.id, fc.container_number, fc.commission_amount::text AS commission_amount,
           UPPER(COALESCE(fc.commission_currency_code, fc.currency_code, 'USD')) AS currency
      FROM factory_containers fc
     WHERE fc.company_id = ${companyId} AND fc.deleted_at IS NULL AND COALESCE(fc.commission_amount, 0) > 0
       AND NOT EXISTS (
         SELECT 1 FROM vouchers v
          WHERE v.company_id = fc.company_id AND ${LIVE}
            AND (v.voucher_number = 'FACTORY-COMM-' || fc.id::text
                 OR v.voucher_number LIKE 'FACTORY-COMM-' || fc.id::text || '-%'))
     ORDER BY fc.id
  `);
  checks.push(
    check(
      "factory_container_commission_not_journalled",
      unjournalledCommission.length ? "warn" : "pass",
      unjournalledCommission.length,
      "Containers whose commission has no FACTORY-COMM journal: legacy containers, or a commission with no confirmed rate or no payee. The factory supplier memo lists them; they are not back-filled.",
      unjournalledCommission
    )
  );

  // 13. Commission held outside the container (wave 14): on a raw-stock row
  // (opening-balance entries) or in factory_container_commissions (the
  // offload's record). The container journal posts the raw-stock commission
  // when the container has none of its own; a record is posted through its
  // container (the offload copies it there). Listed: a raw-stock commission
  // with no journal (legacy, no rate or no payee) or beside a container
  // commission of its own; a record its container does not carry.
  const outsideContainerCommission = await rows<{
    source: string;
    id: number;
    container_id: number;
    container_number: string;
    amount: string;
    currency: string;
    reason: string;
  }>(sql`
    SELECT 'rawStock' AS source, rs.id, fc.id AS container_id, fc.container_number,
           rs.commission_amount::text AS amount,
           UPPER(COALESCE(rs.commission_currency_code, fc.currency_code, 'USD')) AS currency,
           CASE WHEN COALESCE(fc.commission_amount, 0) > 0 THEN 'container-has-own-commission'
                ELSE 'no-journal' END AS reason
      FROM factory_raw_stock rs
      JOIN factory_containers fc ON fc.id = rs.container_id AND fc.company_id = rs.company_id
     WHERE rs.company_id = ${companyId} AND rs.deleted_at IS NULL AND fc.deleted_at IS NULL
       AND COALESCE(rs.commission_amount, 0) > 0
       AND (COALESCE(fc.commission_amount, 0) > 0 OR NOT EXISTS (
             SELECT 1 FROM vouchers v
              WHERE v.company_id = fc.company_id AND ${LIVE}
                AND v.voucher_number = 'FACTORY-COMM-' || fc.id::text))
    UNION ALL
    SELECT 'commissionRecord' AS source, MIN(cc.id) AS id, fc.id AS container_id, fc.container_number,
           SUM(cc.commission_total)::text AS amount, UPPER(cc.currency_code) AS currency,
           CASE WHEN COALESCE(fc.commission_amount, 0) > 0 THEN 'differs-from-container-commission'
                ELSE 'container-has-no-commission' END AS reason
      FROM factory_container_commissions cc
      JOIN factory_containers fc ON fc.id = cc.container_id AND fc.company_id = cc.company_id
     WHERE cc.company_id = ${companyId} AND fc.deleted_at IS NULL
     GROUP BY fc.id, fc.container_number, UPPER(cc.currency_code)
    HAVING NOT (COALESCE(MAX(fc.commission_amount), 0) > 0
                AND UPPER(COALESCE(MAX(fc.commission_currency_code), MAX(fc.currency_code), 'USD')) = UPPER(cc.currency_code)
                AND ROUND(MAX(fc.commission_amount), 2) = ROUND(SUM(cc.commission_total), 2))
     ORDER BY container_id, source
  `);
  checks.push(
    check(
      "factory_commission_outside_container_journal",
      outsideContainerCommission.length ? "warn" : "pass",
      outsideContainerCommission.length,
      "Commission held on a raw-stock row or in a container commission record that no FACTORY-COMM journal carries: a raw-stock commission with no journal (legacy, no rate or no payee) or beside the container's own commission, or a commission record its container does not carry (none, or another amount or currency). The memo lists those with no other commission on the container; none is back-filled.",
      outsideContainerCommission
    )
  );

  // 13b. Wave 16 (A): SP Goods-OTW vouchers whose supplier differs from their
  // container's. The container trigger no longer moves the supplier of posted
  // lines and startup no longer repairs them; they are listed here and changed
  // only through the Owner apply (/api/sp/admin/supplier-voucher-links/plan and /apply).
  // The supplier columns are added at runtime (spSupplierVoucherSync.ts); a
  // catalog read, so it carries no company_id predicate.
  const [spLinkColumns] = await rows<{ ready: boolean }>(sql`
    SELECT COUNT(*) = 3 AS ready FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name IN ('supplier_id', 'goods_otw_voucher_id')
       AND table_name IN (${SP_LINK_TABLES[0]}, ${SP_LINK_TABLES[1]})
       AND NOT (table_name = ${SP_LINK_TABLES[1]} AND column_name = 'goods_otw_voucher_id')
  `);
  const spLinkMismatches = spLinkColumns?.ready
    ? await rows<{
        container_id: number;
        voucher_id: number;
        voucher_number: string;
        container_supplier_id: number | null;
        voucher_supplier_id: number | null;
        mismatched_lines: number;
        amount: string;
      }>(sql`
        SELECT c.id AS container_id, v.id AS voucher_id, v.voucher_number,
               c.supplier_id AS container_supplier_id, v.supplier_id AS voucher_supplier_id,
               COUNT(ve.id)::int AS mismatched_lines,
               COALESCE(SUM(ve.credit_amount - ve.debit_amount), 0)::text AS amount
          FROM sp_containers c
          JOIN vouchers v ON v.id = c.goods_otw_voucher_id AND v.company_id = c.company_id
          LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
           AND ve.supplier_id IS DISTINCT FROM c.supplier_id
           AND EXISTS (SELECT 1 FROM ledger_accounts la
                        WHERE la.id = ve.ledger_account_id AND la.company_id = c.company_id
                          AND la.sub_type = 'sp_otw_clearing')
         WHERE c.company_id = ${companyId} AND ${LIVE}
         GROUP BY c.id, v.id, v.voucher_number, c.supplier_id, v.supplier_id
        HAVING v.supplier_id IS DISTINCT FROM c.supplier_id OR COUNT(ve.id) > 0
         ORDER BY v.id
      `)
    : [];
  checks.push(
    check(
      "sp_supplier_voucher_link_mismatch",
      spLinkMismatches.length ? "warn" : "pass",
      spLinkMismatches.length,
      "Supplier Partner Goods-OTW vouchers whose header or OTW-clearing lines name another supplier than their container. Listed, not repaired: the Owner preview/apply changes them, audited, outside closed periods.",
      spLinkMismatches,
      spLinkMismatches.reduce((acc, row) => acc.plus(toMoney(row.amount)), new MoneyDecimal(0)).toFixed(2)
    )
  );

  // 14. Payroll and advance postings missing from before wave 7 (listed, not back-filled).
  checks.push(...(await payrollAdvancePostingChecks(companyId)));

  // 15. Retail cash movements before wave 17 D and RETAIL-INVENTORY against the stock sub-ledger.
  checks.push(...(await retailLedgerChecks(companyId)));

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
