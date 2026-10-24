import { createHash } from "node:crypto";
import type Decimal from "decimal.js";
import { and, asc, eq } from "drizzle-orm";
import { companies, posShifts, retailInventoryOpenings, retailPosPayments, retailPosSales, voucherEntries } from "@shared/schema";
import type { RetailPaymentMethod } from "@shared/schema/retailPos";
import type { DbTransaction } from "../../db";
import { allocateCents, MoneyDecimal, toMoney, type MoneyInput } from "../../lib/money";
import { postBalancedVoucherTx } from "../accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../accounting/databasePostingDependencies";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { resolveRetailPaymentAccountTx, type RetailMoneyAccountSelection } from "./retailPaymentAccounts";

import {
  ensureRetailAccountingSettingsTx,
  type RetailAccountingSettingsResolved,
} from "./retailAccountingSettingsService";

// The Retail accounting settings (defaults, conflicts, save) live in
// retailAccountingSettingsService.ts; re-exported for existing importers.
export {
  ensureRetailAccountingSettingsTx,
  getRetailAccountingSettings,
  RetailAccountConflictError,
  saveRetailAccountingSettings,
  type RetailAccountConflict,
  type RetailAccountingSettingsPatch,
  type RetailAccountingSettingsResolved,
} from "./retailAccountingSettingsService";

const postingDependencies = createDatabasePostingDependencies();
const EPSILON = new MoneyDecimal("0.000001");

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
function exactMoney(value: MoneyInput, label: string): Decimal {
  let parsed: Decimal;
  try {
    parsed = new MoneyDecimal(value ?? 0);
  } catch {
    throw new Error(`${label} is not a valid amount`);
  }
  if (!parsed.isFinite()) throw new Error(`${label} is not a valid amount`);
  return parsed;
}

function money(value: Decimal.Value): string {
  return new MoneyDecimal(value).toDecimalPlaces(6).toFixed(6);
}

function accountingMoney(value: Decimal.Value): Decimal {
  return new MoneyDecimal(value).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
}

