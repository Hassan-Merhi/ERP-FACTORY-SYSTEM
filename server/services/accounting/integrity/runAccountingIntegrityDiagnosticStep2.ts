// Extracted from ./accountingIntegrityDiagnostic.ts to keep that module under the source-size cap.
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { classifyAccountType } from "../accountClassification";
import { diagnoseSystemAccounts, SYSTEM_ACCOUNTS } from "../systemAccounts";
import { getPartyBalances, liveVouchersOf } from "../balances/ledgerBalanceEngine";
import { LIVE, check, rows, runAccountingIntegrityDiagnosticStep1 } from "./runAccountingIntegrityDiagnosticStep1";

export async function runAccountingIntegrityDiagnosticStep2(
  {
    checks,
    lineAmount,
  }: Pick<Awaited<ReturnType<typeof runAccountingIntegrityDiagnosticStep1>>, "checks" | "lineAmount">,
  companyId: number
) {
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
      "Legacy EMP-<code> ledger accounts still holding lines or an opening. Their lines move employees.current_balance but count under the account, not the employee, in every ledger balance; migrate them onto the employee (POST /api/admin/migrate-employee-account/:id, Admin/Owner, audited); it refuses an account with an opening, which it does not carry, so move the opening with a journal first.",
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
  return { accounts };
}
