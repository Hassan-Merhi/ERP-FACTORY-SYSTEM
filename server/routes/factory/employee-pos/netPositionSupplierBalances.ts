import { eq, and, sql, inArray, isNull, lte } from "drizzle-orm";

import {
  factorySuppliers,
  factoryContainers,
  voucherEntries,
  vouchers,
  factorySupplierPayments,
  factorySupplierFxTransfers,
} from "@shared/schema";

import { db } from "../../../db";
import { buildBrokerStatement } from "../suppliers/broker";
import { isSupplierPaidFreight } from "../suppliers/_supplierStatementHelpers";
import { resolveStoredFxRate } from "../../../services/factory/currencyConversion";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import {
  entryNativeAmounts,
  isNormalizedEntry,
  voucherEntryCurrencyColumns,
} from "../../../services/factory/voucherEntryCurrency";

/**
 * Section 1 of the factory net-position report: what the company owes its
 * suppliers.
 *
 * Brokers are settled through buildBrokerStatement so the figure matches the
 * Suppliers page exactly; standalone suppliers accumulate in their native
 * currency and convert once at the end, which is the same formula computeStats
 * uses. The block was self-contained inside the handler - it reads four values
 * from the request scope and everything else it built was scratch.
 *
 * supplierLockedRateMapNp and allContainersF are returned alongside the
 * balances because the inventory valuations in ./netPositionInventory need
 * them and this block is where they are loaded.
 *
 * config/report-characterization.json pins the endpoint's output across the move.
 */
export interface NetPositionSupplierContext {
  companyId: number;
  asOf: string;
  round2: (n: number) => number;
  getConfigFx: (cc: string) => number;
  /**
   * Load only the container context (locked rates and containers) the
   * inventory valuations need. The factory net position takes its supplier
   * figures from the balance engine (wave 10); the balance part below is the
   * Suppliers-page formula and is kept for comparison callers.
   */
  contextOnly?: boolean;
}

export interface NetPositionSupplierBalances {
  supplierLockedRateMapNp: Map<number, number>;
  allContainersF: (typeof factoryContainers.$inferSelect)[];
  supplierItems: { name: string; balanceUsd: number; breakdown?: { label: string; native: string; usd: number }[] }[];
  totalSupplierLiabilities: number;
  totalSupplierOverpayments: number;
}

