/**
 * The ledger voucher of a factory POS sale (accounting audit wave 8.4
 * continuation, owner decisions 1 and 2).
 *
 * Before: the sale wrote one Receipt voucher `FPOS-{sale}-{timestamp}` in the
 * sale currency at rate 1 with the native amounts in the USD base columns; a
 * credit sale's voucher carried only its deposit (Dr cash / Cr income), so the
 * revenue and receivable of the unpaid part never reached the ledger; with
 * deductions larger than the cash received it did not balance (Dr was capped
 * at zero, Cr stayed gross) and the balance guard refused the sale; with no
 * cash account nothing was posted at all.
 *
 * Now: one voucher `FPOS-RCPT-{sale}`, replaced whole on every edit and
 * removed on a void, normalized like the wave 6 factory writers (USD base in
 * debit/credit, native amounts in transaction_*, the factory rate, USD per
 * unit, as the historical rate):
 *
 *   Dr/Cr cash account      cash received less the deductions paid from it
 *                           (the sale total for a cash sale, the deposit for a
 *                           credit sale); credited when the deductions exceed
 *                           what was received
 *   Dr deduction accounts   each deduction (expense) at its amount
 *   Dr customer ledger      the unpaid part of a credit sale (total − deposit),
 *                           on the customer's own account (CUST-{id}, as the
 *                           wave 8.4 invoices); credited for a deposit above
 *                           the total
 *      Cr Factory Bale Sales Income   the full sale total
 *
 * Debits equal credits by construction. The rate is the company's confirmed
 * factory rate dated on or before the sale date (factoryFxRateOnDate.ts); a
 * non-USD sale with no such rate is refused (409) before anything is written.
 * A sale whose cash leg is not zero needs a cash account (400); a credit sale
 * with an unpaid part needs a customer of the company (400). A credit sale
 * with no deposit and no deductions needs no cash account and posts the
 * receivable only (a Journal); a sale with a cash leg is a Receipt.
 *
 * customer_balances keeps its operational rows while the sale is live (an
 * edit re-writes them, a void removes them, wave 14); the not-in-ledger memo
 * (balances/unpostedMemo.ts) no longer lists a sale with a live FPOS-RCPT
 * voucher, which carries its receivable. Sales posted before (FPOS-{sale}-…,
 * deposit only) stay listed until they are edited, which replaces their
 * voucher with this one.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { voucherEntries } from "@shared/schema";

import type { DatabaseOrTransaction, DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { MoneyDecimal } from "../../lib/money";
import { findFactoryFxRateOnOrBefore, normalizeFactoryCurrency } from "../factory/factoryFxRateOnDate";
import { normFactoryEntry } from "../factory/factoryVoucherEntryAmounts";
import { infrastructurePostingIdentity, insertInfrastructureVoucherTx } from "./infrastructureVoucherIdentity";
import { retireVouchersTx } from "./voucherRetirement";
import { customerLedgerAccountTx } from "./perpetualInventory/factoryInvoice";
import { ledgerAccountByCodeTx } from "./perpetualInventory/linkedJournal";

export const FACTORY_POS_RECEIPT_SOURCE = "factory-pos-receipt";

/** Deterministic: sale ids are unique across companies. */
export const factoryPosReceiptVoucherNumber = (saleId: number) => `FPOS-RCPT-${saleId}`;

export const FACTORY_POS_RATE_UNCONFIRMED = "FACTORY_POS_RATE_UNCONFIRMED" as const;
export const FACTORY_POS_RATE_UNCONFIRMED_MESSAGE =
  "This sale is in a currency with no confirmed exchange rate on or before its date. Enter the factory exchange rate for that currency first.";
export const FACTORY_POS_CASH_ACCOUNT_REQUIRED_MESSAGE = "Choose the cash account that receives this sale's payment.";
export const FACTORY_POS_CUSTOMER_REQUIRED_MESSAGE = "A credit sale with an unpaid amount needs a customer.";

/** A sale the ledger cannot carry: refused before anything is written. */
export class FactoryPosSaleRefusalError extends HttpError {
  constructor(
    statusCode: number,
    message: string,
    readonly code?: string
  ) {
    super(statusCode, message);
    this.name = "FactoryPosSaleRefusalError";
  }

