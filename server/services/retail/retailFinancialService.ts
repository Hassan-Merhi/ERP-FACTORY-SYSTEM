import Decimal from "decimal.js";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  bankAccounts,
  ledgerAccounts,
  posShifts,
  retailAccountingSettings,
  retailCashMovements,
  retailPosPayments,
  retailPosSales,
} from "@shared/schema";
import type { RetailPaymentMethod } from "@shared/schema/retailPos";
import type { DbTransaction } from "../../db";
import { db } from "../../db";
import { postBalancedVoucherTx } from "../accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../accounting/databasePostingDependencies";

const postingDependencies = createDatabasePostingDependencies();
const EPSILON = new Decimal("0.000001");

export interface RetailPaymentInput {
  method: RetailPaymentMethod;
  amount: number;
  tenderedAmount?: number | null;
  reference?: string | null;
}

export interface RetailResolvedPayment {
  id: number;
  method: RetailPaymentMethod;
  amount: number;
  tenderedAmount: number | null;
  changeAmount: number;
  reference: string | null;
  ledgerAccountId: number | null;
  bankAccountId: number | null;
  shiftId: number | null;
  paymentType: string;
}

export interface RetailAccountingSettingsResolved {
  id: number;
  companyId: number;
  locationId: number | null;
  cashLedgerAccountId: number;
  cardLedgerAccountId: number;
  bankLedgerAccountId: number;
  bankAccountId: number | null;
  mobileLedgerAccountId: number;
  otherLedgerAccountId: number;
  salesRevenueLedgerAccountId: number;
  inventoryAssetLedgerAccountId: number;
  cogsLedgerAccountId: number;
  discountsLedgerAccountId: number;
  taxPayableLedgerAccountId: number;
  storeCreditLedgerAccountId: number;
}

function money(value: Decimal.Value): string {
  return new Decimal(value).toDecimalPlaces(6).toFixed(6);
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function ensureLedgerAccount(
  tx: DbTransaction,
  companyId: number,
  code: string,
  name: string,
  accountType: string,
  subType?: string
): Promise<number> {
  await tx
    .insert(ledgerAccounts)
    .values({
      companyId,
      code,
      name,
      accountType,
      subType: subType ?? null,
      active: true,
    })
    .onConflictDoNothing();
  const [account] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, code), isNull(ledgerAccounts.deletedAt)))
    .limit(1);
  if (!account) throw new Error(`Could not resolve Retail accounting account ${code}`);
  return account.id;
}

async function defaultRetailAccountIds(tx: DbTransaction, companyId: number) {
  const [
    cashLedgerAccountId,
    cardLedgerAccountId,
    bankLedgerAccountId,
    mobileLedgerAccountId,
    otherLedgerAccountId,
    salesRevenueLedgerAccountId,
    inventoryAssetLedgerAccountId,
    cogsLedgerAccountId,
    discountsLedgerAccountId,
    taxPayableLedgerAccountId,
    storeCreditLedgerAccountId,
  ] = await Promise.all([
    ensureLedgerAccount(tx, companyId, "RETAIL-CASH", "Retail Cash", "Cash"),
    ensureLedgerAccount(tx, companyId, "RETAIL-CARD", "Retail Card Clearing", "Asset"),
    ensureLedgerAccount(tx, companyId, "RETAIL-BANK", "Retail Bank Clearing", "Asset"),
    ensureLedgerAccount(tx, companyId, "RETAIL-MOBILE", "Retail Mobile Clearing", "Asset"),
    ensureLedgerAccount(tx, companyId, "RETAIL-OTHER", "Retail Other Clearing", "Asset"),
    ensureLedgerAccount(tx, companyId, "RETAIL-SALES", "Retail Sales Revenue", "Income", "Direct Income"),
    ensureLedgerAccount(tx, companyId, "RETAIL-INVENTORY", "Retail Inventory Asset", "Asset"),
    ensureLedgerAccount(tx, companyId, "RETAIL-COGS", "Retail Cost of Goods Sold", "Direct Expense"),
    ensureLedgerAccount(tx, companyId, "RETAIL-DISCOUNTS", "Retail Discounts", "Expense"),
    ensureLedgerAccount(tx, companyId, "RETAIL-TAX", "Retail Tax Payable", "Liability"),
    ensureLedgerAccount(tx, companyId, "RETAIL-STORE-CREDIT", "Retail Store Credit", "Liability"),
  ]);
  return {
    cashLedgerAccountId,
    cardLedgerAccountId,
    bankLedgerAccountId,
    mobileLedgerAccountId,
    otherLedgerAccountId,
    salesRevenueLedgerAccountId,
    inventoryAssetLedgerAccountId,
    cogsLedgerAccountId,
    discountsLedgerAccountId,
    taxPayableLedgerAccountId,
    storeCreditLedgerAccountId,
  };
}

