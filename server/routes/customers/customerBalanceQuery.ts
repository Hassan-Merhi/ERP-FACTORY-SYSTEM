import { db } from "../../db";
import { storage } from "../../storage";
import { getPartyBalances } from "../../services/accounting/balances/ledgerBalanceEngine";
import { toMoney } from "../../lib/money";

/**
 * Customers of a company with their ledger balance (/api/customers/stats, the
 * voucher sidebar, POS customers). The balance is the one balance engine's
 * customer closing (services/accounting/balances/ledgerBalanceEngine.ts): the
 * customer-owned opening, posted non-optional vouchers of this company dated
 * COALESCE(effective_date, voucher_date), and the lines the engine attributes
 * to the customer (its linked ledger, plus its customer-tagged lines that name
 * no other target), so these figures equal the trial balance's customer rows.
 */
export async function getCustomersWithBalances(companyId: number) {
  const customers = await storage.getAllCustomers(companyId);
  if (customers.length === 0) return [];

  const { parties } = await getPartyBalances(db, {
    companyId,
    kind: "customer",
    ids: customers.map((customer) => customer.id),
  });
  const byId = new Map(parties.map((party) => [party.id, party]));

  return customers.map((customer) => {
    const party = byId.get(customer.id);
    const signed = toMoney(party?.closing);
    return {
      ...customer,
      balance: signed.abs().toNumber(),
      balanceSide: signed.isNegative() && !signed.isZero() ? "Cr" : "Dr",
      historicalBaseBalance: toMoney(party?.historicalBaseClosing).toNumber(),
    };
  });
}
