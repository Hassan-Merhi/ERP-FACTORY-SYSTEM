/**
 * EUR eligibility for an FX agent's same-currency supplier payment.
 *
 * A broker's Parties "Net Balance (EUR)" is an operational settlement pool,
 * not its posted GL/native balance. Read the SAME broker statement projection
 * on both the voucher UI and the guarded payment transaction.
 */
import type { DatabaseOrTransaction } from "../../db";
import { toMoney } from "../../lib/money";
import { buildBrokerStatement } from "../../routes/factory/suppliers/broker/_helpers";
import { loadFactorySupplierLedgerViews } from "../../routes/factory/suppliers/balance/factorySupplierLedger";

export type FxAgentEurSupplierPayable = {
  currencyCode: "EUR";
  balance: string;
  basis: "broker-statement" | "native-ledger";
  includeOtw: boolean;
  eligible: boolean;
};

export async function loadFxAgentEurSupplierPayable(
  executor: DatabaseOrTransaction,
  companyId: number,
  supplier: { id: number; isBroker: boolean },
  includeOtw = true
): Promise<FxAgentEurSupplierPayable> {
  if (supplier.isBroker) {
    const statement = await buildBrokerStatement(supplier.id, companyId, includeOtw, { executor });
    if (!statement) throw new Error("Broker statement is unavailable");
    const eur = statement.currencyLedgers.find((section) => section.currencyCode === "EUR");
    const balance = eur ? toMoney(eur.netBalance) : toMoney(0);
    return {
      currencyCode: "EUR",
      balance: balance.toFixed(2),
      basis: "broker-statement",
      includeOtw,
      eligible: balance.gt(0),
    };
  }

  const view = (await loadFactorySupplierLedgerViews(executor, companyId, { ids: [supplier.id] }))
    .get(supplier.id);
  const eur = view?.nativeBalances.find((bucket) => bucket.currencyCode === "EUR");
  const eligible = !!eur && eur.legacyUnconvertedLines === 0 && toMoney(eur.balance).gt(0);
  return {
    currencyCode: "EUR",
    balance: eligible && eur ? toMoney(eur.balance).toFixed(2) : "0.00",
    basis: "native-ledger",
    includeOtw: false,
    eligible,
  };
}