  get body() {
    return this.code ? { code: this.code, message: this.message } : { message: this.message };
  }
}

export interface FactoryPosSaleAmounts {
  isCredit: boolean;
  /** Sale total, native. */
  total: Decimal;
  /** Deposit received on a credit sale, native (0 for a cash sale). */
  deposit: Decimal;
  deductions: ReadonlyArray<{ accountId: number; description: string; amount: Decimal }>;
}

/** Cash received less the deductions paid from it (signed, native). */
export function factoryPosCashLeg(amounts: FactoryPosSaleAmounts): Decimal {
  const received = amounts.isCredit ? amounts.deposit : amounts.total;
  return amounts.deductions.reduce((sum, row) => sum.minus(row.amount), new MoneyDecimal(received));
}

/** The unpaid part of a credit sale (signed, native); zero for a cash sale. */
export function factoryPosUnpaid(amounts: FactoryPosSaleAmounts): Decimal {
  return amounts.isCredit ? amounts.total.minus(amounts.deposit) : new MoneyDecimal(0);
}

/** The refusal for a sale the ledger could not carry, or null. */
export function factoryPosSaleRefusal(
  amounts: FactoryPosSaleAmounts,
  parties: { cashAccountId: number | null; customerId: number | null }
): FactoryPosSaleRefusalError | null {
  if (!factoryPosCashLeg(amounts).isZero() && !parties.cashAccountId) {
    return new FactoryPosSaleRefusalError(400, FACTORY_POS_CASH_ACCOUNT_REQUIRED_MESSAGE);
  }
  if (!factoryPosUnpaid(amounts).isZero() && !parties.customerId) {
    return new FactoryPosSaleRefusalError(400, FACTORY_POS_CUSTOMER_REQUIRED_MESSAGE);
  }
  return null;
}

/**
 * The factory rate (USD per unit) of a sale on its date. Throws the 409
 * refusal for a non-USD sale with no confirmed rate dated on or before it.
 */
export async function factoryPosSaleRate(
  executor: DatabaseOrTransaction,
  companyId: number,
  currency: string | null | undefined,
  saleDate: string
): Promise<string> {
  const found = await findFactoryFxRateOnOrBefore(executor, companyId, currency, saleDate);
  if (!found) {
    throw new FactoryPosSaleRefusalError(409, FACTORY_POS_RATE_UNCONFIRMED_MESSAGE, FACTORY_POS_RATE_UNCONFIRMED);
  }
  return found.rate;
}

