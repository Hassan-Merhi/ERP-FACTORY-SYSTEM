/**
 * "Not yet in the ledger" memo lines (accounting audit wave 10, owner rule 3).
 *
 * Balances come from the ledger only. Some amounts a party owes or is owed
 * never reached the ledger; they are listed here, next to the party's ledger
 * balance, clearly labelled, and never added into it:
 *
 * Customers
 *   - factoryInvoice: a FINALIZED factory invoice (customer order, including a
 *     dispatch-batch invoice) with no live INV-GL-{company}-{order} journal:
 *     invoices finalized before the company's perpetual-inventory cut-over and
 *     invoices in a currency other than USD (no rate to post at). The amount
 *     is the grand total less the charges that already have their own live
 *     CHARGE- voucher (those debit the customer ledger), which is exactly the
 *     receivable the INV-GL journal would post (perpetualInventory/factoryInvoice.ts).
 *   - factoryPosCreditSale / factoryPosDeposit: factory POS credit sales and
 *     their deposits written only to the customer_balances cache: sales posted
 *     before wave 8.4 continuation, whose FPOS-{sale}-{timestamp} receipt
 *     voucher debited cash and credited sales income for the deposit only and
 *     never touched the customer. A sale with a live FPOS-RCPT-{sale} voucher
 *     is not listed: that voucher carries the full revenue and the unpaid part
 *     on the customer's ledger (accounting/factoryPosReceipt.ts). A voided sale
 *     is not listed either: since wave 14 the void removes its cache rows (as
 *     an edit does); a sale voided before keeps them, and they stay unlisted.
 *   - customerBalanceCache: any other customer_balances row with no ledger
 *     counterpart, e.g. a legacy payment recorded against an invoice, or a
 *     credit-sale import row whose voucher was deleted.
 *   Not listed, because the ledger already carries them: the INVOICE/SALE
 *   cache row of a factory invoice (the order above is its source), a
 *   'voucher' row whose voucher is live (credit-sales import), and legacy
 *   CONTAINER_SALE rows (ERP container sales were posted as vouchers on the
 *   customer's ledger).
 *
 * Factory suppliers (amounts we owe are negative, debit positive)
 *   - factoryContainerGoods: a container's goods value with no live
 *     FACTORY-IMPORT-{container}- journal (legacy containers);
 *   - factoryContainerFreight: supplier-paid freight with no live
 *     FACTORY-FREIGHT-{container} journal;
 *   - factoryContainerCommission: container commission with no live
 *     FACTORY-COMM-{container} journal (legacy containers: commission is
 *     journalled since wave 8.4 continuation, factory/containerCommissionJournal.ts),
 *     listed under the party that journal credits: the commission supplier
 *     (broker) when the container names one, else the container's supplier.
 *   - factoryRawStockCommission: commission held on a container's raw-stock
 *     row (an opening-balance entry) with no live FACTORY-COMM-{container}
 *     journal, on a container with no commission of its own (wave 14: the
 *     journal posts it; legacy rows, or no rate or no payee, stay here),
 *     listed under the row's commission supplier, else the container's
 *     supplier, at the row's own stored rate (positive, not the unset 1) or
 *     the container's confirmed rate for the container's currency.
 *   - factoryCommissionRecord: an offload commission record
 *     (factory_container_commissions) on a container that carries no
 *     commission (the journal posts the container's commission, which the
 *     offload copies from the record), at the record's confirmed rate, under
 *     the container's commission party. A record that differs from its
 *     container's commission is listed by the integrity diagnostic only.
 *   Amounts in another currency are converted at the container's stored,
 *   confirmed rate; with no such rate `amount` is null (the line is listed
 *   with its native amount and left out of the memo total).
 *
 * Every line carries its own date and is listed when dated on or before the
 * as-of date.
 */
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import {
  customerLabel,
  customerMemoRows,
  type Executor,
  type MemoQuery,
  type PartyBalanceMemoLine,
} from "./unpostedMemoCustomerMemoRows";
import { factorySupplierMemoLines } from "./unpostedMemoHelpers";
export { MEMO_NO_RATE_LABEL, MEMO_SOURCE_LABELS } from "./unpostedMemoCustomerMemoRows";
export type { MemoPartyKind, MemoQuery, MemoSource, PartyBalanceMemoLine } from "./unpostedMemoCustomerMemoRows";

/** Memo lines per party id, sorted by date. */
export async function loadPartyMemoLines(
  executor: Executor,
  query: MemoQuery
): Promise<Map<number, PartyBalanceMemoLine[]>> {
  const byParty = new Map<number, PartyBalanceMemoLine[]>();
  if (query.ids.length === 0) return byParty;
  const add = (partyId: number, line: PartyBalanceMemoLine) => {
    const list = byParty.get(partyId) ?? [];
    list.push(line);
    byParty.set(partyId, list);
  };

  if (query.kind === "customer") {
    for (const row of await customerMemoRows(executor, query)) {
      const native = toMoney(row.native);
      if (native.isZero()) continue;
      const currency = row.currency ?? "USD";
      add(row.party_id, {
        source: row.source,
        reference: row.reference,
        sourceId: row.source_id,
        date: row.date,
        amount: currency === "USD" ? native.toFixed(2) : null,
        nativeAmount: native.toFixed(2),
        currency,
        label: customerLabel(row),
        notInLedger: true,
      });
    }
  } else {
    for (const { partyId, line } of await factorySupplierMemoLines(executor, query)) add(partyId, line);
  }

  for (const list of byParty.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source) || a.sourceId - b.sourceId);
  }
  return byParty;
}

/** Sum of the USD amounts of memo lines (lines without a rate are left out), optionally only those before a day. */
export function memoTotal(lines: readonly PartyBalanceMemoLine[], before?: string | null): Decimal {
  return lines
    .filter((line) => line.amount !== null && (!before || line.date < before))
    .reduce((sum, line) => sum.plus(toMoney(line.amount)), new MoneyDecimal(0));
}
