import { eq, and, sql, isNull } from "drizzle-orm";

import { factorySuppliers, factoryContainers } from "@shared/schema";

import { db } from "../../../db";
import { buildBrokerStatement } from "../suppliers/broker";
import { loadSupplierSettlementBalances } from "../suppliers/balance/settlementPools";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { netPositionRecordedThrough } from "../../../services/factory/netPositionAsOf";
import { resolveStoredFxRate } from "../../../services/factory/currencyConversion";

/**
 * Section 1 of the factory net-position report: what the company owes its
 * suppliers.
 *
 * Brokers are settled through buildBrokerStatement so the figure matches the
 * Suppliers page exactly; standalone suppliers use the Settlement Statement's
 * currency pools (OTW included) converted once at the configured rate, which
 * is the Suppliers page card with "Include OTW" on. The block was self-contained inside the handler - it reads four values
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
  knownAt?: FactoryNetPositionAsOf;
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
  supplierItems: { supplierId?: number; name: string; balanceUsd: number; fxBasisAdjustmentUsd?: number; breakdown?: { label: string; native: string; usd: number }[] }[];
  totalSupplierLiabilities: number;
  totalSupplierOverpayments: number;
}

/**
 * Report presentation ONLY: reclassify a verified outstanding foreign payable
 * from its current-rate supplier row into historical supplier cost + FX gain/loss.
 * This delta is NEVER a separate asset, ledger posting, or an extra net-position
 * profit. The caller changes the supplier row by delta and adds the matching FX
 * line on the opposite side, leaving actual net position unchanged.
 *
 * Rates must be explicitly confirmed and identical for every source container
 * of that currency; mixed-rate/legacy sources are omitted rather than inventing
 * an unpaid-lot allocation. Settled, overpaid and OTW-only balances are omitted.
 */
export function supplierOpenPayableFxBasisAdjustment(input: {
  pools: readonly { currencyCode: string; balance: string }[];
  containers: readonly (typeof factoryContainers.$inferSelect)[];
  getConfigFx: (currency: string) => number;
  round2: (value: number) => number;
}): number {
  let delta = new MoneyDecimal(0);
  for (const pool of input.pools) {
    const currency = pool.currencyCode.trim().toUpperCase();
    const outstanding = toMoney(pool.balance);
    if (currency === "USD" || !outstanding.gt(0)) continue;

    const sources = input.containers.filter(
      (c) => (c.currencyCode || "USD").trim().toUpperCase() === currency &&
        toMoney(c.totalKg).times(toMoney(c.ratePerKg)).gt(0)
    );
    if (sources.length === 0 ||
      sources.some((c) => !["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"].includes(String(c.status ?? "").toUpperCase()))
    ) continue;

    const rates = sources.map((c) => {
      const r = resolveStoredFxRate(currency, c.fxRateToUsd, c.fxRateConfirmed ?? undefined);
      return r.looksSet ? toMoney(r.fxRate) : null;
    });
    const first = rates[0];
    if (!first || rates.some((r) => !r || !r.eq(first))) continue;

    // Round each side as displayed in the supplier balance. This also keeps
    // cents consistent (e.g., EUR 7,657.20 at 1.18 vs 1.12 is USD 459.44).
    const historicUsd = outstanding.times(first).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
    const currentUsd = outstanding
      .times(toMoney(input.getConfigFx(currency)))
      .toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
    delta = delta.plus(historicUsd.minus(currentUsd));
  }
  return input.round2(delta.toNumber());
}

