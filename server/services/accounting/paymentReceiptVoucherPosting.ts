/**
 * The create path of POST /api/vouchers/payment-receipt (Payment / Receipt
 * against ledger, cash, bank, customer, supplier, factory supplier, employee
 * or fixed-asset accounts), on the caller's transaction. Shared by the live
 * route and by the Phase 9 cloud replay of a factory LAN payment, so both
 * post exactly the same voucher, entries, employee balances and audit.
 */
import type Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { customers, ledgerAccounts, vouchers } from "@shared/schema";
import { factorySettings as fSettings, factoryDaybookEntries as fde } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../lib/money";
import { syncEmployeeBalancesFromEntries } from "../../routes/_helpers";
import { writeVoucherAuditTx } from "../../routes/helpers/voucherAuditTrail";
import { erpRateToDaybookFxRateToUsd, normalizeVoucherEntryAmounts } from "./currencyAmounts";
import { postManualVoucherTx } from "./erpVoucherPosting";

export class PaymentReceiptInputError extends Error {
  readonly status = 400;
}

export interface PaymentReceiptEntryInput {
  accountType: string;
  accountId: number;
  amount: string | number;
}

export interface PaymentReceiptInput {
  companyId: number;
  voucherType: "Payment" | "Receipt";
  voucherDate: string;
  paymentAccountType: string;
  paymentAccountId: number;
  entries: PaymentReceiptEntryInput[];
  notes: string | null;
  optional: boolean;
  currency: string;
  /** The resolved rate (transaction units per USD) or null for USD. */
  exchangeRate: string | null;
  effectiveDate: string | null;
  /** Idempotency source id for the posting engine. */
  sourceId: string;
  actor: { userId: string | null | undefined; username: string | null | undefined };
  reason: string;
}

/**
 * A payment or receipt voucher's totals, exact: the entries summed in the
 * voucher currency and the base (USD) total stored on the voucher, CFA ÷ rate
 * for non-USD vouchers. Null when an entry amount is not a number.
 */
export function paymentVoucherTotals(
  entries: readonly { amount?: unknown }[],
  currency: string,
  rateRaw: string | number | null
): { transactionTotal: Decimal; baseTotal: Decimal } | null {
  let transactionTotal: Decimal = new MoneyDecimal(0);
  for (const entry of entries) {
    const amount =
      entry.amount === undefined || entry.amount === null || entry.amount === ""
        ? new MoneyDecimal(0)
        : parseMoneyInput(entry.amount as string | number);
    if (!amount) return null;
    transactionTotal = transactionTotal.plus(amount);
  }
  const cfaPerUsd = currency !== "USD" && rateRaw ? parseMoneyInput(rateRaw) : null;
  const baseTotal =
    currency !== "USD" && cfaPerUsd && cfaPerUsd.gt(0) ? transactionTotal.div(cfaPerUsd) : transactionTotal;
  return { transactionTotal, baseTotal };
}