export async function ensureRetailAccountingSettingsTx(
  tx: DbTransaction,
  companyId: number,
  locationId?: number | null
): Promise<RetailAccountingSettingsResolved> {
  const generated = await defaultRetailAccountIds(tx, companyId);
  let [defaultRow] = await tx
    .select()
    .from(retailAccountingSettings)
    .where(and(eq(retailAccountingSettings.companyId, companyId), isNull(retailAccountingSettings.locationId)))
    .limit(1);

  if (!defaultRow) {
    [defaultRow] = await tx
      .insert(retailAccountingSettings)
      .values({ companyId, locationId: null, ...generated })
      .onConflictDoNothing()
      .returning();
    if (!defaultRow) {
      [defaultRow] = await tx
        .select()
        .from(retailAccountingSettings)
        .where(and(eq(retailAccountingSettings.companyId, companyId), isNull(retailAccountingSettings.locationId)))
        .limit(1);
    }
  }
  if (!defaultRow) throw new Error("Retail accounting settings could not be created");

  let current = defaultRow;
  if (locationId) {
    const [specific] = await tx
      .select()
      .from(retailAccountingSettings)
      .where(and(eq(retailAccountingSettings.companyId, companyId), eq(retailAccountingSettings.locationId, locationId)))
      .limit(1);
    if (specific) {
      current = specific;
    } else {
      const [createdSpecific] = await tx
        .insert(retailAccountingSettings)
        .values({
          companyId,
          locationId,
          cashLedgerAccountId: defaultRow.cashLedgerAccountId,
          cardLedgerAccountId: defaultRow.cardLedgerAccountId,
          bankLedgerAccountId: defaultRow.bankLedgerAccountId,
          bankAccountId: defaultRow.bankAccountId,
          mobileLedgerAccountId: defaultRow.mobileLedgerAccountId,
          otherLedgerAccountId: defaultRow.otherLedgerAccountId,
          salesRevenueLedgerAccountId: defaultRow.salesRevenueLedgerAccountId,
          inventoryAssetLedgerAccountId: defaultRow.inventoryAssetLedgerAccountId,
          cogsLedgerAccountId: defaultRow.cogsLedgerAccountId,
          discountsLedgerAccountId: defaultRow.discountsLedgerAccountId,
          taxPayableLedgerAccountId: defaultRow.taxPayableLedgerAccountId,
          storeCreditLedgerAccountId: defaultRow.storeCreditLedgerAccountId,
        })
        .onConflictDoNothing()
        .returning();
      current =
        createdSpecific ??
        (
          await tx
            .select()
            .from(retailAccountingSettings)
            .where(
              and(
                eq(retailAccountingSettings.companyId, companyId),
                eq(retailAccountingSettings.locationId, locationId)
              )
            )
            .limit(1)
        )[0];
    }
  }
  if (!current) throw new Error("Retail accounting settings could not be resolved");

  const patch = {
    cashLedgerAccountId: current.cashLedgerAccountId ?? generated.cashLedgerAccountId,
    cardLedgerAccountId: current.cardLedgerAccountId ?? generated.cardLedgerAccountId,
    bankLedgerAccountId: current.bankLedgerAccountId ?? generated.bankLedgerAccountId,
    mobileLedgerAccountId: current.mobileLedgerAccountId ?? generated.mobileLedgerAccountId,
    otherLedgerAccountId: current.otherLedgerAccountId ?? generated.otherLedgerAccountId,
    salesRevenueLedgerAccountId: current.salesRevenueLedgerAccountId ?? generated.salesRevenueLedgerAccountId,
    inventoryAssetLedgerAccountId: current.inventoryAssetLedgerAccountId ?? generated.inventoryAssetLedgerAccountId,
    cogsLedgerAccountId: current.cogsLedgerAccountId ?? generated.cogsLedgerAccountId,
    discountsLedgerAccountId: current.discountsLedgerAccountId ?? generated.discountsLedgerAccountId,
    taxPayableLedgerAccountId: current.taxPayableLedgerAccountId ?? generated.taxPayableLedgerAccountId,
    storeCreditLedgerAccountId: current.storeCreditLedgerAccountId ?? generated.storeCreditLedgerAccountId,
  };
  if (Object.entries(patch).some(([key, value]) => (current as Record<string, unknown>)[key] == null && value != null)) {
    [current] = await tx
      .update(retailAccountingSettings)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(retailAccountingSettings.id, current.id))
      .returning();
  }

  return {
    id: current.id,
    companyId,
    locationId: current.locationId ?? null,
    ...patch,
    bankAccountId: current.bankAccountId ?? null,
  };
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
    .limit(1);
  if (!shift) throw new Error("Retail cashier shift is not open for this location");
  if (shift.userId !== input.userId) throw new Error("Retail cashier shift belongs to another user");
  return shift;
}