export async function computeNetPositionSupplierBalances(
  ctx: NetPositionSupplierContext
): Promise<NetPositionSupplierBalances> {
  // ── 1. Factory supplier balances (What We Owe) ──────────────────────
  const suppliersList = await db
    .select()
    .from(factorySuppliers)
    .where(
      and(
        eq(factorySuppliers.companyId, ctx.companyId),
        ctx.knownAt
          ? netPositionRecordedThrough(sql`${factorySuppliers.createdAt}`, ctx.knownAt, "utc-naive-timestamp")
          : sql`TRUE`
      )
    )
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
        ctx.knownAt
          ? sql`(${factoryContainers.deletedAt} IS NULL OR NOT ${netPositionRecordedThrough(sql`${factoryContainers.deletedAt}`, ctx.knownAt, "utc-naive-timestamp")})`
          : isNull(factoryContainers.deletedAt),
        ctx.knownAt
          ? netPositionRecordedThrough(sql`${factoryContainers.createdAt}`, ctx.knownAt, "utc-naive-timestamp")
          : sql`DATE(${factoryContainers.createdAt}) <= ${ctx.asOf}::date`
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

  // Standalone suppliers: the inside Settlement Statement's currency pools with
  // OTW containers included, the same figures as the Suppliers page card with
  // "Include OTW" on. Each pool converts once at the Factory Settings rate.
  const settlementBySupplier = await loadSupplierSettlementBalances(ctx.companyId, {
    includeOtw: true,
    asOf: ctx.asOf,
    knownAt: ctx.knownAt,
    configuredFxRates: {},
  });

  // Brokers exactly as the Suppliers page identifies them (flagged broker or
  // has linked suppliers); linked suppliers roll into their broker.
  const brokerIds = new Set<number>();
  const linkedSupplierParent = new Map<number, number>(); // childId → brokerId
  for (const s of suppliersList) {
    if (s.isBroker) brokerIds.add(s.id);
    if (s.parentId) {
      linkedSupplierParent.set(s.id, s.parentId);
      brokerIds.add(s.parentId);
    }
  }

  const supplierItems: {
    supplierId?: number;
    name: string;
    balanceUsd: number;
    fxBasisAdjustmentUsd?: number;
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
      const stmt = await buildBrokerStatement(s.id, ctx.companyId, true, { asOf: ctx.asOf, knownAt: ctx.knownAt });
      if (!stmt) continue;
      let brokerUsd = new MoneyDecimal(0);
      for (const ledger of stmt.currencyLedgers) {
        const cc = ledger.currencyCode as string;
        const bal = toMoney(ledger.netBalance);
        brokerUsd = brokerUsd.plus(cc === "USD" ? bal : bal.times(ctx.getConfigFx(cc)));
      }
      const rounded = ctx.round2(brokerUsd.toNumber());
      if (Math.abs(rounded) > 0.01) {
        const fxBasisAdjustmentUsd = rounded > 0 && !ctx.knownAt
          ? supplierOpenPayableFxBasisAdjustment({
              pools: stmt.currencyLedgers.map((ledger) => ({
                currencyCode: String(ledger.currencyCode),
                balance: String(ledger.netBalance),
              })),
              containers: allContainersF.filter(
                (c) => c.supplierId === s.id || linkedSupplierParent.get(c.supplierId ?? -1) === s.id
              ),
              getConfigFx: ctx.getConfigFx,
              round2: ctx.round2,
            })
          : 0;
        supplierItems.push({
          supplierId: s.id,
          name: s.name,
          balanceUsd: rounded,
          ...(fxBasisAdjustmentUsd && rounded + fxBasisAdjustmentUsd > 0 ? { fxBasisAdjustmentUsd } : {}),
        });
        if (rounded > 0) totalSupplierLiabilities += rounded;
        else totalSupplierOverpayments += Math.abs(rounded);
      }
      continue;
    }

    // Standalone suppliers: USD + Σ(settlement pool × configured rate).
    const pools = settlementBySupplier.get(s.id)?.settlementBalances ?? [];
    const balance = ctx.round2(
      pools
        .reduce(
          (sum, pool) => sum.plus(toMoney(pool.balance).times(ctx.getConfigFx(pool.currencyCode))),
          new MoneyDecimal(0)
        )
        .toNumber()
    );

    if (Math.abs(balance) > 0.01) {
      const fxBasisAdjustmentUsd = balance > 0 && !ctx.knownAt
        ? supplierOpenPayableFxBasisAdjustment({
            pools,
            containers: allContainersF.filter((c) => c.supplierId === s.id),
            getConfigFx: ctx.getConfigFx,
            round2: ctx.round2,
          })
        : 0;
      supplierItems.push({
        supplierId: s.id,
        name: s.name,
        balanceUsd: balance,
        ...(fxBasisAdjustmentUsd && balance + fxBasisAdjustmentUsd > 0 ? { fxBasisAdjustmentUsd } : {}),
      });
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
