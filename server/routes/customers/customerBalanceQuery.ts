import { storage } from "../../storage";
import { computeCustomerLedgerBalances } from "../../storage/accounting/customer-ledger-balance";

/**
 * Customers of a company with their ledger balance (/api/customers/stats, the
 * voucher sidebar, POS customers). The rules — customer-owned opening, posted
 * non-optional vouchers of this company, COALESCE(effective_date, voucher_date),
 * linked-ledger lines plus customer-tagged lines with no other ledger, debit
 * minus credit — live in storage/accounting/customer-ledger-balance.ts.
 */
export async function getCustomersWithBalances(companyId: number) {
  const customers = await storage.getAllCustomers(companyId);
  if (customers.length === 0) return [];

  const balances = await computeCustomerLedgerBalances(companyId, customers);

  return customers.map((customer) => {
    const entry = balances.get(customer.id);
    const signed = entry?.signed;
    const isCredit = signed ? signed.isNegative() && !signed.isZero() : false;
    return {
      ...customer,
      balance: signed ? signed.abs().toNumber() : 0,
      balanceSide: isCredit ? "Cr" : "Dr",
      historicalBaseBalance: entry ? entry.historicalBase.toNumber() : 0,
    };
  });
}
