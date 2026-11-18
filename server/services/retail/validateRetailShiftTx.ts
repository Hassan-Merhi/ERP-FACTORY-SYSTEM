// Extracted from ./retailFinancialService.ts to keep that module under the source-size cap.
import { createHash } from "node:crypto";
import type Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { companies, posShifts, retailPosPayments } from "@shared/schema";
import type { RetailPaymentMethod } from "@shared/schema/retailPos";
import type { DbTransaction } from "../../db";
import { allocateCents, MoneyDecimal, type MoneyInput, toMoney } from "../../lib/money";
import { createDatabasePostingDependencies } from "../accounting/databasePostingDependencies";
import type { RetailAccountingSettingsResolved } from "./retailAccountingSettingsService";

export const postingDependencies = createDatabasePostingDependencies();

export const EPSILON = new MoneyDecimal("0.000001");

/**
 * Money is exact end to end (wave 17 C): request amounts arrive as numbers or
 * strings and are read once into a Decimal; nothing here passes through a
 * binary float.
 */
export interface RetailPaymentInput {
  method: RetailPaymentMethod;
  amount: Decimal.Value;
  tenderedAmount?: Decimal.Value | null;
  reference?: string | null;
  ledgerAccountId?: number | null;
  bankAccountId?: number | null;
}

export interface RetailResolvedPayment {
  id: number;
  method: RetailPaymentMethod;
  amount: Decimal;
  tenderedAmount: Decimal | null;
  changeAmount: Decimal;
  reference: string | null;
  ledgerAccountId: number | null;
  bankAccountId: number | null;
  shiftId: number | null;
  paymentType: string;
}

/**
 * Per-row idempotency key that fits the 191-character column. A long base key is
 * hashed instead of truncated, so the suffix that tells rows apart always survives.
 */
export function deriveRetailIdempotencyKey(base: string, suffix: string): string {
  const key = `${base}:${suffix}`;
  if (key.length <= 191) return key;
  return `${createHash("sha256").update(base).digest("hex")}:${suffix}`;
}

/** An exact Decimal for a money input; a value that is not a finite number is refused. */
export function exactMoney(value: MoneyInput, label: string): Decimal {
  let parsed: Decimal;
  try {
    parsed = new MoneyDecimal(value ?? 0);
  } catch {
    throw new Error(`${label} is not a valid amount`);
  }
  if (!parsed.isFinite()) throw new Error(`${label} is not a valid amount`);
  return parsed;
}

export function money(value: Decimal.Value): string {
  return new MoneyDecimal(value).toDecimalPlaces(6).toFixed(6);
}

export function accountingMoney(value: Decimal.Value): Decimal {
  return new MoneyDecimal(value).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
}

/** The tax included in an amount, in cents: never negative and never more than the amount. */
export function includedTax(total: Decimal, tax: MoneyInput | undefined, label: string): Decimal {
  const taxAmount = accountingMoney(exactMoney(tax ?? 0, label));
  return MoneyDecimal.min(total, MoneyDecimal.max(0, taxAmount));
}

/**
 * Splits a voucher amount (cents) across payment lines in proportion to the
 * payments, by largest remainder (allocateCents): the shares add up to the
 * amount exactly and none is negative. The old split rounded each payment and
 * pushed the whole difference onto the last line, which could turn it
 * negative. A payment whose share rounds to zero gets no line.
 */
export function allocatePaymentLines<T extends { amount: Decimal }>(
  payments: T[],
  targetTotal: Decimal
): { payment: T; amount: Decimal }[] {
  if (!payments.length) return [];
  const shares = allocateCents(
    payments.map((payment) => payment.amount),
    accountingMoney(targetTotal)
  );
  return payments.map((payment, index) => ({ payment, amount: shares[index] })).filter((line) => line.amount.gt(0));
}

export async function companyCurrency(tx: DbTransaction, companyId: number): Promise<string> {
  const [company] = await tx
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return String(company?.baseCurrency || "USD")
    .slice(0, 3)
    .toUpperCase();
}

export async function validateRetailShiftTx(
  tx: DbTransaction,
  input: { companyId: number; locationId: number; userId: string; shiftId?: number | null }
): Promise<typeof posShifts.$inferSelect | null> {
  if (!input.shiftId) return null;
  const [shift] = await tx
    .select()
    .from(posShifts)
    .where(
      and(
        eq(posShifts.id, input.shiftId),
        eq(posShifts.companyId, input.companyId),
        eq(posShifts.locationId, input.locationId),
        eq(posShifts.status, "open")
      )
    )
    .limit(1)
    // Shared lock: closeShift takes FOR UPDATE, so a close waits for in-flight sales to commit.
    .for("share");
  if (!shift) throw new Error("Retail cashier shift is not open for this location");
  if (shift.userId !== input.userId) throw new Error("Retail cashier shift belongs to another user");
  return shift;
}

