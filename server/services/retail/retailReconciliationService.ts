import Decimal from "decimal.js";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import {
  retailAccountingPostings,
  retailPosPayments,
  retailPosReturns,
  retailPosSaleItems,
  retailPosSales,
  retailStockMovements,
  voucherEntries,
} from "@shared/schema";
import type { RetailAccountKey } from "@shared/schema";
import { db } from "../../db";
import { retailMoney } from "./retailFinancialMath";

function sum(values: Array<string | number | null | undefined>): Decimal {
  return values.reduce((total, value) => total.plus(value ?? 0), new Decimal(0));
}

function parseDate(value: string | undefined, label: string): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a valid calendar date`);
  }
  return parsed;
}

function atEndExclusive(date: Date): Date {
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}

export async function getRetailReconciliationReport(input: {
  companyId: number;
  locationId?: number;
  from?: string;
  to?: string;
}) {
  const from = parseDate(input.from, "From date");
  const through = parseDate(input.to, "To date");
  if (from && through && from > through) throw new Error("From date must not be after To date");
  const toExclusive = through ? atEndExclusive(through) : null;
  const saleFilters = [
    eq(retailPosSales.companyId, input.companyId),
    eq(retailPosSales.checkoutVersion, 1),
    input.locationId ? eq(retailPosSales.locationId, input.locationId) : undefined,
    from ? gte(retailPosSales.createdAt, from) : undefined,
    toExclusive ? lt(retailPosSales.createdAt, toExclusive) : undefined,
  ];
  const sales = await db
    .select({ id: retailPosSales.id, totalAmount: retailPosSales.totalAmount })
    .from(retailPosSales)
    .where(and(...saleFilters));

  const returnFilters = [
    eq(retailPosReturns.companyId, input.companyId),
    eq(retailPosSales.checkoutVersion, 1),
    input.locationId ? eq(retailPosSales.locationId, input.locationId) : undefined,
    from ? gte(retailPosReturns.createdAt, from) : undefined,
    toExclusive ? lt(retailPosReturns.createdAt, toExclusive) : undefined,
  ];
  const returns = await db
    .select({ totalAmount: retailPosReturns.totalAmount })
    .from(retailPosReturns)
    .innerJoin(retailPosSales, eq(retailPosSales.id, retailPosReturns.saleId))
    .where(and(...returnFilters));

  const postingFilters = [
    eq(retailAccountingPostings.companyId, input.companyId),
    eq(retailPosSales.checkoutVersion, 1),
    input.locationId ? eq(retailPosSales.locationId, input.locationId) : undefined,
    from ? gte(retailAccountingPostings.createdAt, from) : undefined,
    toExclusive ? lt(retailAccountingPostings.createdAt, toExclusive) : undefined,
  ];
  const postingRows = await db
    .select({
      voucherId: retailAccountingPostings.voucherId,
      postingType: retailAccountingPostings.postingType,
      accountSnapshot: retailAccountingPostings.accountSnapshot,
      subtotalAmount: retailAccountingPostings.subtotalAmount,
      discountAmount: retailAccountingPostings.discountAmount,
      taxAmount: retailAccountingPostings.taxAmount,
      totalAmount: retailAccountingPostings.totalAmount,
      cogsAmount: retailAccountingPostings.cogsAmount,
    })
    .from(retailAccountingPostings)
    .innerJoin(retailPosSales, eq(retailPosSales.id, retailAccountingPostings.saleId))
    .where(and(...postingFilters));

  const paymentFilters = [
    eq(retailPosPayments.companyId, input.companyId),
    eq(retailPosSales.checkoutVersion, 1),
    input.locationId ? eq(retailPosPayments.locationId, input.locationId) : undefined,
    from ? gte(retailPosPayments.createdAt, from) : undefined,
    toExclusive ? lt(retailPosPayments.createdAt, toExclusive) : undefined,
  ];
  const paymentRows = await db
    .select({ amount: retailPosPayments.amount })
    .from(retailPosPayments)
    .innerJoin(retailPosSales, eq(retailPosSales.id, retailPosPayments.saleId))
    .where(and(...paymentFilters));

  const saleItems = await db
    .select({ id: retailPosSaleItems.id, unitCost: retailPosSaleItems.unitCost })
    .from(retailPosSaleItems)
    .innerJoin(retailPosSales, eq(retailPosSales.id, retailPosSaleItems.saleId))
    .where(and(eq(retailPosSaleItems.companyId, input.companyId), eq(retailPosSales.checkoutVersion, 1)));
  const unitCostBySaleItem = new Map(saleItems.map((item) => [item.id, new Decimal(item.unitCost ?? 0)]));

  const movementFilters = [
    eq(retailStockMovements.companyId, input.companyId),
    inArray(retailStockMovements.movementType, ["sale", "return", "cancellation"]),
    input.locationId ? eq(retailStockMovements.locationId, input.locationId) : undefined,
    from ? gte(retailStockMovements.createdAt, from) : undefined,
    toExclusive ? lt(retailStockMovements.createdAt, toExclusive) : undefined,
  ];
  const movements = await db
    .select({ quantityDelta: retailStockMovements.quantityDelta, metadata: retailStockMovements.metadata })
    .from(retailStockMovements)
    .where(and(...movementFilters));
  let movementCogs = new Decimal(0);
  for (const movement of movements) {
    const saleItemId = Number(movement.metadata?.saleItemId ?? 0);
    const unitCost = unitCostBySaleItem.get(saleItemId);
    if (!unitCost || !Number.isFinite(saleItemId)) continue;
    // A sale movement is negative inventory; a return/cancellation is positive.
    // Negating its signed value yields the matching signed COGS/inventory delta.
    movementCogs = movementCogs.minus(new Decimal(movement.quantityDelta ?? 0).mul(unitCost));
  }

  const voucherIds = [...new Set(postingRows.map((posting) => posting.voucherId))];
  const entryRows = voucherIds.length
    ? await db
        .select({
          voucherId: voucherEntries.voucherId,
          ledgerAccountId: voucherEntries.ledgerAccountId,
          debitAmount: voucherEntries.debitAmount,
          creditAmount: voucherEntries.creditAmount,
        })
        .from(voucherEntries)
        .where(inArray(voucherEntries.voucherId, voucherIds))
    : [];
  const snapshotByVoucher = new Map(postingRows.map((posting) => [posting.voucherId, posting.accountSnapshot ?? {}]));
  const accounting = { revenue: new Decimal(0), discounts: new Decimal(0), tax: new Decimal(0), cogs: new Decimal(0) };
  for (const entry of entryRows) {
    const snapshot = snapshotByVoucher.get(entry.voucherId) as Partial<Record<RetailAccountKey, number>> | undefined;
    if (!snapshot) continue;
    const debit = new Decimal(entry.debitAmount ?? 0);
    const credit = new Decimal(entry.creditAmount ?? 0);
    if (entry.ledgerAccountId === snapshot.sales_revenue)
      accounting.revenue = accounting.revenue.plus(credit.minus(debit));
    if (entry.ledgerAccountId === snapshot.discounts)
      accounting.discounts = accounting.discounts.plus(debit.minus(credit));
    if (entry.ledgerAccountId === snapshot.tax_payable) accounting.tax = accounting.tax.plus(credit.minus(debit));
    if (entry.ledgerAccountId === snapshot.cogs) accounting.cogs = accounting.cogs.plus(debit.minus(credit));
  }

  const salesTotal = sum(sales.map((sale) => sale.totalAmount));
  const returnsTotal = sum(returns.map((entry) => entry.totalAmount));
  const cancellationTotal = sum(
    postingRows.filter((posting) => posting.postingType === "cancellation").map((posting) => posting.totalAmount)
  );
  const netRetailTotal = salesTotal.minus(returnsTotal).minus(cancellationTotal).toDecimalPlaces(2);
  const paymentNet = sum(paymentRows.map((payment) => payment.amount)).toDecimalPlaces(2);
  const accountingTotal = accounting.revenue.minus(accounting.discounts).plus(accounting.tax).toDecimalPlaces(2);
  const retailRevenue = accounting.revenue.minus(accounting.discounts).toDecimalPlaces(2);
  const cogsTotal = accounting.cogs.toDecimalPlaces(2);
  movementCogs = movementCogs.toDecimalPlaces(2);
  const checks = [
    {
      key: "payments",
      label: "Retail sales vs net payments",
      expected: netRetailTotal,
      actual: paymentNet,
    },
    {
      key: "accounting",
      label: "Retail sales vs posted accounting total",
      expected: netRetailTotal,
      actual: accountingTotal,
    },
    {
      key: "accounting-revenue",
      label: "Net Retail sales less tax vs posted revenue",
      expected: netRetailTotal.minus(accounting.tax).toDecimalPlaces(2),
      actual: retailRevenue,
    },
    {
      key: "inventory-cogs",
      label: "Posted COGS vs valued stock movement",
      expected: cogsTotal,
      actual: movementCogs,
    },
  ].map((check) => {
    const difference = check.actual.minus(check.expected).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return {
      key: check.key,
      label: check.label,
      expected: check.expected.toFixed(2),
      actual: check.actual.toFixed(2),
      difference: difference.toFixed(2),
      mismatch: difference.abs().gte("0.01"),
    };
  });
  const mismatches = checks.filter((check) => check.mismatch);
  const status = mismatches.length ? "MISMATCH" : "RECONCILED";

  return {
    status,
    hasMismatch: mismatches.length > 0,
    alert: mismatches.length
      ? `Retail reconciliation found ${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}. Review the flagged totals before closing the period.`
      : "Retail sales, payments, posted revenue and COGS/inventory movement reconcile.",
    filters: { from: input.from ?? null, to: input.to ?? null, locationId: input.locationId ?? null },
    transactionCounts: {
      sales: sales.length,
      returns: returns.length,
      postings: postingRows.length,
      payments: paymentRows.length,
    },
    totals: {
      salesTotal: retailMoney(salesTotal.toFixed()),
      returnsTotal: retailMoney(returnsTotal.toFixed()),
      cancellationsTotal: retailMoney(cancellationTotal.toFixed()),
      netRetailTotal: retailMoney(netRetailTotal.toFixed()),
      netPayments: retailMoney(paymentNet.toFixed()),
      accountingRevenue: retailMoney(retailRevenue.toFixed()),
      accountingTax: retailMoney(accounting.tax.toFixed()),
      accountingTotal: retailMoney(accountingTotal.toFixed()),
      accountingCogs: retailMoney(cogsTotal.toFixed()),
      inventoryMovementCogs: retailMoney(movementCogs.toFixed()),
    },
    checks,
    mismatches,
  };
}