export async function postPaymentReceiptVoucherTx(tx: DbTransaction, input: PaymentReceiptInput) {
  const {
    companyId,
    voucherType,
    voucherDate,
    paymentAccountType,
    paymentAccountId,
    entries,
    notes,
    optional,
    currency: vCurrency,
    exchangeRate: vRateRaw,
    effectiveDate,
  } = input;
  const totals = paymentVoucherTotals(entries, vCurrency, vRateRaw);
  if (!totals) throw new PaymentReceiptInputError("Invalid amount");
  const { baseTotal } = totals;

  // Helper: build the voucher-entry account field set for a given
  // (accountType, accountId).  Handles three things in one place:
  //   1. Validates the referenced row belongs to the current company
  //      (security: prevents cross-company injection).
  //   2. For accountType === "customer", also stamps ledgerAccountId
  //      from the linked customer ledger so the row shows up in BOTH
  //      the Customers view and the linked-ledger view (Phase 4).
  //   3. For accountType === "ledger" where the ledger is linked to a
  //      customer, also stamps customerId for the same reason.
  // The OR clause in factoryCustomerLedger.buildFactoryCustomerLedgerEntries
  // makes this denormalization safe (no double-counting).
  const buildAccountField = async (accountType: string, accountId: number): Promise<Record<string, number>> => {
    const field: Record<string, number> = {};
    if (accountType === "ledger") {
      const [acct] = await tx
        .select({ id: ledgerAccounts.id, companyId: ledgerAccounts.companyId })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.id, accountId))
        .limit(1);
      if (!acct || acct.companyId !== companyId) {
        throw new Error(`Ledger account ${accountId} not found in current company.`);
      }
      field.ledgerAccountId = accountId;
      // Auto-fill customerId if this ledger is customer-linked
      const [linkedCust] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.ledgerAccountId, accountId), eq(customers.companyId, companyId)))
        .limit(1);
      if (linkedCust) field.customerId = linkedCust.id;
    } else if (accountType === "customer") {
      const [cust] = await tx
        .select({ id: customers.id, ledgerAccountId: customers.ledgerAccountId })
        .from(customers)
        .where(and(eq(customers.id, accountId), eq(customers.companyId, companyId)))
        .limit(1);
      if (!cust) {
        throw new Error(`Customer ${accountId} not found in current company.`);
      }
      field.customerId = accountId;
      if (cust.ledgerAccountId) field.ledgerAccountId = cust.ledgerAccountId;
    } else if (accountType === "bank") {
      field.bankAccountId = accountId;
    } else if (accountType === "supplier") {
      field.supplierId = accountId;
    } else if (accountType === "factorySupplier") {
      field.factorySupplierId = accountId;
    } else if (accountType === "employee") {
      field.employeeId = accountId;
    } else if (accountType === "fixedAsset") {
      field.fixedAssetId = accountId;
    }
    return field;
  };

  const voucherEntriesToCreate = [];

  // Pre-compute the payment-account field once (same for every entry)
  const paymentAccountField = await buildAccountField(paymentAccountType, paymentAccountId);

  // Create entries based on voucher type.
  // Each entry amount is the original transaction-currency (CFA) value as typed.
  // normalizeVoucherEntryAmounts() converts it to historical base (USD) for
  // debitAmount / creditAmount (backward-compat columns) and fills all new fields.
  for (const entry of entries) {
    const amount = String(entry.amount);
    const narration = notes || null;

    const entryAccountField = await buildAccountField(entry.accountType, entry.accountId);

    const isLiabilityPaymentAccount =
      paymentAccountType === "supplier" ||
      paymentAccountType === "factorySupplier" ||
      paymentAccountType === "employee";

    // Normalize the transaction amount once per entry (DR side and CR side).
    // normDR: this entry carries the debit leg; normCR: the credit leg.
    const normDR = normalizeVoucherEntryAmounts({
      transactionCurrency: vCurrency,
      baseCurrency: "USD",
      transactionDebitAmount: amount,
      transactionCreditAmount: "0",
      historicalRate: vRateRaw,
    });
    const normCR = normalizeVoucherEntryAmounts({
      transactionCurrency: vCurrency,
      baseCurrency: "USD",
      transactionDebitAmount: "0",
      transactionCreditAmount: amount,
      historicalRate: vRateRaw,
    });

    if (voucherType === "Payment") {
      if (isLiabilityPaymentAccount) {
        // Payment from liability account (supplier/employee):
        // DR payment account (reduce liability)
        // CR contra account
        voucherEntriesToCreate.push({
          ...paymentAccountField,
          debitAmount: normDR.debitAmount,
          creditAmount: normDR.creditAmount,
          transactionCurrency: normDR.transactionCurrency,
          transactionDebitAmount: normDR.transactionDebitAmount,
          transactionCreditAmount: normDR.transactionCreditAmount,
          baseDebitAmount: normDR.baseDebitAmount,
          baseCreditAmount: normDR.baseCreditAmount,
          historicalExchangeRate: normDR.historicalExchangeRate,
          rateConvention: normDR.rateConvention,
          narration,
        });
        voucherEntriesToCreate.push({
          ...entryAccountField,
          debitAmount: normCR.debitAmount,
          creditAmount: normCR.creditAmount,
          transactionCurrency: normCR.transactionCurrency,
          transactionDebitAmount: normCR.transactionDebitAmount,
          transactionCreditAmount: normCR.transactionCreditAmount,
          baseDebitAmount: normCR.baseDebitAmount,
          baseCreditAmount: normCR.baseCreditAmount,
          historicalExchangeRate: normCR.historicalExchangeRate,
          rateConvention: normCR.rateConvention,
          narration,
        });
      } else {
        // Payment from asset account (cash/bank/ledger):
        // DR contra account (expense/asset purchased)
        // CR payment account (cash goes out)
        voucherEntriesToCreate.push({
          ...entryAccountField,
          debitAmount: normDR.debitAmount,
          creditAmount: normDR.creditAmount,
          transactionCurrency: normDR.transactionCurrency,
          transactionDebitAmount: normDR.transactionDebitAmount,
          transactionCreditAmount: normDR.transactionCreditAmount,
          baseDebitAmount: normDR.baseDebitAmount,
          baseCreditAmount: normDR.baseCreditAmount,
          historicalExchangeRate: normDR.historicalExchangeRate,
          rateConvention: normDR.rateConvention,
          narration,
        });
        voucherEntriesToCreate.push({
          ...paymentAccountField,
          debitAmount: normCR.debitAmount,
          creditAmount: normCR.creditAmount,
          transactionCurrency: normCR.transactionCurrency,
          transactionDebitAmount: normCR.transactionDebitAmount,
          transactionCreditAmount: normCR.transactionCreditAmount,
          baseDebitAmount: normCR.baseDebitAmount,
          baseCreditAmount: normCR.baseCreditAmount,
          historicalExchangeRate: normCR.historicalExchangeRate,
          rateConvention: normCR.rateConvention,
          narration,
        });
      }
    } else {
      if (isLiabilityPaymentAccount) {
        // Receipt into liability account (supplier/employee):
        // DR contra account (source, e.g. loans)
        // CR payment account (increase liability)
        voucherEntriesToCreate.push({
          ...entryAccountField,
          debitAmount: normDR.debitAmount,
          creditAmount: normDR.creditAmount,
          transactionCurrency: normDR.transactionCurrency,
          transactionDebitAmount: normDR.transactionDebitAmount,
          transactionCreditAmount: normDR.transactionCreditAmount,
          baseDebitAmount: normDR.baseDebitAmount,
          baseCreditAmount: normDR.baseCreditAmount,
          historicalExchangeRate: normDR.historicalExchangeRate,
          rateConvention: normDR.rateConvention,
          narration,
        });
        voucherEntriesToCreate.push({
          ...paymentAccountField,
          debitAmount: normCR.debitAmount,
          creditAmount: normCR.creditAmount,
          transactionCurrency: normCR.transactionCurrency,
          transactionDebitAmount: normCR.transactionDebitAmount,
          transactionCreditAmount: normCR.transactionCreditAmount,
          baseDebitAmount: normCR.baseDebitAmount,
          baseCreditAmount: normCR.baseCreditAmount,
          historicalExchangeRate: normCR.historicalExchangeRate,
          rateConvention: normCR.rateConvention,
          narration,
        });
      } else {
        // Receipt into asset account (cash/bank/ledger):
        // DR payment account (cash comes in)
        // CR contra account (income/liability)
        voucherEntriesToCreate.push({
          ...paymentAccountField,
          debitAmount: normDR.debitAmount,
          creditAmount: normDR.creditAmount,
          transactionCurrency: normDR.transactionCurrency,
          transactionDebitAmount: normDR.transactionDebitAmount,
          transactionCreditAmount: normDR.transactionCreditAmount,
          baseDebitAmount: normDR.baseDebitAmount,
          baseCreditAmount: normDR.baseCreditAmount,
          historicalExchangeRate: normDR.historicalExchangeRate,
          rateConvention: normDR.rateConvention,
          narration,
        });
        voucherEntriesToCreate.push({
          ...entryAccountField,
          debitAmount: normCR.debitAmount,
          creditAmount: normCR.creditAmount,
          transactionCurrency: normCR.transactionCurrency,
          transactionDebitAmount: normCR.transactionDebitAmount,
          transactionCreditAmount: normCR.transactionCreditAmount,
          baseDebitAmount: normCR.baseDebitAmount,
          baseCreditAmount: normCR.baseCreditAmount,
          historicalExchangeRate: normCR.historicalExchangeRate,
          rateConvention: normCR.rateConvention,
          narration,
        });
      }
    }
  }

  // Phase 22 (B): an active voucher posts through the central engine (number
  // allocated there); an optional one keeps a direct insert with an
  // allocated number (it is off the ledger and may be unbalanced).
  const posted = await postManualVoucherTx(tx, {
    companyId,
    voucherType,
    voucherDate,
    description: notes || null,
    currency: vCurrency,
    exchangeRate: vRateRaw ? String(vRateRaw) : null,
    effectiveDate: effectiveDate || null,
    optional: optional === true,
    optionalTotalAmount: baseTotal.toFixed(6),
    entries: voucherEntriesToCreate,
    source: { type: "payment-receipt-legacy", id: input.sourceId },
    actor: { userId: input.actor.userId, username: input.actor.username, reason: input.reason },
  });
  if (posted.replayed) return { voucher: posted.voucher, entries: posted.entries, replayed: true };
  const createdVoucher = posted.voucher;
  const createdEntries = posted.entries;

  // Wave 12: employee balances and the audit row are written in this transaction.
  if (!createdVoucher.optional) {
    await syncEmployeeBalancesFromEntries(createdEntries, companyId, false, tx);
  }
  await writeVoucherAuditTx(tx, {
    actor: {
      userId: input.actor.userId,
      username: input.actor.username,
      companyId,
    },
    action: "create",
    voucherId: createdVoucher.id,
    before: null,
    after: { voucher: createdVoucher, entries: createdEntries },
  });

  return { voucher: createdVoucher, entries: createdEntries, replayed: false };
}