interface NormalizedPayment {
  method: RetailPaymentMethod;
  amount: Decimal;
  tenderedAmount: Decimal | null;
  reference?: string | null;
  ledgerAccountId?: number | null;
  bankAccountId?: number | null;
}

export function normalizePayments(total: Decimal, requested?: RetailPaymentInput[]): NormalizedPayment[] {
  if (total.isNegative()) throw new Error("Retail sale total cannot be negative");
  if (total.isZero()) return [];
  const payments: RetailPaymentInput[] = requested?.length ? requested : [{ method: "cash", amount: total }];
  let sum = new MoneyDecimal(0);
  const normalized: NormalizedPayment[] = [];
  for (const payment of payments) {
    if (!["cash", "card", "bank", "mobile", "other", "credit"].includes(payment.method)) {
      throw new Error(`Unsupported Retail payment method: ${payment.method}`);
    }
    const amount = exactMoney(payment.amount, "Retail payment amount");
    if (!amount.isPositive() || amount.isZero()) throw new Error("Every Retail payment amount must be positive");
    let tendered: Decimal | null = null;
    if (payment.tenderedAmount != null) {
      tendered = exactMoney(payment.tenderedAmount, "Cash tendered");
      if (payment.method === "cash" && tendered.lessThan(amount)) {
        throw new Error("Cash tendered cannot be less than the cash payment amount");
      }
    }
    sum = sum.plus(amount);
    normalized.push({
      method: payment.method,
      amount,
      tenderedAmount: tendered,
      reference: payment.reference,
      ledgerAccountId: payment.ledgerAccountId,
      bankAccountId: payment.bankAccountId,
    });
  }
  if (sum.minus(total).abs().greaterThan(EPSILON)) {
    throw new Error(`Retail payments (${sum.toFixed(2)}) must equal sale total (${total.toFixed(2)})`);
  }
  return normalized;
}

/** A stored payment row as the service returns it (amounts exact). */
export function resolvedPayment(row: typeof retailPosPayments.$inferSelect): RetailResolvedPayment {
  return {
    id: row.id,
    method: row.method as RetailPaymentMethod,
    amount: toMoney(row.amount),
    tenderedAmount: row.tenderedAmount == null ? null : toMoney(row.tenderedAmount),
    changeAmount: toMoney(row.changeAmount),
    reference: row.reference ?? null,
    ledgerAccountId: row.ledgerAccountId ?? null,
    bankAccountId: row.bankAccountId ?? null,
    shiftId: row.shiftId ?? null,
    paymentType: row.paymentType,
  };
}

/**
 * A payment line's target. A bank payment posts to the bank account alone
 * (bank_account_id, no ledger account), as the other bank postings do (POS
 * sales, central payments): the balance engine attributes a line to its
 * ledger account first, then its bank (partyLineRules.ts), so a bank-only
 * line is the bank's row in the trial balance; adding the clearing ledger to
 * it would move the line off the bank.
 */
export function paymentTarget(
  settings: RetailAccountingSettingsResolved,
  method: RetailPaymentMethod,
  shiftCashAccountId?: number | null
): { ledgerAccountId: number | null; bankAccountId: number | null } {
  // Credit is not cash received: it is attributed directly to the selected
  // customer in the canonical ERP balance engine, never to a clearing account.
  if (method === "credit") return { ledgerAccountId: null, bankAccountId: null };
  if (method === "cash") {
    return { ledgerAccountId: shiftCashAccountId ?? settings.cashLedgerAccountId, bankAccountId: null };
  }
  if (method === "card") return { ledgerAccountId: settings.cardLedgerAccountId, bankAccountId: null };
  if (method === "bank") {
    return settings.bankAccountId
      ? { ledgerAccountId: null, bankAccountId: settings.bankAccountId }
      : { ledgerAccountId: settings.bankLedgerAccountId, bankAccountId: null };
  }
  if (method === "mobile") return { ledgerAccountId: settings.mobileLedgerAccountId, bankAccountId: null };
  return { ledgerAccountId: settings.otherLedgerAccountId, bankAccountId: null };
}
