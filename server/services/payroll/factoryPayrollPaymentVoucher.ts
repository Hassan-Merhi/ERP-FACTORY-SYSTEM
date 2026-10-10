/**
 * Wave 7 (owner decision 3): the payment voucher of a factory payroll marked
 * PAID through PATCH /api/factory/payroll/:id.
 *
 *   Dr Payroll Payable          net salary
 *   Cr the paying cash/bank     net salary
 *
 * The accrual (PAYROLL-GEN-*, Dr salary/bonus expense / Cr Payroll Payable)
 * is posted when the payroll is generated; this voucher clears the payable.
 *
 * Identity: voucher number `PAYMENT-PAY-{payrollId}-PAID` (the shape every
 * PAYMENT-PAY reader already matches) and the posting request
 * `infra:factory-payroll-payment:{company}:{payroll}:payment`, so a retry in
 * the same state replays the same voucher instead of posting a second one.
 * Un-marking the payment removes it (and any other PAYMENT-PAY-{id}-* voucher)
 * in the caller's transaction; the closed-period trigger refuses that in a
 * closed period.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type Decimal from "decimal.js";

import { ledgerAccounts, vouchers, voucherEntries } from "@shared/schema";
import type { DatabaseOrTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../accounting/infrastructureVoucherIdentity";
import { retireVouchersTx } from "../accounting/voucherRetirement";
import { normalizeVoucherEntryAmounts } from "../accounting/currencyAmounts";

export const FACTORY_PAYROLL_PAYMENT_ACCOUNT_REQUIRED =
  "Choose the cash or bank account that pays this payroll before marking it paid";

export function factoryPayrollPaymentVoucherNumber(payrollId: number): string {
  return `PAYMENT-PAY-${payrollId}-PAID`;
}

function usdLine(debit: string, credit: string) {
  const norm = normalizeVoucherEntryAmounts({
    transactionCurrency: "USD",
    baseCurrency: "USD",
    transactionDebitAmount: debit,
    transactionCreditAmount: credit,
    historicalRate: "1",
  });
  return {
    transactionCurrency: norm.transactionCurrency,
    transactionDebitAmount: norm.transactionDebitAmount,
    transactionCreditAmount: norm.transactionCreditAmount,
    baseDebitAmount: norm.baseDebitAmount,
    baseCreditAmount: norm.baseCreditAmount,
    historicalExchangeRate: norm.historicalExchangeRate,
    rateConvention: norm.rateConvention,
    debitAmount: norm.debitAmount,
    creditAmount: norm.creditAmount,
  };
}

/**
 * The paying account must be a live ledger account of the payroll's company and
 * not the payable it clears. Returns its id.
 */
export async function resolveFactoryPayrollPaymentAccountTx(
  tx: DatabaseOrTransaction,
  companyId: number,
  rawAccountId: unknown,
  payableAccountId: number
): Promise<number> {
  const accountId = Number(rawAccountId);
  if (rawAccountId === undefined || rawAccountId === null || rawAccountId === "" || !Number.isInteger(accountId)) {
    throw new HttpError(400, FACTORY_PAYROLL_PAYMENT_ACCOUNT_REQUIRED);
  }
  const [account] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt))
    )
    .limit(1);
  if (!account) throw new HttpError(400, "The paying account does not belong to this company");
  if (account.id === payableAccountId) {
    throw new HttpError(400, "The paying account cannot be the Payroll Payable account");
  }
  return account.id;
}

export async function postFactoryPayrollPaymentVoucherTx(
  tx: DatabaseOrTransaction,
  input: {
    companyId: number;
    payrollId: number;
    workerName: string;
    periodStart: string;
    periodEnd: string;
    netSalary: Decimal;
    payableAccountId: number;
    cashAccountId: number;
    paymentDate: string;
  }
): Promise<{ voucherId: number | null }> {
  const amount = input.netSalary.toFixed(2);
  if (!input.netSalary.greaterThan(0)) return { voucherId: null };
  const narration = `Payroll payment: ${input.workerName} (${input.periodStart} – ${input.periodEnd})`;
  const voucherFields = {
    companyId: input.companyId,
    voucherNumber: factoryPayrollPaymentVoucherNumber(input.payrollId),
    voucherType: "Payment",
    voucherDate: input.paymentDate,
    description: narration,
    totalAmount: amount,
    currency: "USD",
    sourceModule: "FACTORY",
  };
  const { voucher } = await insertInfrastructureVoucherTx(
    tx,
    voucherFields,
    infrastructurePostingIdentity("factory-payroll-payment", `${input.companyId}:${input.payrollId}`, "payment"),
    { payableAccountId: input.payableAccountId, cashAccountId: input.cashAccountId }
  );
  await tx.insert(voucherEntries).values([
    { voucherId: voucher.id, ledgerAccountId: input.payableAccountId, ...usdLine(amount, "0"), narration },
    { voucherId: voucher.id, ledgerAccountId: input.cashAccountId, ...usdLine("0", amount), narration },
  ]);
  return { voucherId: voucher.id };
}

/** Retires every payment voucher of the payroll (PAYMENT-PAY-{id}-*): soft delete with its lines, audited. */
export async function removeFactoryPayrollPaymentVouchersTx(
  tx: DatabaseOrTransaction,
  companyId: number,
  payrollId: number
): Promise<number[]> {
  const rows = await tx
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(
      and(eq(vouchers.companyId, companyId), sql`${vouchers.voucherNumber} LIKE ${"PAYMENT-PAY-" + payrollId + "-%"}`)
    );
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return ids;
  // Wave 16 (A): retired (soft delete with lines, audited, number and identity released).
  const retired = await retireVouchersTx(tx, { companyId, voucherIds: ids, reason: "factory-payroll-payment-removed" });
  return retired.map((voucher) => voucher.id);
}
