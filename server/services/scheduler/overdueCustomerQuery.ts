import { pool } from "../../db";
import { computeCustomerLedgerBalances } from "../../storage/accounting/customer-ledger-balance";

export interface OverdueCustomerBalanceRow {
  id: number;
  legal_name: string;
  payment_terms_days: number;
  company_id: number;
  net_balance: string;
  earliest_invoice_date: string | Date | null;
}

type OverdueCandidateRow = {
  id: number;
  legal_name: string;
  payment_terms_days: number;
  company_id: number;
  ledger_account_id: number | null;
  opening_balance: string | null;
  opening_balance_side: string | null;
  earliest_invoice_date: string | Date | null;
};

/**
 * Customers with payment terms, and the earliest day they were charged: the
 * first posted voucher line that debits them (same line ownership as the
 * balance rules) or, for operational invoices not yet posted, the first debit
 * in the customer_balances cache. The balance itself comes from the ledger
 * rules in storage/accounting/customer-ledger-balance.ts, so a voucher receipt
 * reduces it and a null opening side counts as the customer default (Dr).
 */
export const OVERDUE_CUSTOMER_CANDIDATES_SQL = `
  SELECT
    c.id,
    c.legal_name,
    c.payment_terms_days,
    c.company_id,
    c.ledger_account_id,
    c.opening_balance,
    c.opening_balance_side,
    LEAST(
      (
        SELECT MIN(COALESCE(v.effective_date, v.voucher_date))
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.company_id = c.company_id
          AND v.optional = false
          AND v.deleted_at IS NULL
          AND COALESCE(ve.debit_amount, 0)::numeric > COALESCE(ve.credit_amount, 0)::numeric
          AND (
            (c.ledger_account_id IS NOT NULL AND ve.ledger_account_id = c.ledger_account_id)
            OR (ve.customer_id = c.id AND (c.ledger_account_id IS NULL OR ve.ledger_account_id IS NULL))
          )
      ),
      (
        SELECT MIN(cb.transaction_date)
        FROM customer_balances cb
        WHERE cb.customer_id = c.id
          AND cb.company_id = c.company_id
          AND COALESCE(cb.debit_amount, 0)::numeric > 0
      )
    ) AS earliest_invoice_date
  FROM customers c
  WHERE c.payment_terms_days IS NOT NULL
    AND c.deleted_at IS NULL
    AND c.active = true
`;

export async function loadOverdueCustomerBalances(): Promise<OverdueCustomerBalanceRow[]> {
  const result = await pool.query<OverdueCandidateRow>(OVERDUE_CUSTOMER_CANDIDATES_SQL);
  const byCompany = new Map<number, OverdueCandidateRow[]>();
  for (const row of result.rows) {
    const list = byCompany.get(row.company_id) ?? [];
    list.push(row);
    byCompany.set(row.company_id, list);
  }

  const rows: OverdueCustomerBalanceRow[] = [];
  for (const [companyId, candidates] of byCompany) {
    const balances = await computeCustomerLedgerBalances(
      companyId,
      candidates.map((c) => ({
        id: c.id,
        ledgerAccountId: c.ledger_account_id,
        openingBalance: c.opening_balance,
        openingBalanceSide: c.opening_balance_side,
      }))
    );
    for (const candidate of candidates) {
      const signed = balances.get(candidate.id)?.signed;
      if (!signed || !signed.greaterThan(0)) continue;
      rows.push({
        id: candidate.id,
        legal_name: candidate.legal_name,
        payment_terms_days: candidate.payment_terms_days,
        company_id: candidate.company_id,
        net_balance: signed.toFixed(2),
        earliest_invoice_date: candidate.earliest_invoice_date,
      });
    }
  }
  return rows;
}