/** The tax included in an amount, in cents: never negative and never more than the amount. */
function includedTax(total: Decimal, tax: MoneyInput | undefined, label: string): Decimal {
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
function allocatePaymentLines<T extends { amount: Decimal }>(
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

async function companyCurrency(tx: DbTransaction, companyId: number): Promise<string> {
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

function normalizePayments(total: Decimal, requested?: RetailPaymentInput[]): NormalizedPayment[] {
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
    normalized.push({ method: payment.method, amount, tenderedAmount: tendered, reference: payment.reference,
      ledgerAccountId: payment.ledgerAccountId, bankAccountId: payment.bankAccountId });
  }
  if (sum.minus(total).abs().greaterThan(EPSILON)) {
    throw new Error(`Retail payments (${sum.toFixed(2)}) must equal sale total (${total.toFixed(2)})`);
  }
  return normalized;
}

/** A stored payment row as the service returns it (amounts exact). */
function resolvedPayment(row: typeof retailPosPayments.$inferSelect): RetailResolvedPayment {
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
function paymentTarget(
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

export async function settleRetailSaleTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    locationId: number;
    saleId: number;
    saleIdempotencyKey: string;
    totalAmount: Decimal.Value;
    /** Tax included in totalAmount; credited to tax payable instead of revenue. */
    taxAmount?: Decimal.Value;
    totalCost: Decimal.Value;
    userId: string;
    username?: string | null;
    shiftId?: number | null;
    customerId?: number | null;
    payments?: RetailPaymentInput[];
  }
): Promise<{ payments: RetailResolvedPayment[]; voucherId: number | null }> {
  const shift = await validateRetailShiftTx(tx, input);
  const settings = await ensureRetailAccountingSettingsTx(tx, input.companyId, input.locationId);
  const saleTotal = exactMoney(input.totalAmount, "Retail sale total");
  const totalCost = exactMoney(input.totalCost, "Retail sale cost");
  const requested = normalizePayments(saleTotal, input.payments);
  if (requested.some((payment) => payment.method === "credit") && !input.customerId) {
    throw new Error("A selected customer is required for Retail credit sales");
  }
  const resolved: RetailResolvedPayment[] = [];

  for (const [index, payment] of requested.entries()) {
    const explicitAccount = payment.ledgerAccountId != null || payment.bankAccountId != null;
    if (payment.method === "credit" && explicitAccount) {
      throw new Error("Customer credit must post to the selected customer's ledger");
    }
    const target = explicitAccount
      ? await resolveRetailPaymentAccountTx(tx, input.companyId, payment)
      : paymentTarget(settings, payment.method, shift?.cashAccountId ?? null);
    if (explicitAccount && payment.method !== (target as { method: string }).method) {
      throw new Error("Selected Retail account does not match the payment type");
    }
    const amount = payment.amount;
    const tendered = payment.tenderedAmount;
    const change =
      payment.method === "cash" && tendered ? MoneyDecimal.max(0, tendered.minus(amount)) : new MoneyDecimal(0);
    const key = deriveRetailIdempotencyKey(input.saleIdempotencyKey, `payment:${index}`);
    const [inserted] = await tx
      .insert(retailPosPayments)
      .values({
        companyId: input.companyId,
        saleId: input.saleId,
        locationId: input.locationId,
        shiftId: shift?.id ?? null,
        paymentType: "payment",
        method: payment.method,
        amount: money(amount),
        tenderedAmount: tendered ? money(tendered) : null,
        changeAmount: money(change),
        reference: payment.reference?.trim() || null,
        ledgerAccountId: target.ledgerAccountId,
        bankAccountId: target.bankAccountId,
        idempotencyKey: key,
        createdBy: input.userId,
      })
      .onConflictDoNothing()
      .returning();
    const row =
      inserted ??
      (
        await tx
          .select()
          .from(retailPosPayments)
          .where(and(eq(retailPosPayments.companyId, input.companyId), eq(retailPosPayments.idempotencyKey, key)))
          .limit(1)
      )[0];
    if (!row) throw new Error("Retail payment could not be persisted");
    resolved.push(resolvedPayment(row));
  }

  // Retail stock is tracked independently of its ledger valuation until the
  // owner deliberately applies a perpetual-inventory opening. Otherwise a
  // sale creates a negative "Retail Inventory Asset" with no opening/receipt
  // debit (and the customer's money is mistakenly perceived to be there).
  // Keep the item's cost snapshot for reports and future supplier settlement.
  const [inventoryOpening] = await tx
    .select({ companyId: retailInventoryOpenings.companyId })
    .from(retailInventoryOpenings)
    .where(eq(retailInventoryOpenings.companyId, input.companyId))
    .limit(1);
  if (saleTotal.isZero() && (!inventoryOpening || totalCost.isZero())) {
    return { payments: resolved, voucherId: null };
  }

  const saleAccountingAmount = accountingMoney(saleTotal);
  const costAccountingAmount = accountingMoney(inventoryOpening ? totalCost : 0);
  const taxAccountingAmount = includedTax(saleAccountingAmount, input.taxAmount, "Retail sale tax");
  const revenueAccountingAmount = saleAccountingAmount.minus(taxAccountingAmount);
  const entries = [
    ...allocatePaymentLines(resolved, saleAccountingAmount).map(({ payment, amount }) => ({
      ...(payment.method === "credit"
        ? { customerId: input.customerId! }
        : payment.bankAccountId
          ? { bankAccountId: payment.bankAccountId }
          : { ledgerAccountId: payment.ledgerAccountId }),
      debitAmount: amount.toFixed(2),
      creditAmount: "0",
      narration: `Retail sale #${input.saleId} · ${payment.method === "credit" ? "customer receivable" : payment.method}`,
    })),
    ...(revenueAccountingAmount.isZero()
      ? []
      : [
          {
            ledgerAccountId: settings.salesRevenueLedgerAccountId,
            debitAmount: "0",
            creditAmount: revenueAccountingAmount.toFixed(2),
            narration: `Retail sale #${input.saleId} · revenue`,
          },
        ]),
    ...(taxAccountingAmount.isZero()
      ? []
      : [
          {
            ledgerAccountId: settings.taxPayableLedgerAccountId,
            debitAmount: "0",
            creditAmount: taxAccountingAmount.toFixed(2),
            narration: `Retail sale #${input.saleId} · tax`,
          },
        ]),
    ...(costAccountingAmount.isZero()
      ? []
      : [
          {
            ledgerAccountId: settings.cogsLedgerAccountId,
            debitAmount: costAccountingAmount.toFixed(2),
            creditAmount: "0",
            narration: `Retail sale #${input.saleId} · COGS`,
          },
          {
            ledgerAccountId: settings.inventoryAssetLedgerAccountId,
            debitAmount: "0",
            creditAmount: costAccountingAmount.toFixed(2),
            narration: `Retail sale #${input.saleId} · inventory`,
          },
        ]),
  ];
  const debitTotal = saleAccountingAmount.plus(costAccountingAmount);
  const currency = await companyCurrency(tx, input.companyId);
  const sourceKey = `retail-pos-sale:${input.saleId}`;
  const posted = await postBalancedVoucherTx(
    tx,
    {
      voucher: {
        companyId: input.companyId,
        voucherNumber: `RETAIL-SALE-${input.saleId}`,
        voucherType: "Journal",
        // The company's business date (its timezone), not the UTC date.
        voucherDate: await companyBusinessDate(input.companyId, tx),
        totalAmount: debitTotal.toFixed(2),
        description: `Retail POS sale #${input.saleId}`,
        locationId: input.locationId,
        currency,
        sourceModule: "Retail",
      },
      entries,
      source: {
        sourceType: "retail-pos-sale",
        sourceId: String(input.saleId),
        idempotencyKey: sourceKey,
      },
      actor: { userId: input.userId, username: input.username ?? null, reason: "Retail POS sale settlement" },
    },
    postingDependencies
  );
  await tx
    .update(retailPosSales)
    .set({ accountingVoucherId: posted.voucher.id, shiftId: shift?.id ?? input.shiftId ?? null, updatedAt: new Date() })
    .where(and(eq(retailPosSales.id, input.saleId), eq(retailPosSales.companyId, input.companyId)));
  return { payments: resolved, voucherId: posted.voucher.id };
}

export async function refundRetailPaymentsTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    saleId: number;
    locationId: number;
    shiftId?: number | null;
    refundAmount: Decimal.Value;
    idempotencyKey: string;
    userId: string;
    /** Cash/card/bank refund, or credit the real customer ledger instead. */
    destination?: "original" | "customer_credit" | "account";
    refundAccount?: RetailMoneyAccountSelection;
  }
): Promise<RetailResolvedPayment[]> {
  let remaining = exactMoney(input.refundAmount, "Retail refund amount");
  if (remaining.lessThanOrEqualTo(0)) return [];
  const refundTarget = input.destination === "account"
    ? await resolveRetailPaymentAccountTx(tx, input.companyId, input.refundAccount ?? {})
    : null;
  if (input.destination !== "account" &&
      (input.refundAccount?.ledgerAccountId || input.refundAccount?.bankAccountId)) {
    throw new Error("Manual refund account requires account refund destination");
  }
  if (input.destination === "customer_credit") {
    const [sale] = await tx
      .select({ customerId: retailPosSales.customerId })
      .from(retailPosSales)
      .where(and(eq(retailPosSales.companyId, input.companyId), eq(retailPosSales.id, input.saleId)))
      .limit(1);
    if (!sale?.customerId) throw new Error("Select a customer before issuing customer-account credit");
  }
  let payments = await tx
    .select()
    .from(retailPosPayments)
    .where(
      and(
        eq(retailPosPayments.companyId, input.companyId),
        eq(retailPosPayments.saleId, input.saleId),
        eq(retailPosPayments.paymentType, "payment")
      )
    )
    .orderBy(asc(retailPosPayments.id));

  // Backward compatibility for Retail sales created before Wave 1 payments existed.
  // Materialize the historical sale total as one cash payment without rewriting the
  // sale or its stock history, so old receipts can still be returned/cancelled.
  if (!payments.length) {
    const [sale] = await tx
      .select({ totalAmount: retailPosSales.totalAmount })
      .from(retailPosSales)
      .where(and(eq(retailPosSales.companyId, input.companyId), eq(retailPosSales.id, input.saleId)))
      .limit(1);
    if (!sale) throw new Error("Retail sale not found");
    const legacyTotal = toMoney(sale.totalAmount);
    if (legacyTotal.lessThan(remaining)) {
      throw new Error("Original Retail sale does not have enough paid value to refund");
    }
    const settings = await ensureRetailAccountingSettingsTx(tx, input.companyId, input.locationId);
    const legacyKey = `retail-legacy-payment:${input.saleId}`;
    await tx
      .insert(retailPosPayments)
      .values({
        companyId: input.companyId,
        saleId: input.saleId,
        locationId: input.locationId,
        shiftId: null,
        paymentType: "payment",
        method: "cash",
        amount: money(legacyTotal),
        tenderedAmount: null,
        changeAmount: "0",
        reference: "Legacy Retail sale payment",
        ledgerAccountId: settings.cashLedgerAccountId,
        bankAccountId: null,
        idempotencyKey: legacyKey,
        createdBy: input.userId,
      })
      .onConflictDoNothing();
    payments = await tx
      .select()
      .from(retailPosPayments)
      .where(
        and(
          eq(retailPosPayments.companyId, input.companyId),
          eq(retailPosPayments.saleId, input.saleId),
          eq(retailPosPayments.paymentType, "payment")
        )
      )
      .orderBy(asc(retailPosPayments.id));
  }

  // Reverse unpaid receivables before returning any real cash/bank tender.
  // An item returned on a partly paid invoice must never pay out more cash
  // while an uncollected credit portion still exists on that sale.
  payments = [...payments].sort((a, b) => Number(b.method === "credit") - Number(a.method === "credit") || a.id - b.id);

  const refunds = await tx
    .select()
    .from(retailPosPayments)
    .where(
      and(
        eq(retailPosPayments.companyId, input.companyId),
        eq(retailPosPayments.saleId, input.saleId),
        eq(retailPosPayments.paymentType, "refund")
      )
    );
  const refundedByPayment = new Map<number, Decimal>();
  for (const row of refunds) {
    if (!row.relatedPaymentId) continue;
    refundedByPayment.set(
      row.relatedPaymentId,
      (refundedByPayment.get(row.relatedPaymentId) ?? new MoneyDecimal(0)).plus(toMoney(row.amount))
    );
  }

  const created: RetailResolvedPayment[] = [];
  for (const original of payments) {
    if (remaining.lessThanOrEqualTo(EPSILON)) break;
    const available = MoneyDecimal.max(0, toMoney(original.amount).minus(refundedByPayment.get(original.id) ?? 0));
    if (available.isZero()) continue;
    const amount = MoneyDecimal.min(available, remaining);
    const key = deriveRetailIdempotencyKey(input.idempotencyKey, `refund:${original.id}`);
    // Credit-original = cancellation of an unpaid receivable. For collected
    // tenders customer_credit records a fresh credit to the party, not a payout.
    const refundMethod =
      input.destination === "customer_credit" && original.method !== "credit"
        ? "store_credit"
        : input.destination === "account" && original.method !== "credit"
          ? refundTarget!.method
          : original.method;
    const [inserted] = await tx
      .insert(retailPosPayments)
      .values({
        companyId: input.companyId,
        saleId: input.saleId,
        locationId: input.locationId,
        // Only the validated current shift; a closed historical shift must not absorb later cash.
        shiftId: input.shiftId ?? null,
        paymentType: "refund",
        method: refundMethod,
        amount: money(amount),
        tenderedAmount: null,
        changeAmount: "0",
        reference:
          refundMethod === "store_credit"
            ? `Customer credit from payment #${original.id}`
            : `Refund for payment #${original.id}`,
        ledgerAccountId: refundMethod === "store_credit"
          ? null : original.method === "credit" ? null : refundTarget?.ledgerAccountId ?? original.ledgerAccountId,
        bankAccountId: refundMethod === "store_credit"
          ? null : original.method === "credit" ? null : refundTarget?.bankAccountId ?? original.bankAccountId,
        relatedPaymentId: original.id,
        idempotencyKey: key,
        createdBy: input.userId,
      })
      .onConflictDoNothing()
      .returning();
    const row =
      inserted ??
      (
        await tx
          .select()
          .from(retailPosPayments)
          .where(and(eq(retailPosPayments.companyId, input.companyId), eq(retailPosPayments.idempotencyKey, key)))
          .limit(1)
      )[0];
    if (!row) throw new Error("Retail refund payment could not be persisted");
    created.push(resolvedPayment(row));
    remaining = remaining.minus(amount);
  }
  if (remaining.greaterThan(EPSILON)) {
    throw new Error(`Refund exceeds the remaining paid amount by ${remaining.toFixed(2)}`);
  }
  return created;
}

