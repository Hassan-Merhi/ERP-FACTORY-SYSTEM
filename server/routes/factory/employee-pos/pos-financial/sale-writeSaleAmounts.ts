// Extracted from ./sale-write.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { db } from "../../../../db";
import { MoneyDecimal, parseMoneyInput, sumMoney, toMoney } from "../../../../lib/money";
import {
  allLedgerAccountsOwned,
  isCompanyCustomerOrAbsent,
  isFactorySessionLocation,
} from "../../../helpers/companyOwnership";
import {
  type FactoryPosSaleAmounts,
  factoryPosSaleRate,
  factoryPosSaleRefusal,
  FactoryPosSaleRefusalError,
} from "../../../../services/accounting/factoryPosReceipt";

/** A request amount at cents, read as parseFloat reads it; blank is zero, anything else unparsable is null. */
function requestCents(value: unknown) {
  if (value === undefined || value === null || value === "") return new MoneyDecimal(0);
  return parseMoneyInput(value)?.toDecimalPlaces(2) ?? null;
}

/**
 * A POS sale's amounts at cents. Unit prices, the deposit and each expense are
 * rounded first and everything else is derived from them, so the stored lines
 * add up to the sale total and the receipt voucher's legs balance. Null when
 * an amount does not parse (it used to be written as NaN).
 */
export function saleAmounts(body: {
  paymentType?: string;
  depositAmount?: unknown;
  items: Array<{ unitPrice?: unknown; quantity?: unknown }>;
  expenses?: unknown;
}) {
  const isCredit = (body.paymentType || "CASH") === "CREDIT";
  const deposit = isCredit ? requestCents(body.depositAmount) : new MoneyDecimal(0);
  if (!deposit) return null;
  const lines = [];
  for (const item of body.items) {
    const price = requestCents(item.unitPrice);
    if (!price) return null;
    lines.push({ qty: parseInt(String(item.quantity || "1")), price });
  }
  const expenseRows: Array<{ accountId: number; description: string; amount: number }> = [];
  if (Array.isArray(body.expenses)) {
    for (const exp of body.expenses) {
      const amt = requestCents(exp.amount);
      if (!amt) return null;
      if (amt.gt(0) && exp.accountId) {
        expenseRows.push({
          accountId: parseInt(exp.accountId),
          description: exp.description || "",
          amount: amt.toNumber(),
        });
      }
    }
  }
  const depositAmt = MoneyDecimal.max(0, deposit);
  const totalAmount = sumMoney(lines.map((line) => line.price.times(line.qty)));
  // What the ledger voucher posts (services/accounting/factoryPosReceipt.ts).
  const posting: FactoryPosSaleAmounts = {
    isCredit,
    total: totalAmount,
    deposit: depositAmt,
    deductions: expenseRows.map((row) => ({ ...row, amount: toMoney(row.amount) })),
  };
  return {
    isCredit,
    depositAmt: depositAmt.toNumber(),
    lines,
    totalAmount: totalAmount.toNumber(),
    expenseRows,
    posting,
  };
}

/** A native amount in USD at the sale's factory rate, at cents (the daybook's amount_usd). */
export function usdAtRate(amount: number, rate: string): string {
  return toMoney(amount).times(toMoney(rate)).toFixed(2);
}

/**
 * Wave 8.4 continuation: a sale the ledger cannot carry is refused before any
 * write — a customer of another company, a cash leg with no cash account, an
 * unpaid credit sale with no customer, a non-USD sale with no confirmed rate
 * on or before its date (409). Returns the sale's rate, or sends the refusal.
 */
export async function saleRateOrRefuse(
  res: Response,
  companyId: number,
  sale: {
    customerId: number | null;
    cashAccountId: unknown;
    currencyCode: unknown;
    saleDate: string;
    posting: FactoryPosSaleAmounts;
  }
): Promise<string | null> {
  if (!(await isCompanyCustomerOrAbsent(companyId, sale.customerId))) {
    res.status(400).json({ message: "Customer not found" });
    return null;
  }
  const refusal = factoryPosSaleRefusal(sale.posting, {
    cashAccountId: sale.cashAccountId ? Number(sale.cashAccountId) : null,
    customerId: sale.customerId,
  });
  if (refusal) {
    res.status(refusal.statusCode).json(refusal.body);
    return null;
  }
  try {
    return await factoryPosSaleRate(db, companyId, String(sale.currencyCode || "USD"), sale.saleDate);
  } catch (error: unknown) {
    if (!(error instanceof FactoryPosSaleRefusalError)) throw error;
    res.status(error.statusCode).json(error.body);
    return null;
  }
}

/** The route's error response: a posting refusal keeps its status and code. */
export function sendSaleError(res: Response, error: unknown) {
  if (error instanceof FactoryPosSaleRefusalError) return res.status(error.statusCode).json(error.body);
  return res.status(400).json({ message: getErrorMessage(error) });
}

export function postingInput(
  companyId: number,
  sale: { id: number; saleNumber: string; txDate: string | Date },
  body: { customerName?: string | null; currencyCode?: unknown; cashAccountId?: unknown },
  customerId: number | null,
  rate: string,
  posting: FactoryPosSaleAmounts
) {
  return {
    ...posting,
    companyId,
    saleId: sale.id,
    saleNumber: sale.saleNumber,
    voucherDate: String(sale.txDate),
    currency: String(body.currencyCode || "USD"),
    rate,
    customerName: body.customerName ?? null,
    customerId,
    cashAccountId: body.cashAccountId ? Number(body.cashAccountId) : null,
  };
}

/**
 * The sale's location, cash account and expense accounts are body ids the
 * path-based company scope never sees: each must be the user's own.
 */
export async function refusedSaleBodyId(
  session: Request["session"],
  companyId: number,
  locationId: unknown,
  cashAccountId: unknown,
  expenseRows: readonly { accountId: number }[]
): Promise<string | null> {
  if (locationId && !(await isFactorySessionLocation(session, locationId))) return "Location not found";
  const accountIds = [cashAccountId, ...expenseRows.map((row) => row.accountId)];
  if (!(await allLedgerAccountsOwned(companyId, accountIds))) return "Account not found";
  return null;
}
