// Extracted from ./supplierStatementRoutes.ts to keep that module under the source-size cap.
import { parseId } from "../../../lib/parseId";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { resolveStoredFxRate } from "../../../services/factory/currencyConversion";
import { MoneyDecimal, sumMoney, toMoney } from "../../../lib/money";
import type Decimal from "decimal.js";
import {
  factoryContainerCommissions,
  factoryContainers,
  factoryOffloadAdditionalCharges,
  factoryRawStock,
  factorySupplierPayments,
  factorySuppliers,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { buildSettlementStatementRow } from "./balance/settlementPools";
import { entryStoredUsdAmounts, voucherEntryCurrencyColumns } from "../../../services/factory/voucherEntryCurrency";

// Amounts are summed as exact decimals (server/lib/money.ts) and only turned
// into fixed-point strings when the response is built.
export const ZERO = new MoneyDecimal(0);

export const decimalMax = (a: Decimal, b: Decimal) => (a.gt(b) ? a : b);

/** "+$1,234.57" / "-EUR 10.00": rounded to cents exactly, then grouped for display. */
export const formatLedgerAmount = (amount: string | null, cc: string, negative: boolean) => {
  const prefix = cc !== "USD" ? `${cc} ` : "$";
  const cents = Number(toMoney(amount).toFixed(2));
  return `${negative ? "-" : "+"}${prefix}${cents.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export async function handleGetFactorySuppliersIdStatementStep1(req: Request, res: Response) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const supplierId = parseId(req.params.id);

  if (supplierId === null) return { done: true as const, value: res.status(400).json({ message: "Invalid id" }) };

  const [supplier] = await db
    .select()
    .from(factorySuppliers)
    .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)));

  if (!supplier) return { done: true as const, value: res.status(404).json({ message: "Supplier not found" }) };

  const includeOtw = req.query.includeOtw === "true";
  const containersWhere = includeOtw
    ? and(
        eq(factoryContainers.companyId, companyId),
        eq(factoryContainers.supplierId, supplierId),
        isNull(factoryContainers.deletedAt)
      )
    : and(
        eq(factoryContainers.companyId, companyId),
        eq(factoryContainers.supplierId, supplierId),
        isNull(factoryContainers.deletedAt),
        sql`${factoryContainers.status} NOT IN ('PENDING', 'IN_TRANSIT')`
      );
  const containers = await db
    .select()
    .from(factoryContainers)
    .where(containersWhere)
    .orderBy(desc(factoryContainers.createdAt));

  // Containers where this supplier earns commission as a broker (commissionSupplierId = supplierId)
  const brokerContainerRows = await db
    .select({
      id: factoryContainers.id,
      containerNumber: factoryContainers.containerNumber,
      supplierId: factoryContainers.supplierId,
      arrivalDate: factoryContainers.arrivalDate,
      createdAt: factoryContainers.createdAt,
      status: factoryContainers.status,
      commissionAmount: factoryContainers.commissionAmount,
      commissionCurrencyCode: factoryContainers.commissionCurrencyCode,
      origin: factoryContainers.origin,
      supplierName: factorySuppliers.name,
    })
    .from(factoryContainers)
    .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
    .where(
      and(
        eq(factoryContainers.companyId, companyId),
        eq(factoryContainers.commissionSupplierId, supplierId),
        sql`${factoryContainers.supplierId} != ${supplierId}`,
        isNull(factoryContainers.deletedAt)
      )
    )
    .orderBy(desc(factoryContainers.createdAt));
  const brokerContainers = brokerContainerRows.filter((c) => toMoney(c.commissionAmount).gt(0));
  const totalBrokerCommission = sumMoney(brokerContainers.map((c) => c.commissionAmount));

  const commissions = await db
    .select()
    .from(factoryContainerCommissions)
    .where(eq(factoryContainerCommissions.companyId, companyId));

  // OB commissions — raw stock entries with commission data for this supplier
  const obRawStockWithCommission =
    containers.length > 0
      ? await db
          .select()
          .from(factoryRawStock)
          .where(
            and(
              eq(factoryRawStock.companyId, companyId),
              inArray(
                factoryRawStock.containerId,
                containers.map((c) => c.id)
              )
            )
          )
      : [];

  // Additional charges (offload) assigned directly to this supplier
  const supplierOffloadCharges = await db
    .select({
      id: factoryOffloadAdditionalCharges.id,
      containerId: factoryOffloadAdditionalCharges.containerId,
      description: factoryOffloadAdditionalCharges.description,
      amount: factoryOffloadAdditionalCharges.amount,
      currencyCode: factoryOffloadAdditionalCharges.currencyCode,
      fxRateToUsd: factoryOffloadAdditionalCharges.fxRateToUsd,
      createdAt: factoryOffloadAdditionalCharges.createdAt,
    })
    .from(factoryOffloadAdditionalCharges)
    .where(
      and(
        eq(factoryOffloadAdditionalCharges.companyId, companyId),
        eq(factoryOffloadAdditionalCharges.supplierId, supplierId)
      )
    )
    .orderBy(factoryOffloadAdditionalCharges.createdAt);

  // Also fetch container-level other_charges attributed to this supplier via other_charges_supplier_id
  // (these are stored directly on factory_containers, distinct from the factoryOffloadAdditionalCharges table)
  const containerColCharges = await db
    .select({
      id: factoryContainers.id,
      containerId: factoryContainers.id,
      description: sql<string>`'Other Charges'`,
      amount: factoryContainers.otherCharges,
      otherChargesCurrencyCode: factoryContainers.otherChargesCurrencyCode,
      containerCurrencyCode: factoryContainers.currencyCode,
      fxRateToUsd: factoryContainers.fxRateToUsd,
      createdAt: factoryContainers.createdAt,
    })
    .from(factoryContainers)
    .where(
      and(
        eq(factoryContainers.companyId, companyId),
        eq(factoryContainers.otherChargesSupplierId, supplierId),
        sql`${factoryContainers.otherCharges}::numeric > 0`,
        // A deleted container's charges no longer belong to the supplier.
        isNull(factoryContainers.deletedAt)
      )
    );
  // Merge into supplierOffloadCharges list for unified processing below
  // Use otherChargesCurrencyCode when set, otherwise default to USD
  const allSupplierCharges = [
    ...supplierOffloadCharges,
    ...containerColCharges.map((c) => ({
      ...c,
      amount: c.amount,
      currencyCode: c.otherChargesCurrencyCode || "USD",
    })),
  ];

  const statement = containers.map((c) =>
    buildSettlementStatementRow(
      c,
      commissions.filter((cm) => cm.containerId === c.id),
      obRawStockWithCommission.some((r) => r.containerId === c.id)
    )
  );

  const totalValue = sumMoney(statement.map((s) => s.value));
  const totalKg = sumMoney(statement.map((s) => s.actualReceivedKg || s.totalKg));
  const totalCommissions = sumMoney(statement.map((s) => s.totalCommission));
  const totalDirectCommissions = sumMoney(statement.map((s) => s.commissionAmount));

  // Fetch payments for this supplier (needed for per-currency net payable calculation)
  const payments = await db
    .select()
    .from(factorySupplierPayments)
    .where(and(eq(factorySupplierPayments.companyId, companyId), eq(factorySupplierPayments.supplierId, supplierId)))
    .orderBy(desc(factorySupplierPayments.date));

  // Also fetch voucher-based payments (manually created Payment vouchers — exclude
  // auto-generated FACTORY-PAY-* vouchers which are already reflected in the payments array)
  const voucherPaymentRows = await db
    .select({
      id: voucherEntries.id,
      voucherId: voucherEntries.voucherId,
      ...voucherEntryCurrencyColumns,
      voucherDate: vouchers.voucherDate,
      description: vouchers.description,
      voucherType: vouchers.voucherType,
      voucherNumber: vouchers.voucherNumber,
      exchangeRate: vouchers.exchangeRate,
      optional: vouchers.optional,
    })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
    .where(
      and(
        eq(voucherEntries.factorySupplierId, supplierId),
        sql`${voucherEntries.debitAmount}::numeric > 0`,
        sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`,
        // Financial supplier FX journals are already represented by the source
        // FX-transfer rows. Counting their supplier debit as a second payment
        // subtracts the same transfer twice from operational balances.
        sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-SFX-%'`,
        // Ledger-only compensating journals are not supplier payments.
        sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAYABLE-RECLASS-%'`,
        // Posted freight/FX repair journals are non-payment ledger corrections.
        sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-CORRECTION-%'`,
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt)
      )
    )
    .orderBy(desc(vouchers.voucherDate));

  // Convert voucher payments to USD for total calculation (exclude optional payments)
  const voucherPaymentsTotal = voucherPaymentRows.reduce((sum, p) => {
    if (p.optional) return sum; // optional payments don't affect the balance
    // A normalized entry already holds its USD base; only a legacy
    // foreign-currency entry is converted from the voucher's rate.
    const stored = entryStoredUsdAmounts(p);
    if (stored) return sum.plus(stored.debit);
    const amt = toMoney(p.debitAmount);
    const currency = p.currency || "USD";
    // vouchers.exchangeRate has no fxRateConfirmed column yet — legacy heuristic stopgap.
    const { fxRate: fx, looksSet } = resolveStoredFxRate(currency, p.exchangeRate);
    if (!looksSet) return sum; // exclude from the total rather than guess at 1
    return sum.plus(amt.times(fx));
  }, ZERO);

  const totalPayments = sumMoney(payments.map((p) => p.amountUsd)).plus(voucherPaymentsTotal);
  return {
    done: false as const,
    allSupplierCharges,
    brokerContainers,
    commissions,
    companyId,
    containers,
    obRawStockWithCommission,
    payments,
    statement,
    supplier,
    supplierId,
    totalBrokerCommission,
    totalCommissions,
    totalDirectCommissions,
    totalKg,
    totalPayments,
    totalValue,
    voucherPaymentRows,
  };
}