function normalizePayments(totalAmount: number, requested?: RetailPaymentInput[]): RetailPaymentInput[] {
  const total = new Decimal(totalAmount);
  if (total.isNegative()) throw new Error("Retail sale total cannot be negative");
  if (total.isZero()) return [];
  const payments = requested?.length ? requested : [{ method: "cash" as const, amount: total.toNumber() }];
  let sum = new Decimal(0);
  for (const payment of payments) {
    if (!["cash", "card", "bank", "mobile", "other"].includes(payment.method)) {
      throw new Error(`Unsupported Retail payment method: ${payment.method}`);
    }
    const amount = new Decimal(payment.amount);
    if (!amount.isFinite() || !amount.isPositive()) throw new Error("Every Retail payment amount must be positive");
    if (payment.method === "cash" && payment.tenderedAmount != null) {
      const tendered = new Decimal(payment.tenderedAmount);
      if (!tendered.isFinite() || tendered.lessThan(amount)) {
        throw new Error("Cash tendered cannot be less than the cash payment amount");
      }
    }
    sum = sum.plus(amount);
  }
  if (sum.minus(total).abs().greaterThan(EPSILON)) {
    throw new Error(`Retail payments (${sum.toFixed(2)}) must equal sale total (${total.toFixed(2)})`);
  }
  return payments;
}

