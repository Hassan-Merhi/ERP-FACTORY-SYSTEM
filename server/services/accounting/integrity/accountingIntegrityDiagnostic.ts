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
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { CANONICAL_ACCOUNT_TYPES } from "../accountClassification";
import { payrollAdvancePostingChecks } from "./payrollAdvancePostingChecks";
import { retailLedgerChecks } from "./retailLedgerChecks";
import { ledgerShapeChecks } from "./ledgerShapeChecks";
import { auditTrailChecks } from "./auditTrailChecks";
import {
  LIVE,
  check,
  rows,
  runAccountingIntegrityDiagnosticStep1,
  type IntegrityCheck,
  type IntegrityStatus,
} from "./runAccountingIntegrityDiagnosticStep1";
import { runAccountingIntegrityDiagnosticStep2 } from "./runAccountingIntegrityDiagnosticStep2";
import { runAccountingIntegrityDiagnosticStep3 } from "./runAccountingIntegrityDiagnosticStep3";
export type { IntegrityCheck, IntegrityStatus } from "./runAccountingIntegrityDiagnosticStep1";

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

export { CANONICAL_ACCOUNT_TYPES };
/** Tables whose runtime supplier-link columns the SP mismatch check needs (wave 16 A). */
const SP_LINK_TABLES = ["sp_containers", "vouchers"] as const;

export async function runAccountingIntegrityDiagnostic(companyId: number): Promise<AccountingIntegrityReport> {
  const { checks, lineAmount, trialBalance } = await runAccountingIntegrityDiagnosticStep1(companyId);
  const { accounts } = await runAccountingIntegrityDiagnosticStep2({ checks, lineAmount }, companyId);
  await runAccountingIntegrityDiagnosticStep3({ accounts, checks }, companyId);
  const { status } = await runAccountingIntegrityDiagnosticStep4({ checks }, companyId);

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

async function runAccountingIntegrityDiagnosticStep4(
  { checks }: Pick<Awaited<ReturnType<typeof runAccountingIntegrityDiagnosticStep1>>, "checks">,
  companyId: number
) {
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
  // Phase 19 (B): D5 voucher shape and C5 account tree, listed.
  checks.push(...(await ledgerShapeChecks(companyId)));
  // Phase 21 (A): audit triggers present and enabled, unknown actors, hash chain.
  checks.push(...(await auditTrailChecks(companyId)));

  const status: IntegrityStatus = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "pass";
  return { status };
}