/**
 * Find the *original* sale's posted inventory/COGS pair. Returns must reverse
 * what that sale actually journalled, not assume every historic sale did so.
 * Keep the original account IDs even if default settings changed later.
 */
async function originalSaleCostAccountsTx(tx: DbTransaction, voucherId: number, saleId: number) {
  const lines = await tx
    .select({
      ledgerAccountId: voucherEntries.ledgerAccountId,
      narration: voucherEntries.narration,
      debitAmount: voucherEntries.debitAmount,
      creditAmount: voucherEntries.creditAmount,
    })
    .from(voucherEntries)
    .where(eq(voucherEntries.voucherId, voucherId));
  const inventory = lines.find(
    (line) => line.narration === `Retail sale #${saleId} · inventory` &&
      line.ledgerAccountId != null && toMoney(line.creditAmount).isPositive()
  );
  const cogs = lines.find(
    (line) => line.narration === `Retail sale #${saleId} · COGS` &&
      line.ledgerAccountId != null && toMoney(line.debitAmount).isPositive()
  );
  if (!inventory?.ledgerAccountId || !cogs?.ledgerAccountId) return null;
  return { inventoryLedgerAccountId: inventory.ledgerAccountId, cogsLedgerAccountId: cogs.ledgerAccountId };
}

export async function postRetailRefundAccountingTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    locationId: number;
    saleId: number;
    sourceType: "retail-pos-return" | "retail-pos-cancel";
    sourceId: string;
    idempotencyKey: string;
    refundAmount: Decimal.Value;
    /** Tax included in refundAmount; debited to tax payable instead of revenue. */
    refundTaxAmount?: Decimal.Value;
    restoredCost: Decimal.Value;
    refunds: RetailResolvedPayment[];
    userId: string;
    username?: string | null;
  }
): Promise<{ voucherId: number | null; costReversed: boolean }> {
  const [originalSale] = await tx
    .select({
      accountingVoucherId: retailPosSales.accountingVoucherId,
      customerId: retailPosSales.customerId,
    })
    .from(retailPosSales)
    .where(and(eq(retailPosSales.companyId, input.companyId), eq(retailPosSales.id, input.saleId)))
    .limit(1);
  // Do not invent a reversal for pre-Wave-1 sales that never had an accounting
  // posting. Their synthetic legacy payment exists only to make the operational
  // refund safe; reconciliation continues to flag the missing historical journal.
  if (!originalSale?.accountingVoucherId) return { voucherId: null, costReversed: false };
  if (
    input.refunds.some((payment) => payment.method === "credit" || payment.method === "store_credit") &&
    !originalSale.customerId
  ) {
    throw new Error("Cannot reverse a credit sale without its original customer");
  }

  const refundTotal = exactMoney(input.refundAmount, "Retail refund amount");
  const restoredCost = exactMoney(input.restoredCost, "Retail restored cost");
  const originalCostAccounts = await originalSaleCostAccountsTx(
    tx, originalSale.accountingVoucherId, input.saleId
  );
  if (refundTotal.isZero() && (!originalCostAccounts || restoredCost.isZero())) {
    return { voucherId: null, costReversed: false };
  }
  const settings = await ensureRetailAccountingSettingsTx(tx, input.companyId, input.locationId);
  const refundAccountingAmount = accountingMoney(refundTotal);
  const restoredCostAccountingAmount = accountingMoney(originalCostAccounts ? restoredCost : 0);
  const refundTaxAccountingAmount = includedTax(refundAccountingAmount, input.refundTaxAmount, "Retail refund tax");
  const refundRevenueAccountingAmount = refundAccountingAmount.minus(refundTaxAccountingAmount);
  const entries = [
    ...(refundAccountingAmount.isZero()
      ? []
      : [
          ...(refundRevenueAccountingAmount.isZero()
            ? []
            : [
                {
                  ledgerAccountId: settings.salesRevenueLedgerAccountId,
                  debitAmount: refundRevenueAccountingAmount.toFixed(2),
                  creditAmount: "0",
                  narration: `Retail sale #${input.saleId} · refund revenue reversal`,
                },
              ]),
          ...(refundTaxAccountingAmount.isZero()
            ? []
            : [
                {
                  ledgerAccountId: settings.taxPayableLedgerAccountId,
                  debitAmount: refundTaxAccountingAmount.toFixed(2),
                  creditAmount: "0",
                  narration: `Retail sale #${input.saleId} · refund tax reversal`,
                },
              ]),
          ...allocatePaymentLines(input.refunds, refundAccountingAmount).map(({ payment, amount }) => ({
            ...(payment.method === "credit" || payment.method === "store_credit"
              ? { customerId: originalSale.customerId! }
              : payment.bankAccountId
                ? { bankAccountId: payment.bankAccountId }
                : { ledgerAccountId: payment.ledgerAccountId }),
            debitAmount: "0",
            creditAmount: amount.toFixed(2),
            narration: `Retail sale #${input.saleId} · ${payment.method === "credit" ? "receivable reversal" : payment.method === "store_credit" ? "customer account credit" : payment.method + " refund"}`,
          })),
        ]),
    ...(restoredCostAccountingAmount.isZero()
      ? []
      : [
          {
            ledgerAccountId: originalCostAccounts!.inventoryLedgerAccountId,
            debitAmount: restoredCostAccountingAmount.toFixed(2),
            creditAmount: "0",
            narration: `Retail sale #${input.saleId} · inventory restored`,
          },
          {
            ledgerAccountId: originalCostAccounts!.cogsLedgerAccountId,
            debitAmount: "0",
            creditAmount: restoredCostAccountingAmount.toFixed(2),
            narration: `Retail sale #${input.saleId} · COGS reversed`,
          },
        ]),
  ];
  const total = refundAccountingAmount.plus(restoredCostAccountingAmount);
  const currency = await companyCurrency(tx, input.companyId);
  const posted = await postBalancedVoucherTx(
    tx,
    {
      voucher: {
        companyId: input.companyId,
        voucherNumber: `RETAIL-${input.sourceType === "retail-pos-cancel" ? "CANCEL" : "RETURN"}-${input.sourceId}`,
        voucherType: "Journal",
        voucherDate: await companyBusinessDate(input.companyId, tx),
        totalAmount: total.toFixed(2),
        description:
          input.sourceType === "retail-pos-cancel"
            ? `Retail cancellation for sale #${input.saleId}`
            : `Retail return for sale #${input.saleId}`,
        locationId: input.locationId,
        currency,
        sourceModule: "Retail",
      },
      entries,
      source: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        idempotencyKey: input.idempotencyKey,
      },
      actor: { userId: input.userId, username: input.username ?? null, reason: "Retail POS refund/reversal" },
    },
    postingDependencies
  );
  return { voucherId: posted.voucher.id, costReversed: !restoredCostAccountingAmount.isZero() };
}