export async function computeNetPositionSupplierBalances(
  ctx: NetPositionSupplierContext
): Promise<NetPositionSupplierBalances> {
  // ── 1. Factory supplier balances (What We Owe) ──────────────────────
  const suppliersList = await db
    .select()
    .from(factorySuppliers)
    .where(eq(factorySuppliers.companyId, ctx.companyId))
    .orderBy(factorySuppliers.name);

  // Authoritative locked rate (USD) per supplier — same map rawStockReceiptRoutes.ts
  // builds, so "Factory Raw Material Stock" here can never disagree with the Raw
  // Materials page's "Stock Value". Never recompute a rate from receipt history.
  // Wave 11: only a persisted locked rate. The legacy receipt-weighted fallback
  // (getLockedSupplierRate) can carry a native-currency cost and wrote the rate
  // from this read; a supplier with no locked rate is valued per container at
  // its landed USD cost (./netPositionInventory).
  const supplierLockedRateMapNp = new Map<number, number>();
  for (const s of suppliersList) {
    const persisted = s.currentRawMaterialCostPerKgUsd;
    if (persisted !== null && persisted !== undefined) {
      supplierLockedRateMapNp.set(s.id, toMoney(persisted as string).toNumber());
    }
  }

  const allContainersF = await db
    .select()
    .from(factoryContainers)
    .where(
      and(
        eq(factoryContainers.companyId, ctx.companyId),
        isNull(factoryContainers.deletedAt),
        sql`DATE(${factoryContainers.createdAt}) <= ${ctx.asOf}::date`
      )
    );

  if (ctx.contextOnly) {
    return {
      supplierLockedRateMapNp,
      allContainersF,
      supplierItems: [],
      totalSupplierLiabilities: 0,
      totalSupplierOverpayments: 0,
    };
  }

  const allPaymentsF = await db
    .select()
    .from(factorySupplierPayments)
    .where(and(eq(factorySupplierPayments.companyId, ctx.companyId), lte(factorySupplierPayments.date, ctx.asOf)));

  const allFxTransfersF = await db
    .select()
    .from(factorySupplierFxTransfers)
    .where(
      and(eq(factorySupplierFxTransfers.companyId, ctx.companyId), lte(factorySupplierFxTransfers.date, ctx.asOf))
    );

  // Column-level other charges (otherCharges / otherChargesSupplierId on
  // containers), consumed by the standalone-supplier loop below.
  const allColOtherChargesF = await db
    .select({
      otherChargesSupplierId: factoryContainers.otherChargesSupplierId,
      otherCharges: factoryContainers.otherCharges,
      otherChargesCurrencyCode: factoryContainers.otherChargesCurrencyCode,
    })
    .from(factoryContainers)
    .where(
      and(
        eq(factoryContainers.companyId, ctx.companyId),
        isNull(factoryContainers.deletedAt),
        sql`${factoryContainers.otherChargesSupplierId} IS NOT NULL`,
        sql`CAST(COALESCE(${factoryContainers.otherCharges}, '0') AS numeric) > 0`,
        sql`DATE(${factoryContainers.createdAt}) <= ${ctx.asOf}::date`
      )
    );

  // Voucher-based payments (exclude auto-generated FACTORY-PAY-* and optional vouchers)
  const allSupplierIds = suppliersList.map((s) => s.id);
  // Per-currency voucher amounts, netted off each standalone supplier below.
  const voucherPaidByCurrencyBySupplierId: Record<number, Record<string, Decimal>> = {};
  if (allSupplierIds.length > 0) {
    const voucherRows = await db
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
          eq(vouchers.companyId, ctx.companyId),
          eq(vouchers.optional, false),
          isNull(vouchers.deletedAt),
          sql`${voucherEntries.debitAmount}::numeric > 0`,
          sql`${vouchers.voucherNumber} NOT LIKE 'FACTORY-PAY-%'`,
          sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) <= ${ctx.asOf}`
        )
      );
    for (const row of voucherRows) {
      const sid = row.factorySupplierId;
      if (!sid) continue;
      if (row.optional) continue; // optional vouchers don't affect the balance
      // Bucketed in the entry's own currency. A normalized entry carries its
      // native amount and rate; only a legacy one depends on the voucher's rate.
      const native = entryNativeAmounts(row);
      const amt = native.debit;
      const cc = native.currency;
      if (cc !== "USD" && !isNormalizedEntry(row)) {
        // vouchers.exchangeRate has no fxRateConfirmed column yet — legacy heuristic stopgap.
        const { looksSet } = resolveStoredFxRate(cc, row.exchangeRate);
        // Exclude this payment from the total rather than guess at a rate of 1.
        if (!looksSet) continue;
      }
      if (!voucherPaidByCurrencyBySupplierId[sid]) voucherPaidByCurrencyBySupplierId[sid] = {};
      voucherPaidByCurrencyBySupplierId[sid][cc] = (voucherPaidByCurrencyBySupplierId[sid][cc] ?? toMoney(0)).plus(amt);
    }
  }

  // Identify brokers (suppliers that have children linked via parentId)
  // and linked suppliers (those with parentId set pointing to a broker)
  const brokerIds = new Set<number>();
  const linkedSupplierParent = new Map<number, number>(); // childId → brokerId
  for (const s of suppliersList) {
    if (s.parentId) {
      linkedSupplierParent.set(s.id, s.parentId);
      brokerIds.add(s.parentId);
    }
  }

  const supplierItems: {
    name: string;
    balanceUsd: number;
    breakdown?: { label: string; native: string; usd: number }[];
  }[] = [];
  let totalSupplierLiabilities = 0;
  let totalSupplierOverpayments = 0;

  // Track which broker entries have already been added (avoid duplicates)
  const processedBrokers = new Set<number>();

  for (const s of suppliersList) {
    // Linked suppliers: their balances are rolled into their parent broker — skip individually
    if (linkedSupplierParent.has(s.id)) continue;

    // Brokers: use buildBrokerStatement (same function as Suppliers page) for exact parity
    if (brokerIds.has(s.id) && !processedBrokers.has(s.id)) {
      processedBrokers.add(s.id);
      const stmt = await buildBrokerStatement(s.id, ctx.companyId, true);
      if (!stmt) continue;
      let brokerUsd = new MoneyDecimal(0);
      for (const ledger of stmt.currencyLedgers) {
        const cc = ledger.currencyCode as string;
        const bal = toMoney(ledger.netBalance);
        brokerUsd = brokerUsd.plus(cc === "USD" ? bal : bal.times(ctx.getConfigFx(cc)));
      }
      const rounded = ctx.round2(brokerUsd.toNumber());
      if (Math.abs(rounded) > 0.01) {
        supplierItems.push({ name: s.name, balanceUsd: rounded });
        if (rounded > 0) totalSupplierLiabilities += rounded;
        else totalSupplierOverpayments += Math.abs(rounded);
      }
      continue;
    }

    // Standalone (non-broker) suppliers: native-bucket approach — exact match to
    // computeStats / Suppliers page. Accumulate all transactions in their native
    // currency, multiply each bucket by the configured rate once at the end.
    const byCurrencyNative: Record<string, Decimal> = {};
    const addNative = (cc: string, amt: Decimal) => {
      byCurrencyNative[cc] = (byCurrencyNative[cc] ?? new MoneyDecimal(0)).plus(amt);
    };

    // Opening balance (always USD-denominated)
    const ob = toMoney(s.openingBalance);
    if (!ob.isZero()) addNative("USD", ob);

    // Containers: goods + supplier-paid freight + commission (native currency each).
    // Own-account freight must never increase the supplier liability; use the same
    // authoritative helper as the Suppliers page / supplier statements so the two
    // views cannot disagree for standalone suppliers.
    const sc = allContainersF.filter((c) => c.supplierId === s.id);
    for (const c of sc) {
      const cc = c.currencyCode || "USD";
      addNative(cc, toMoney(c.totalKg).times(toMoney(c.ratePerKg)));
      const freight = isSupplierPaidFreight(c) ? toMoney(c.freight) : new MoneyDecimal(0);
      if (freight.greaterThan(0)) {
        const fcc = c.freightCurrencyCode || cc;
        addNative(fcc, freight);
      }
      const commAmt = toMoney(c.commissionAmount);
      if (commAmt.greaterThan(0)) {
        const commCc = c.commissionCurrencyCode || cc;
        addNative(commCc, commAmt);
      }
    }

    // Column-level other charges (otherCharges / otherChargesSupplierId on containers)
    for (const oc of allColOtherChargesF) {
      if (oc.otherChargesSupplierId !== s.id) continue;
      const ocAmt = toMoney(oc.otherCharges);
      if (ocAmt.lessThanOrEqualTo(0)) continue;
      addNative(oc.otherChargesCurrencyCode || "USD", ocAmt);
    }

    // Direct payments — use native amount (p.amount), not p.amountUsd
    for (const p of allPaymentsF) {
      if (p.supplierId !== s.id) continue;
      addNative(p.currencyCode || "USD", toMoney(p.amount).negated());
    }

    // Voucher payments — native amounts per currency
    const voucherCurrMap = voucherPaidByCurrencyBySupplierId[s.id] || {};
    for (const [cc, amt] of Object.entries(voucherCurrMap)) {
      addNative(cc, amt.negated());
    }

    // FX transfers — subtract native from-currency, credit USD to USD bucket
    for (const t of allFxTransfersF) {
      if (t.fromSupplierId === s.id) {
        addNative(t.fromCurrencyCode || "USD", toMoney(t.fromAmount).negated());
      }
      if (t.toSupplierId === s.id) {
        addNative("USD", toMoney(t.toAmountUsd));
      }
    }

    // Balance: each currency bucket × configured rate (same formula as computeStats)
    const balance = ctx.round2(
      Object.entries(byCurrencyNative)
        .reduce((sum, [cc, native]) => sum.plus(native.times(ctx.getConfigFx(cc))), new MoneyDecimal(0))
        .toNumber()
    );

    if (Math.abs(balance) > 0.01) {
      supplierItems.push({ name: s.name, balanceUsd: balance });
      if (balance > 0) totalSupplierLiabilities += balance;
      else totalSupplierOverpayments += Math.abs(balance);
    }
  }

  return {
    supplierLockedRateMapNp,
    allContainersF,
    supplierItems,
    totalSupplierLiabilities,
    totalSupplierOverpayments,
  };
}
