import { db, pool } from "../../db";
import { getPartyBalances } from "../accounting/balances/ledgerBalanceEngine";
import { customerOwnedLinePredicate } from "../accounting/balances/partyLineRules";
import { toMoney } from "../../lib/money";

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
  earliest_invoice_date: string | Date | null;
};

/**
 * Customers with payment terms, and the earliest day they were charged: the
 * first posted voucher line that debits them (the balance engine's line
 * ownership, partyLineRules.ts) or, for operational invoices not yet posted,
 * the first debit in the customer_balances cache. The balance itself is the
 * one balance engine's customer closing (ledger only), so a voucher receipt
 * reduces it and a null opening side counts as the customer default (Dr).
 */
export const OVERDUE_CUSTOMER_CANDIDATES_SQL = `
  SELECT
    c.id,
    c.legal_name,
    c.payment_terms_days,
    c.company_id,
    LEAST(
      (
        SELECT MIN(COALESCE(v.effective_date, v.voucher_date))
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE v.company_id = c.company_id
          AND v.optional = false
          AND v.deleted_at IS NULL
          AND COALESCE(ve.debit_amount, 0)::numeric > COALESCE(ve.credit_amount, 0)::numeric
          AND ${customerOwnedLinePredicate("ve", "c.company_id", "c.id")}
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
    const { parties } = await getPartyBalances(db, {
      companyId,
      kind: "customer",
      ids: candidates.map((c) => c.id),
    });
    const closing = new Map(parties.map((party) => [party.id, toMoney(party.closing)]));
    for (const candidate of candidates) {
      const signed = closing.get(candidate.id);
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
