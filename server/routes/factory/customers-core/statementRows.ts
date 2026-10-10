/**
 * Rows of the factory customer statement (page, Excel and PDF), on the one
 * balance engine (accounting audit wave 10).
 *
 *   - Ledger rows: every line the balance engine attributes to the customer
 *     (its linked ledger plus its customer-tagged lines that name no other
 *     target), from posted vouchers of the company, dated
 *     COALESCE(effective_date, voucher_date) — including the CHARGE- and
 *     INV-GL- journals that the old composite skipped because it rebuilt
 *     invoices from grand_total.
 *   - Memo rows (`notInLedger: true`): the amounts not yet in the ledger
 *     (balances/unpostedMemo.ts) — factory invoices with no INV-GL journal
 *     (their remainder after vouchered charges), factory POS credit sales and
 *     deposits, other cache-only customer_balances rows.
 *
 * A row's `ledgerEffect` moves the ledger balance, its `combinedEffect` the
 * combined figure (ledger + not in the ledger) the page has always shown.
 * Row notes stay on customer_balances rows: an invoice row (memo or INV-GL
 * journal) carries the id and note of its INVOICE cache row when there is one.
 */
import { and, eq } from "drizzle-orm";
import type Decimal from "decimal.js";
import { customerBalances } from "@shared/schema";

import { db } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getPartyBalance } from "../../../services/accounting/balances/ledgerBalanceEngine";
import { loadCustomerLedgerLines } from "../../../services/accounting/balances/customerLedgerStatement";
import { loadPartyMemoLines } from "../../../services/accounting/balances/unpostedMemo";

export interface FactoryStatementRow {
  id: number | string;
  customerId: number;
  companyId: number;
  transactionDate: string;
  transactionType: string;
  referenceType: string | null;
  referenceId: number | null;
  referenceNumber: string | null;
  description: string | null;
  debitAmount: string;
  creditAmount: string;
  balance: string;
  rowNote: string | null;
  currency: string;
  _fromVoucher: boolean;
  /** True for an amount that is not in the ledger (listed for information). */
  notInLedger: boolean;
  notInLedgerLabel: string | null;
  ledgerEffect: Decimal;
  combinedEffect: Decimal;
}

export interface FactoryCustomerStatement {
  rows: FactoryStatementRow[];
  /** The customer's opening (customer record), debit positive. */
  opening: Decimal;
  /** Engine closing, debit positive. */
  ledgerClosing: Decimal;
  /** Sum of the memo rows with a USD amount, debit positive. */
  notInLedgerTotal: Decimal;
}

const ZERO = new MoneyDecimal(0);

function amountsOf(value: Decimal) {
  return {
    debitAmount: value.greaterThan(0) ? value.toFixed(2) : "0",
    creditAmount: value.isNegative() ? value.negated().toFixed(2) : "0",
  };
}