function paymentTarget(
  settings: RetailAccountingSettingsResolved,
  method: RetailPaymentMethod,
  shiftCashAccountId?: number | null
): { ledgerAccountId: number | null; bankAccountId: number | null } {
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
    totalAmount: number;
    totalCost: number;
    userId: string;
    username?: string | null;
    shiftId?: number | null;
    payments?: RetailPaymentInput[];
  }
): Promise<{ payments: RetailResolvedPayment[]; voucherId: number | null }> {
  const shift = await validateRetailShiftTx(tx, input);
  const settings = await ensureRetailAccountingSettingsTx(tx, input.companyId, input.locationId);
  const requested = normalizePayments(input.totalAmount, input.payments);
  const resolved: RetailResolvedPayment[] = [];

  for (const [index, payment] of requested.entries()) {
    const target = paymentTarget(settings, payment.method, shift?.cashAccountId ?? null);
    const amount = new Decimal(payment.amount);
    const tendered = payment.tenderedAmount == null ? null : new Decimal(payment.tenderedAmount);
    const change = payment.method === "cash" && tendered ? Decimal.max(0, tendered.minus(amount)) : new Decimal(0);
    const key = `${input.saleIdempotencyKey}:payment:${index}`.slice(0, 191);
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
          .where(
            and(
              eq(retailPosPayments.companyId, input.companyId),
              eq(retailPosPayments.idempotencyKey, key)
            )
          )
          .limit(1)
      )[0];
    if (!row) throw new Error("Retail payment could not be persisted");
    resolved.push({
      id: row.id,
      method: row.method as RetailPaymentMethod,
      amount: toNumber(row.amount),
      tenderedAmount: row.tenderedAmount == null ? null : toNumber(row.tenderedAmount),
      changeAmount: toNumber(row.changeAmount),
      reference: row.reference ?? null,
      ledgerAccountId: row.ledgerAccountId ?? null,
      bankAccountId: row.bankAccountId ?? null,
      shiftId: row.shiftId ?? null,
      paymentType: row.paymentType,
    });
  }

  const saleTotal = new Decimal(input.totalAmount);
  const totalCost = new Decimal(input.totalCost);
  if (saleTotal.isZero() && totalCost.isZero()) return { payments: resolved, voucherId: null };

  const entries = [
    ...resolved.map((payment) => ({
      ...(payment.bankAccountId ? { bankAccountId: payment.bankAccountId } : { ledgerAccountId: payment.ledgerAccountId }),
      debitAmount: money(payment.amount),
      creditAmount: "0",
      narration: `Retail sale #${input.saleId} · ${payment.method}`,
    })),
    ...(saleTotal.isZero()
      ? []
      : [
          {
            ledgerAccountId: settings.salesRevenueLedgerAccountId,
            debitAmount: "0",
            creditAmount: money(saleTotal),
            narration: `Retail sale #${input.saleId} · revenue`,
          },
        ]),
    ...(totalCost.isZero()
      ? []
      : [
          {
            ledgerAccountId: settings.cogsLedgerAccountId,
            debitAmount: money(totalCost),
            creditAmount: "0",
            narration: `Retail sale #${input.saleId} · COGS`,
          },
          {
            ledgerAccountId: settings.inventoryAssetLedgerAccountId,
            debitAmount: "0",
            creditAmount: money(totalCost),
            narration: `Retail sale #${input.saleId} · inventory`,
          },
        ]),
  ];
  const debitTotal = saleTotal.plus(totalCost);
  const sourceKey = `retail-pos-sale:${input.saleId}`;
  const posted = await postBalancedVoucherTx(
    tx,
    {
      voucher: {
        companyId: input.companyId,
        voucherNumber: `RETAIL-SALE-${input.saleId}`,
        voucherType: "Journal",
        voucherDate: new Date().toISOString().slice(0, 10),
        totalAmount: money(debitTotal),
        description: `Retail POS sale #${input.saleId}`,
        locationId: input.locationId,
        currency: "USD",
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
    refundAmount: number;
    idempotencyKey: string;
    userId: string;
  }
): Promise<RetailResolvedPayment[]> {
  let remaining = new Decimal(input.refundAmount);
  if (remaining.lessThanOrEqualTo(0)) return [];
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
    const legacyTotal = new Decimal(sale.totalAmount ?? 0);
    if (legacyTotal.lessThan(input.refundAmount)) {
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
      (refundedByPayment.get(row.relatedPaymentId) ?? new Decimal(0)).plus(row.amount)
    );
  }

  const created: RetailResolvedPayment[] = [];
  for (const original of payments) {
    if (remaining.lessThanOrEqualTo(EPSILON)) break;
    const available = Decimal.max(0, new Decimal(original.amount).minus(refundedByPayment.get(original.id) ?? 0));
    if (available.isZero()) continue;
    const amount = Decimal.min(available, remaining);
    const key = `${input.idempotencyKey}:refund:${original.id}`.slice(0, 191);
    const [inserted] = await tx
      .insert(retailPosPayments)
      .values({
        companyId: input.companyId,
        saleId: input.saleId,
        locationId: input.locationId,
        shiftId: input.shiftId ?? original.shiftId ?? null,
        paymentType: "refund",
        method: original.method,
        amount: money(amount),
        tenderedAmount: null,
        changeAmount: "0",
        reference: `Refund for payment #${original.id}`,
        ledgerAccountId: original.ledgerAccountId,
        bankAccountId: original.bankAccountId,
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
    created.push({
      id: row.id,
      method: row.method as RetailPaymentMethod,
      amount: toNumber(row.amount),
      tenderedAmount: null,
      changeAmount: 0,
      reference: row.reference ?? null,
      ledgerAccountId: row.ledgerAccountId ?? null,
      bankAccountId: row.bankAccountId ?? null,
      shiftId: row.shiftId ?? null,
      paymentType: row.paymentType,
    });
    remaining = remaining.minus(amount);
  }
  if (remaining.greaterThan(EPSILON)) {
    throw new Error(`Refund exceeds the remaining paid amount by ${remaining.toFixed(2)}`);
  }
  return created;
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
    refundAmount: number;
    restoredCost: number;
    refunds: RetailResolvedPayment[];
    userId: string;
    username?: string | null;
  }
): Promise<number | null> {
  const refundTotal = new Decimal(input.refundAmount);
  const restoredCost = new Decimal(input.restoredCost);
  if (refundTotal.isZero() && restoredCost.isZero()) return null;
  const settings = await ensureRetailAccountingSettingsTx(tx, input.companyId, input.locationId);
  const entries = [
    ...(refundTotal.isZero()
      ? []
      : [
          {
            ledgerAccountId: settings.salesRevenueLedgerAccountId,
            debitAmount: money(refundTotal),
            creditAmount: "0",
            narration: `Retail sale #${input.saleId} · refund revenue reversal`,
          },
          ...input.refunds.map((payment) => ({
            ...(payment.bankAccountId
              ? { bankAccountId: payment.bankAccountId }
              : { ledgerAccountId: payment.ledgerAccountId }),
            debitAmount: "0",
            creditAmount: money(payment.amount),
            narration: `Retail sale #${input.saleId} · ${payment.method} refund`,
          })),
        ]),
    ...(restoredCost.isZero()
      ? []
      : [
          {
            ledgerAccountId: settings.inventoryAssetLedgerAccountId,
            debitAmount: money(restoredCost),
            creditAmount: "0",
            narration: `Retail sale #${input.saleId} · inventory restored`,
          },
          {
            ledgerAccountId: settings.cogsLedgerAccountId,
            debitAmount: "0",
            creditAmount: money(restoredCost),
            narration: `Retail sale #${input.saleId} · COGS reversed`,
          },
        ]),
  ];
  const total = refundTotal.plus(restoredCost);
  const posted = await postBalancedVoucherTx(
    tx,
    {
      voucher: {
        companyId: input.companyId,
        voucherNumber: `RETAIL-${input.sourceType === "retail-pos-cancel" ? "CANCEL" : "RETURN"}-${input.sourceId}`,
        voucherType: "Journal",
        voucherDate: new Date().toISOString().slice(0, 10),
        totalAmount: money(total),
        description: `Retail ${input.sourceType === "retail-pos-cancel" ? "cancellation" : "return"} for sale #${input.saleId}`,
        locationId: input.locationId,
        currency: "USD",
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
  return posted.voucher.id;
}

export async function loadRetailSalePayments(companyId: number, saleId: number) {
  const rows = await db
    .select()
    .from(retailPosPayments)
    .where(and(eq(retailPosPayments.companyId, companyId), eq(retailPosPayments.saleId, saleId)))
    .orderBy(asc(retailPosPayments.id));
  return rows.map((row) => ({
    id: row.id,
    method: row.method,
    paymentType: row.paymentType,
    amount: toNumber(row.amount),
    tenderedAmount: row.tenderedAmount == null ? null : toNumber(row.tenderedAmount),
    changeAmount: toNumber(row.changeAmount),
    reference: row.reference,
    shiftId: row.shiftId,
  }));
}

export async function getRetailShiftSummary(companyId: number, shiftId: number) {
  const [shift] = await db
    .select()
    .from(posShifts)
    .where(and(eq(posShifts.id, shiftId), eq(posShifts.companyId, companyId)))
    .limit(1);
  if (!shift) throw new Error("Shift not found");
  const payments = await db
    .select()
    .from(retailPosPayments)
    .where(and(eq(retailPosPayments.companyId, companyId), eq(retailPosPayments.shiftId, shiftId)));
  const movements = await db
    .select()
    .from(retailCashMovements)
    .where(and(eq(retailCashMovements.companyId, companyId), eq(retailCashMovements.shiftId, shiftId)));

  const methods: Record<string, number> = {};
  let cashSales = 0;
  let cashRefunds = 0;
  const saleIds = new Set<number>();
  for (const payment of payments) {
    const signed = payment.paymentType === "refund" ? -toNumber(payment.amount) : toNumber(payment.amount);
    methods[payment.method] = (methods[payment.method] ?? 0) + signed;
    if (payment.paymentType === "payment") saleIds.add(payment.saleId);
    if (payment.method === "cash") {
      if (payment.paymentType === "refund") cashRefunds += toNumber(payment.amount);
      else cashSales += toNumber(payment.amount);
    }
  }
  let cashIn = 0;
  let cashOut = 0;
  for (const movement of movements) {
    if (movement.movementType === "cash_in") cashIn += toNumber(movement.amount);
    else cashOut += toNumber(movement.amount);
  }
  const openingCash = toNumber(shift.openingCash);
  const expectedCash = openingCash + cashSales - cashRefunds + cashIn - cashOut;
  return {
    shift,
    salesCount: saleIds.size,
    paymentMethods: methods,
    cashSales,
    cashRefunds,
    cashIn,
    cashOut,
    expectedCash,
  };
}

export async function getRetailAccountingSettings(companyId: number, locationId?: number | null) {
  return db.transaction((tx) => ensureRetailAccountingSettingsTx(tx, companyId, locationId));
}

export async function saveRetailAccountingSettings(
  companyId: number,
  locationId: number | null,
  patch: Partial<{
    cashLedgerAccountId: number | null;
    cardLedgerAccountId: number | null;
    bankLedgerAccountId: number | null;
    bankAccountId: number | null;
    mobileLedgerAccountId: number | null;
    otherLedgerAccountId: number | null;
    salesRevenueLedgerAccountId: number | null;
    inventoryAssetLedgerAccountId: number | null;
    cogsLedgerAccountId: number | null;
    discountsLedgerAccountId: number | null;
    taxPayableLedgerAccountId: number | null;
    storeCreditLedgerAccountId: number | null;
  }>
) {
  return db.transaction(async (tx) => {
    await ensureRetailAccountingSettingsTx(tx, companyId, locationId);
    const condition = locationId
      ? and(eq(retailAccountingSettings.companyId, companyId), eq(retailAccountingSettings.locationId, locationId))
      : and(eq(retailAccountingSettings.companyId, companyId), isNull(retailAccountingSettings.locationId));
    const [updated] = await tx
      .update(retailAccountingSettings)
      .set({ ...patch, updatedAt: new Date() })
      .where(condition)
      .returning();
    return updated;
  });
}

export async function listRetailFinancialAccounts(companyId: number) {
  const [ledgers, banks] = await Promise.all([
    db
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)))
      .orderBy(ledgerAccounts.name),
    db
      .select({ id: bankAccounts.id, code: bankAccounts.code, name: bankAccounts.name })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), isNull(bankAccounts.deletedAt)))
      .orderBy(bankAccounts.name),
  ]);
  return { ledgers, banks };
}

