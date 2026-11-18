// Extracted from ./with-balances.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { db } from "../../../../db";
import { sqlArray } from "../../../../lib/sqlArray";
import { resolveStoredFxRate } from "../../../../services/factory/currencyConversion";
import { MoneyDecimal, toMoney } from "../../../../lib/money";
import type Decimal from "decimal.js";
import {
  factoryContainers,
  factoryOffloadAdditionalCharges,
  factorySupplierFxTransfers,
  factorySupplierPayments,
  factorySuppliers,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { isSupplierPaidFreight } from "./_helpers";
import { supplierUsdEquivalent } from "./supplierUsdEquivalent";
import { loadSupplierSettlementBalances, type SupplierSettlementBalance } from "./settlementPools";
import { emptyFactorySupplierLedgerView, loadFactorySupplierLedgerViews } from "./factorySupplierLedger";
import {
  entryNativeAmounts,
  entryStoredUsdAmounts,
  voucherEntryCurrencyColumns,
} from "../../../../services/factory/voucherEntryCurrency";

// Balances are summed as exact decimals (server/lib/money.ts) and only turned
// into numbers or fixed-point strings when the response is built.
export type MoneyBucket = Record<string, Decimal>;

export const ZERO = new MoneyDecimal(0);

export const addTo = (bucket: MoneyBucket, key: string, amount: Decimal) => {
  bucket[key] = (bucket[key] ?? ZERO).plus(amount);
};

type ContainerAmounts = {
  actualReceivedKg: string | null;
  totalKg: string | null;
  ratePerKg: string | null;
  freight: string | null;
};

/** Received (else declared) kg × rate, plus freight when the supplier pays it. */
export const receivedValue = (c: ContainerAmounts & Record<string, unknown>) =>
  toMoney(c.actualReceivedKg || c.totalKg)
    .times(toMoney(c.ratePerKg))
    .plus(isSupplierPaidFreight(c) ? toMoney(c.freight) : ZERO);

export async function handleGetFactorySuppliersWithBalancesStep1(req: Request, res: Response) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const includeOtw = req.query.includeOtw === "true";

  const suppliersList = await db
    .select()
    .from(factorySuppliers)
    .where(eq(factorySuppliers.companyId, companyId))
    .orderBy(factorySuppliers.name);

  const containers = await db
    .select()
    .from(factoryContainers)
    .where(and(eq(factoryContainers.companyId, companyId), isNull(factoryContainers.deletedAt)));

  const allPayments = await db
    .select()
    .from(factorySupplierPayments)
    .where(eq(factorySupplierPayments.companyId, companyId));

  const allFxTransfers = await db
    .select()
    .from(factorySupplierFxTransfers)
    .where(eq(factorySupplierFxTransfers.companyId, companyId));

  // Voucher-based payments: debit entries on voucherEntries where factorySupplierId is set.
  // Exclude FACTORY-PAY-* vouchers — those are auto-generated from factorySupplierPayments
  // and are already counted in allPayments (would double-count otherwise).
  const allSupplierIds = suppliersList.map((s) => s.id);
  const voucherFxUnresolvedSuppliers = new Set<number>();
  const voucherPaidBySupplierCurrency: Record<number, MoneyBucket> = {};
  const voucherPaidBySupplierCurrencyUsd: Record<number, MoneyBucket> = {};
  if (allSupplierIds.length > 0) {
    const voucherPaymentRows = await db
      .select({
        factorySupplierId: voucherEntries.factorySupplierId,
        ...voucherEntryCurrencyColumns,
        exchangeRate: vouchers.exchangeRate,
        optional: vouchers.optional,
      })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .where(
        and(
          inArray(voucherEntries.factorySupplierId, allSupplierIds),
          // A voucher line belongs to its voucher's company; deleted and optional
          // vouchers never reach a balance (soft delete keeps the lines).
          eq(vouchers.companyId, companyId),
          eq(vouchers.optional, false),
          isNull(vouchers.deletedAt),
          sql`${voucherEntries.debitAmount}::numeric > 0`,
          sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`,
          // Financial supplier FX journals are already represented by the source
          // FX-transfer rows. Counting their supplier debit as a second payment
          // subtracts the same transfer twice from operational balances.
          sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-SFX-%'`,
          // Audited supplier reclassification and its compensating reversal
          // are balanced GL transfers, NOT payments. Counting only their
          // debit legs creates fake payments and corrupts broker pools.
          sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAYABLE-RECLASS-%'`,
          // Posted freight/FX repair journals are non-payment ledger corrections.
          sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-CORRECTION-%'`
        )
      );
    for (const row of voucherPaymentRows) {
      const suppId = row.factorySupplierId;
      if (!suppId) continue;
      if (row.optional) continue; // optional vouchers don't affect the balance
      // Native amount in its own currency; a normalized entry also holds
      // its USD base, and only a legacy foreign-currency entry is
      // converted from the voucher's rate.
      const native = entryNativeAmounts(row);
      const amt = native.debit;
      const curr = native.currency;
      const stored = entryStoredUsdAmounts(row);
      let usdAmt: Decimal;
      if (stored) {
        usdAmt = stored.debit;
      } else {
        // vouchers.exchangeRate has no fxRateConfirmed column yet — legacy heuristic stopgap.
        const { fxRate: fx, looksSet } = resolveStoredFxRate(curr, row.exchangeRate);
        if (!looksSet) {
          voucherFxUnresolvedSuppliers.add(suppId);
          continue; // exclude from the total rather than guess at 1
        }
        usdAmt = amt.times(fx);
      }
      addTo((voucherPaidBySupplierCurrency[suppId] ??= {}), curr, amt);
      addTo((voucherPaidBySupplierCurrencyUsd[suppId] ??= {}), curr, usdAmt);
    }
  }

  // Load the user-configured display FX rates (e.g. EUR=1.18, AUD=0.75)
  // These are the same rates shown on the Net Position page.
  const fxRateRows = await db.execute<{ currency_code: string; rate_to_usd: string }>(sql`
        SELECT DISTINCT ON (currency_code) currency_code, rate_to_usd
        FROM factory_fx_rates
        WHERE company_id = ${companyId} AND source = 'manual'
        ORDER BY currency_code, effective_date DESC
      `);
  const configuredFxRates: Record<string, number> = {};
  for (const row of fxRateRows.rows) {
    configuredFxRates[row.currency_code] = Number(row.rate_to_usd);
  }

  // Pre-fetch post-offload charges explicitly assigned to a supplier (supplierId NOT NULL).
  // Charges posted to a ledger account have supplierId=null and must NOT appear on any supplier balance.
  const allOffloadAdditionalCharges =
    allSupplierIds.length > 0
      ? await db
          .select({
            supplierId: factoryOffloadAdditionalCharges.supplierId,
            amount: factoryOffloadAdditionalCharges.amount,
            currencyCode: factoryOffloadAdditionalCharges.currencyCode,
            fxRateToUsd: factoryOffloadAdditionalCharges.fxRateToUsd,
          })
          .from(factoryOffloadAdditionalCharges)
          .where(
            and(
              eq(factoryOffloadAdditionalCharges.companyId, companyId),
              sql`${factoryOffloadAdditionalCharges.supplierId} = ANY(${sqlArray(allSupplierIds)})`
            )
          )
      : [];

  // The inside Settlement Statement's currency pools (honouring the OTW
  // toggle), loaded in bulk. Each non-broker card shows exactly their
  // current-rate USD equivalent: USD + Σ(native × Factory Settings rate).
  const settlementBalancesPromise =
    allSupplierIds.length > 0
      ? loadSupplierSettlementBalances(companyId, { includeOtw, configuredFxRates })
      : Promise.resolve(new Map<number, SupplierSettlementBalance>());

  // Primary balances (wave 13, owner decision 3): the ledger from the balance
  // engine, the native balance per currency of the same lines, and the
  // container amounts not yet in the ledger. The operational figures
  // computed below are returned only as a labelled memo.
  const [settlementBalances, ledgerViews] = await Promise.all([
    settlementBalancesPromise,
    loadFactorySupplierLedgerViews(db, companyId, { ids: allSupplierIds }),
  ]);
  const ledgerFields = (supplierId: number) => {
    const view = ledgerViews.get(supplierId) ?? emptyFactorySupplierLedgerView(supplierId);
    return {
      totalValue: view.ledgerBalanceUsd,
      // Reporting-only current-rate value of the signed native ledger buckets,
      // including the opening USD balance exactly once. Do not revalue the GL.
      ...supplierUsdEquivalent(view.nativeBalances, configuredFxRates, view.openingBalanceUsd),
      balanceBasis: view.balanceBasis,
      ledgerBalance: view.ledgerBalanceUsd,
      ledgerBalanceSide: view.ledgerBalanceSide,
      currencyBalances: view.nativeBalances
        .filter((bucket) => toMoney(bucket.balance).abs().gt(0.001))
        .map((bucket) => ({
          currencyCode: bucket.currencyCode,
          balance: toMoney(bucket.balance).toNumber(),
          fxRateToUsd: toMoney(bucket.effectiveFxRateToUsd ?? 0).toNumber(),
        })),
      nativeBalances: view.nativeBalances,
      notInLedgerTotal: view.notInLedger.total,
      notInLedger: view.notInLedger,
      fxUnresolved: view.ledgerFxUnresolved,
    };
  };

  const ledgerExposure = (supplierIds: number[]) => {
    const native: MoneyBucket = {};
    const usd: MoneyBucket = {};
    for (const id of supplierIds) {
      for (const bucket of ledgerViews.get(id)?.nativeBalances ?? []) {
        if (!toMoney(bucket.balance).gt(0)) continue;
        addTo(native, bucket.currencyCode, toMoney(bucket.balance));
        addTo(usd, bucket.currencyCode, toMoney(bucket.usdBalance));
      }
    }
    return Object.entries(native)
      .filter(([, balance]) => balance.gt(0.001))
      .map(([currencyCode, balance]) => ({
        currencyCode,
        balance: balance.toNumber(),
        fxRateToUsd: currencyCode === "USD" ? 1 : (usd[currencyCode] ?? ZERO).dividedBy(balance).toNumber(),
      }))
      .sort((a, _b) => (a.currencyCode === "USD" ? 1 : -1));
  };
  return {
    done: false as const,
    allFxTransfers,
    allOffloadAdditionalCharges,
    allPayments,
    companyId,
    configuredFxRates,
    containers,
    includeOtw,
    ledgerExposure,
    ledgerFields,
    settlementBalances,
    suppliersList,
    voucherFxUnresolvedSuppliers,
    voucherPaidBySupplierCurrency,
    voucherPaidBySupplierCurrencyUsd,
  };
}