export async function buildFactoryCustomerStatement(
  companyId: number,
  customerId: number
): Promise<FactoryCustomerStatement> {
  const [party, ledgerLines, memo, cacheRows] = await Promise.all([
    getPartyBalance(db, { companyId, kind: "customer", id: customerId }),
    loadCustomerLedgerLines(db, { companyId, customerId }),
    loadPartyMemoLines(db, { companyId, kind: "customer", ids: [customerId] }),
    db
      .select()
      .from(customerBalances)
      .where(and(eq(customerBalances.companyId, companyId), eq(customerBalances.customerId, customerId))),
  ]);

  const cacheById = new Map(cacheRows.map((row) => [row.id, row]));
  const invoiceCacheByOrder = new Map<number, (typeof cacheRows)[number]>();
  for (const row of cacheRows) {
    if (row.referenceType === "INVOICE" && row.transactionType === "SALE" && row.referenceId) {
      if (!invoiceCacheByOrder.has(row.referenceId)) invoiceCacheByOrder.set(row.referenceId, row);
    }
  }
  // INV-GL-{company}-{order}: the order id of this company's invoice journal.
  const invoiceJournalPrefix = `INV-GL-${companyId}-`;
  const invoiceOrderId = (voucherNumber: string | null): number | null => {
    if (!voucherNumber?.startsWith(invoiceJournalPrefix)) return null;
    const rest = voucherNumber.slice(invoiceJournalPrefix.length);
    return /^\d+$/.test(rest) ? Number(rest) : null;
  };

  const rows: FactoryStatementRow[] = [];
  for (const line of ledgerLines) {
    const effect = toMoney(line.debitAmount).minus(toMoney(line.creditAmount));
    const orderId = invoiceOrderId(line.voucherNumber ?? null);
    const invoiceCache = orderId ? invoiceCacheByOrder.get(orderId) : undefined;
    rows.push({
      id: invoiceCache?.id ?? `ve-${line.id}`,
      customerId,
      companyId,
      transactionDate: line.voucherDate,
      transactionType: orderId ? "SALE" : line.voucherType || "VOUCHER",
      referenceType: orderId ? "INVOICE" : "VOUCHER",
      referenceId: orderId ?? line.voucherId,
      referenceNumber: line.voucherNumber,
      description: line.narration || line.voucherDescription || line.voucherType,
      debitAmount: line.debitAmount ?? "0",
      creditAmount: line.creditAmount ?? "0",
      balance: "0",
      rowNote: invoiceCache?.rowNote ?? null,
      currency: line.currency ?? "USD",
      _fromVoucher: true,
      notInLedger: false,
      notInLedgerLabel: null,
      ledgerEffect: effect,
      combinedEffect: effect,
    });
  }

  for (const line of memo.get(customerId) ?? []) {
    const native = toMoney(line.nativeAmount);
    const usd = line.amount === null ? ZERO : toMoney(line.amount);
    const base = {
      customerId,
      companyId,
      transactionDate: line.date,
      balance: "0",
      currency: line.currency,
      _fromVoucher: false,
      notInLedger: true,
      notInLedgerLabel: line.label,
      ledgerEffect: ZERO,
      combinedEffect: usd,
      ...amountsOf(native),
    };
    if (line.source === "factoryInvoice") {
      const invoiceCache = invoiceCacheByOrder.get(line.sourceId);
      rows.push({
        ...base,
        id: invoiceCache?.id ?? `memo-invoice-${line.sourceId}`,
        transactionType: "SALE",
        referenceType: "INVOICE",
        referenceId: line.sourceId,
        referenceNumber: line.reference,
        description: invoiceCache?.description ?? `Invoice ${line.reference ?? ""}`.trim(),
        rowNote: invoiceCache?.rowNote ?? null,
      });
    } else {
      const cache = cacheById.get(line.sourceId);
      rows.push({
        ...base,
        id: line.sourceId,
        transactionType: cache?.transactionType ?? line.source,
        referenceType: cache?.referenceType ?? null,
        referenceId: cache?.referenceId ?? null,
        referenceNumber: line.reference,
        description: cache?.description ?? line.label,
        rowNote: cache?.rowNote ?? null,
      });
    }
  }

  // Oldest first; on the same day the operational rows come first, as before.
  rows.sort((a, b) => {
    const byDate = a.transactionDate.localeCompare(b.transactionDate);
    if (byDate !== 0) return byDate;
    return (a._fromVoucher ? 1 : 0) - (b._fromVoucher ? 1 : 0);
  });

  const notInLedgerTotal = rows.reduce((sum, row) => (row.notInLedger ? sum.plus(row.combinedEffect) : sum), ZERO);
  return {
    rows,
    opening: toMoney(party?.masterOpening),
    ledgerClosing: toMoney(party?.closing),
    notInLedgerTotal,
  };
}

/** Running balances (combined and ledger) over the rows, from the opening. */
export function withRunningBalances(statement: FactoryCustomerStatement) {
  let combined = statement.opening;
  let ledger = statement.opening;
  return statement.rows.map((row) => {
    combined = combined.plus(row.combinedEffect);
    ledger = ledger.plus(row.ledgerEffect);
    return { row, combined, ledger };
  });
}
