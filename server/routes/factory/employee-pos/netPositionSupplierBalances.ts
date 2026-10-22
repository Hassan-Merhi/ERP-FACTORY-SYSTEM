import { eq, and, sql, isNull } from "drizzle-orm";

import { factorySuppliers, factoryContainers } from "@shared/schema";

import { db } from "../../../db";
import { buildBrokerStatement } from "../suppliers/broker";
import { loadSupplierSettlementBalances } from "../suppliers/balance/settlementPools";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { netPositionRecordedThrough } from "../../../services/factory/netPositionAsOf";

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
        supplierItems.push({ name: s.name, balanceUsd: rounded });
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