async function voucherIdsTx(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<number[]> {
  const result = await tx.execute(query);
  return (result.rows as unknown as { id: number }[]).map((row) => Number(row.id));
}

/**
 * Removes the sale's receipt voucher: the FPOS-RCPT one and any legacy
 * FPOS-{sale}-{timestamp} one (with their posting identities).
 */
export async function removeFactoryPosReceiptTx(tx: DbTransaction, companyId: number, saleId: number): Promise<void> {
  const ids = await voucherIdsTx(
    tx,
    sql`SELECT id FROM vouchers
         WHERE company_id = ${companyId}
           AND (voucher_number = ${factoryPosReceiptVoucherNumber(saleId)}
                OR (source_module = 'FACTORY_POS' AND voucher_number LIKE ${`FPOS-${saleId}-%`}))`
  );
  // Wave 16 (A): retired (soft delete, audited, number and identity released), not hard-deleted.
  await retireVouchersTx(tx, { companyId, voucherIds: ids, reason: "factory-pos-receipt-replaced" });
}

export interface FactoryPosReceiptInput extends FactoryPosSaleAmounts {
  companyId: number;
  saleId: number;
  saleNumber: string;
  voucherDate: string;
  currency: string;
  /** USD per unit of `currency` (factoryPosSaleRate). */
  rate: string;
  customerName?: string | null;
  customerId: number | null;
  cashAccountId: number | null;
}

interface ReceiptLine {
  ledgerAccountId: number;
  customerId?: number;
  debit: Decimal;
  credit: Decimal;
  narration: string;
}

/** A signed native amount as one debit or credit line (debit positive); null when zero. */
function signedLine(
  amount: Decimal,
  target: { ledgerAccountId: number; customerId?: number },
  narration: string
): ReceiptLine | null {
  const value = amount.toDecimalPlaces(2);
  if (value.isZero()) return null;
  const zero = new MoneyDecimal(0);
  return {
    ...target,
    debit: value.isNegative() ? zero : value,
    credit: value.isNegative() ? value.negated() : zero,
    narration,
  };
}

/**
 * Posts (replacing any earlier one) the sale's ledger voucher. Returns its id,
 * or null when the sale has no amount. The caller has already refused a sale
 * factoryPosSaleRefusal rejects and resolved the rate.
 */
export async function postFactoryPosReceiptTx(
  tx: DbTransaction,
  input: FactoryPosReceiptInput
): Promise<number | null> {
  await removeFactoryPosReceiptTx(tx, input.companyId, input.saleId);
  const refusal = factoryPosSaleRefusal(input, { cashAccountId: input.cashAccountId, customerId: input.customerId });
  if (refusal) throw refusal;
  const total = input.total.toDecimalPlaces(2);
  if (!total.gt(0)) return null;

  const currency = normalizeFactoryCurrency(input.currency);
  const sale = input.saleNumber;
  const who = input.customerName ? ` – ${input.customerName}` : "";
  const cashLeg = factoryPosCashLeg(input);
  const unpaid = factoryPosUnpaid(input);
  const revenueAccountId = await ledgerAccountByCodeTx(
    tx,
    input.companyId,
    "FACTORY_BALE_SALES_INCOME",
    "Factory Bale Sales Income",
    "Income"
  );
  const lines: ReceiptLine[] = [];
  if (input.cashAccountId) {
    const cash = signedLine(
      cashLeg,
      { ledgerAccountId: input.cashAccountId },
      input.isCredit ? `Deposit on credit sale – ${sale}` : `Factory POS cash receipt – ${sale}`
    );
    if (cash) lines.push(cash);
  }
  for (const row of input.deductions) {
    const deduction = signedLine(
      row.amount,
      { ledgerAccountId: row.accountId },
      row.description || `POS deduction – ${sale}`
    );
    if (deduction) lines.push(deduction);
  }
  if (input.customerId && !unpaid.isZero()) {
    const customerAccountId = await customerLedgerAccountTx(tx, input.companyId, input.customerId);
    const receivable = signedLine(
      unpaid,
      { ledgerAccountId: customerAccountId, customerId: input.customerId },
      `Factory POS credit sale – ${sale}`
    );
    if (receivable) lines.push(receivable);
  }
  lines.push({
    ledgerAccountId: revenueAccountId,
    debit: new MoneyDecimal(0),
    credit: total,
    narration: `Factory POS sales income – ${sale}`,
  });

  const debits = lines.reduce((sum, line) => sum.plus(line.debit), new MoneyDecimal(0));
  const credits = lines.reduce((sum, line) => sum.plus(line.credit), new MoneyDecimal(0));
  if (!debits.eq(credits)) throw new Error("A factory POS sale voucher does not balance");

  const { voucher } = await insertInfrastructureVoucherTx(
    tx,
    {
      companyId: input.companyId,
      voucherType: cashLeg.isZero() ? "Journal" : "Receipt",
      voucherNumber: factoryPosReceiptVoucherNumber(input.saleId),
      voucherDate: input.voucherDate,
      description: ["Factory POS Sale", `${sale}${who}`].join(" "),
      totalAmount: total.toFixed(2),
      currency,
      exchangeRate: input.rate,
      sourceModule: "FACTORY_POS",
    },
    infrastructurePostingIdentity(FACTORY_POS_RECEIPT_SOURCE, input.saleId)
  );
  await tx.insert(voucherEntries).values(
    lines.map((line) => ({
      voucherId: voucher.id,
      ledgerAccountId: line.ledgerAccountId,
      ...(line.customerId ? { customerId: line.customerId } : {}),
      ...normFactoryEntry(currency, line.debit.toFixed(2), line.credit.toFixed(2), input.rate),
      narration: line.narration,
    }))
  );
  return voucher.id;
}