/** Factory daybook row for a Payment/Receipt voucher of a company with factory settings. */
export async function writePaymentReceiptDaybookEntry(
  executor: Pick<DbTransaction, "select" | "insert">,
  companyId: number,
  voucher: typeof vouchers.$inferSelect
): Promise<void> {
  const cid = companyId;
  const [fSetting] = await executor.select().from(fSettings).where(eq(fSettings.companyId, cid));
  if (fSetting) {
    const vType = voucher.voucherType;
    const txType = vType === "Payment" ? "PAYMENT" : vType === "Receipt" ? "RECEIPT" : "JOURNAL";
    const daybookCurrency = voucher.currency || "USD";
    // vouchers.totalAmount now stores the historical base (USD) amount.
    // transactionTotal (CFA) = baseTotal * cfaPerUsd for non-USD vouchers.
    const daybookBaseTotal = toMoney(voucher.totalAmount);
    const daybookRate = voucher.exchangeRate ? toMoney(voucher.exchangeRate) : new MoneyDecimal(1);
    // Reconstruct the original CFA total: base × rate (TRANSACTION_PER_BASE).
    const daybookAmtCurrency =
      daybookCurrency !== "USD" && daybookRate.gt(0) ? daybookBaseTotal.times(daybookRate) : daybookBaseTotal;
    // factory_daybook_entries.fx_rate_to_usd expects USD-per-foreign-unit.
    // The ERP voucher stores CFA-per-USD (TRANSACTION_PER_BASE), so we invert.
    const daybookFxRateToUsd = erpRateToDaybookFxRateToUsd(daybookCurrency, "USD", voucher.exchangeRate);
    await executor.insert(fde).values({
      companyId: cid,
      txDate: voucher.voucherDate,
      txType,
      referenceId: voucher.id,
      referenceTable: "vouchers",
      description: voucher.description || `${vType} voucher #${voucher.voucherNumber}`,
      currencyCode: daybookCurrency,
      amountCurrency: daybookAmtCurrency.toFixed(),
      fxRateToUsd: daybookFxRateToUsd,
      amountUsd: daybookBaseTotal.toFixed(),
      createdBy: null,
      effectiveDate: voucher.effectiveDate || null,
    });
  }
}
