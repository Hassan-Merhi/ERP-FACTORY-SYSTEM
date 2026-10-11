import { pool } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { getAgingReport } from "../reports/agingReport";

export interface OverdueCustomerBalanceRow {
  id: number;
  legal_name: string;
  payment_terms_days: number;
  company_id: number;
  /** The customer's engine balance (Dr positive). */
  net_balance: string;
  /** The open amount past its due date. */
  overdue_amount: string;
  /** Booked date of the oldest open invoice past its due date. */
  earliest_invoice_date: string | null;
  /** Its due date (booked date + payment terms). */
  due_date: string;
  days_overdue: number;
  /** The company's book currency (for the reminder text). */
  currency: string;
}

/**
 * Active customers of every company with an open invoice past its due date
 * (accounting audit phase 25, AR-4): the aging's open items — invoices
 * settled by receipts, credit notes and advances through the allocation
 * table (FIFO by due date), each due its booked date + the customer's payment
 * terms (30 days when it has none, decided by default). It used to take the
 * first debit ever, so one old paid invoice marked a customer overdue for good.
 */
export const OVERDUE_CUSTOMER_COMPANIES_SQL = `
  SELECT DISTINCT c.company_id, COALESCE(co.base_currency, 'USD') AS currency
    FROM customers c
    JOIN companies co ON co.id = c.company_id
   WHERE c.deleted_at IS NULL AND c.active = true
`;

export async function loadOverdueCustomerBalances(): Promise<OverdueCustomerBalanceRow[]> {
  const companies = await pool.query<{ company_id: number; currency: string }>(OVERDUE_CUSTOMER_COMPANIES_SQL);
  // Every active customer's name, read once (WHERE company_id = $1 per company was one query each).
  const active = await pool.query<{ id: number; company_id: number; legal_name: string }>(
    `SELECT id, company_id, legal_name FROM customers WHERE deleted_at IS NULL AND active = true`
  );
  const namesByCompany = new Map<number, Map<number, string>>();
  for (const row of active.rows) {
    const companyId = Number(row.company_id);
    if (!namesByCompany.has(companyId)) namesByCompany.set(companyId, new Map());
    namesByCompany.get(companyId)!.set(Number(row.id), row.legal_name);
  }
  const rows: OverdueCustomerBalanceRow[] = [];
  for (const company of companies.rows) {
    const companyId = Number(company.company_id);
    const names = namesByCompany.get(companyId) ?? new Map<number, string>();
    const report = await getAgingReport(companyId, "customer", null);
    for (const party of report.parties) {
      const name = names.get(party.id);
      if (name === undefined || !toMoney(party.balance).greaterThan(0)) continue;
      const past = party.openItems.filter((item) => item.daysPastDue !== null && item.daysPastDue > 0);
      if (past.length === 0) continue;
      const oldest = past.reduce((a, b) => ((a.dueDate ?? "") <= (b.dueDate ?? "") ? a : b));
      const overdue = past.reduce((sum, item) => sum.plus(item.open), new MoneyDecimal(0));
      rows.push({
        id: party.id,
        legal_name: name,
        payment_terms_days: party.paymentTermsDays,
        company_id: companyId,
        net_balance: party.balance,
        overdue_amount: overdue.toFixed(2),
        earliest_invoice_date: oldest.bookedOn,
        due_date: oldest.dueDate!,
        days_overdue: oldest.daysPastDue!,
        currency: String(company.currency || "USD").toUpperCase(),
      });
    }
  }
  return rows;
}