export async function getRetailFinancialReconciliation(
  companyId: number,
  input: { locationId?: number | null; from?: Date | null; to?: Date | null }
) {
  const filters = [
    sql`s.company_id = ${companyId}`,
    input.locationId ? sql`s.location_id = ${input.locationId}` : sql`TRUE`,
    input.from ? sql`s.created_at >= ${input.from}` : sql`TRUE`,
    input.to ? sql`s.created_at < ${input.to}` : sql`TRUE`,
  ];
  const result = await db.execute(sql`
    SELECT
      s.id AS sale_id,
      s.location_id,
      s.status,
      s.total_amount,
      s.accounting_voucher_id,
      s.created_at,
      COALESCE(SUM(CASE WHEN p.payment_type = 'payment' THEN p.amount ELSE 0 END), 0) AS payments,
      COALESCE(SUM(CASE WHEN p.payment_type = 'refund' THEN p.amount ELSE 0 END), 0) AS refunds
    FROM retail_pos_sales s
    LEFT JOIN retail_pos_payments p ON p.sale_id = s.id AND p.company_id = s.company_id
    WHERE ${sql.join(filters, sql` AND `)}
    GROUP BY s.id
    ORDER BY s.created_at DESC
    LIMIT 500
  `);
  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
  const mapped = rows.map((row) => {
    const total = toNumber(row.total_amount);
    const paid = toNumber(row.payments);
    const refunded = toNumber(row.refunds);
    const expectedNet = row.status === "canceled" ? 0 : total - refunded;
    const actualNet = paid - refunded;
    const paymentMismatch = Math.abs(actualNet - expectedNet) > 0.000001;
    const accountingMissing = Number(row.accounting_voucher_id ?? 0) <= 0 && total !== 0;
    return { ...row, totalAmount: total, payments: paid, refunds: refunded, paymentMismatch, accountingMissing };
  });
  return {
    rows: mapped,
    summary: {
      sales: mapped.length,
      paymentMismatches: mapped.filter((row) => row.paymentMismatch).length,
      missingAccounting: mapped.filter((row) => row.accountingMissing).length,
    },
  };
}
