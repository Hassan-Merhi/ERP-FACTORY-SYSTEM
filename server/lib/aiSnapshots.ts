/**
 * AI Company Snapshots
 *
 * Precomputed, TTL-gated data blobs stored in ai_company_snapshots.
 * getOrBuildAISnapshot() serves the chatbot summaries without hitting the DB
 * on every message — it only recomputes when the snapshot is expired.
 *
 * Snapshot types and their default TTLs:
 *   business_summary   5 min   — today + month revenue/profit, top items, open POs
 *   inventory_summary  15 min  — total inv value, per-group breakdown
 *   sales_today        5 min   — today's sales only (subset of business_summary)
 *   sales_month        10 min  — this month's sales + top items
 *   supplier_balances  30 min  — payable balances per supplier
 *   pricing_health     30 min  — items selling at/below cost
 *   low_stock          10 min  — items at/below reorder level
 */

import { db } from "../db";
import { logger } from "./logger";
import { aiCompanySnapshots } from "@shared/schema";
import * as schema from "@shared/schema";
import { eq, and, sql, isNull, desc, inArray } from "drizzle-orm";
import { getBusinessSummary, getLowStockItems, getPricingHealth } from "../aiTools";
import { plusMoney, toMoney } from "./money";

// ── Default TTLs (seconds) per snapshot type ──────────────────────────────────
const DEFAULT_TTLS: Record<string, number> = {
  business_summary: 300,
  inventory_summary: 900,
  sales_today: 300,
  sales_month: 600,
  supplier_balances: 1800,
  pricing_health: 1800,
  low_stock: 600,
};

// ── Individual builders ───────────────────────────────────────────────────────

async function buildBusinessSummary(companyId: number) {
  return getBusinessSummary(companyId);
}

async function buildInventorySummary(companyId: number) {
  const [totals, byGroup] = await Promise.all([
    db
      .select({
        totalItems: sql<number>`COUNT(DISTINCT ${schema.inventory.stockItemId})`,
        totalValue: sql<string>`COALESCE(SUM(CAST(${schema.inventory.totalValue} AS NUMERIC)), 0)`,
        totalQty: sql<string>`COALESCE(SUM(CAST(${schema.inventory.quantity}   AS NUMERIC)), 0)`,
      })
      .from(schema.inventory)
      .where(eq(schema.inventory.companyId, companyId)),

    db
      .select({
        groupId: schema.stockGroups.id,
        groupName: schema.stockGroups.name,
        groupCode: schema.stockGroups.code,
        itemCount: sql<number>`COUNT(DISTINCT ${schema.stockItems.id})`,
        totalValue: sql<string>`COALESCE(SUM(CAST(${schema.inventory.totalValue} AS NUMERIC)), 0)`,
        totalQty: sql<string>`COALESCE(SUM(CAST(${schema.inventory.quantity}   AS NUMERIC)), 0)`,
      })
      .from(schema.stockGroups)
      .leftJoin(
        schema.stockItems,
        and(
          eq(schema.stockItems.stockGroupId, schema.stockGroups.id),
          eq(schema.stockItems.companyId, companyId),
          eq(schema.stockItems.active, true)
        )
      )
      .leftJoin(
        schema.inventory,
        and(eq(schema.inventory.stockItemId, schema.stockItems.id), eq(schema.inventory.companyId, companyId))
      )
      .where(eq(schema.stockGroups.companyId, companyId))
      .groupBy(schema.stockGroups.id, schema.stockGroups.name, schema.stockGroups.code)
      .orderBy(desc(sql`COALESCE(SUM(CAST(${schema.inventory.totalValue} AS NUMERIC)), 0)`)),
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    totalItems: totals[0]?.totalItems ?? 0,
    totalValue: toMoney(totals[0]?.totalValue).toFixed(2),
    totalQty: toMoney(totals[0]?.totalQty).toFixed(3),
    byGroup: byGroup.map((g) => ({
      groupId: g.groupId,
      groupName: g.groupName,
      groupCode: g.groupCode || "",
      itemCount: g.itemCount ?? 0,
      totalValue: toMoney(g.totalValue).toFixed(2),
      totalQty: toMoney(g.totalQty).toFixed(3),
    })),
  };
}

async function buildSalesToday(companyId: number) {
  const summary = await getBusinessSummary(companyId);
  return {
    fetchedAt: summary.fetchedAt,
    today: summary.today,
  };
}

async function buildSalesMonth(companyId: number) {
  const summary = await getBusinessSummary(companyId);
  return {
    fetchedAt: summary.fetchedAt,
    thisMonth: summary.thisMonth,
    topItemsThisMonth: summary.topItemsThisMonth,
    openPurchaseOrders: summary.openPurchaseOrders,
  };
}

async function buildSupplierBalances(companyId: number) {
  // All active suppliers are global (no companyId on suppliers table).
  // Company isolation is via the voucher entries (which belong to the company).
  const suppliers = await db
    .select({
      id: schema.suppliers.id,
      code: schema.suppliers.code,
      legalName: schema.suppliers.legalName,
      openingBalance: schema.suppliers.openingBalance,
    })
    .from(schema.suppliers)
    .where(eq(schema.suppliers.active, true));

  if (suppliers.length === 0) {
    return { fetchedAt: new Date().toISOString(), balances: [] };
  }

  const supplierIds = suppliers.map((s) => s.id);

  // One batch query for all voucher entries belonging to these suppliers
  const entries = await db
    .select({
      supplierId: schema.voucherEntries.supplierId,
      debitAmount: schema.voucherEntries.debitAmount,
      creditAmount: schema.voucherEntries.creditAmount,
    })
    .from(schema.voucherEntries)
    .innerJoin(schema.vouchers, eq(schema.voucherEntries.voucherId, schema.vouchers.id))
    .where(
      and(
        inArray(schema.voucherEntries.supplierId, supplierIds),
        eq(schema.vouchers.companyId, companyId),
        eq(schema.vouchers.optional, false),
        isNull(schema.vouchers.deletedAt)
      )
    );

  // Aggregate debit/credit per supplier in memory
  const entryTotals = new Map<number, { credit: number; debit: number }>();
  for (const e of entries) {
    if (e.supplierId == null) continue;
    const cur = entryTotals.get(e.supplierId) ?? { credit: 0, debit: 0 };
    cur.credit = plusMoney(cur.credit, e.creditAmount);
    cur.debit = plusMoney(cur.debit, e.debitAmount);
    entryTotals.set(e.supplierId, cur);
  }

  const balances = suppliers
    .map((s) => {
      const opening = toMoney(s.openingBalance).toNumber();
      const txn = entryTotals.get(s.id);
      const balance = opening + (txn ? txn.credit - txn.debit : 0);
      return {
        supplierId: s.id,
        supplierCode: s.code || "",
        supplierName: s.legalName || "Unknown",
        openingBalance: opening.toFixed(2),
        balance: balance.toFixed(2),
        status: balance > 0.01 ? "PAYABLE" : balance < -0.01 ? "OVERPAID" : "SETTLED",
      };
    })
    .filter((s) => Math.abs(toMoney(s.balance).toNumber()) > 0.01)
    .sort((a, b) => toMoney(b.balance).minus(toMoney(a.balance)).toNumber());

  return { fetchedAt: new Date().toISOString(), balances };
}

async function buildPricingHealth(companyId: number) {
  const items = await getPricingHealth(companyId, 30);
  return {
    fetchedAt: new Date().toISOString(),
    items,
    losingCount: items.filter((i) => i.status === "LOSING").length,
    profitableCount: items.filter((i) => i.status === "PROFITABLE").length,
    breakEvenCount: items.filter((i) => i.status === "BREAK_EVEN").length,
  };
}

async function buildLowStock(companyId: number) {
  const items = await getLowStockItems(companyId, 30);
  return {
    fetchedAt: new Date().toISOString(),
    items,
    outOfStockCount: items.filter((i) => i.status === "OUT_OF_STOCK").length,
    lowStockCount: items.filter((i) => i.status === "LOW_STOCK").length,
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────
const BUILDERS = {
  business_summary: buildBusinessSummary,
  inventory_summary: buildInventorySummary,
  sales_today: buildSalesToday,
  sales_month: buildSalesMonth,
  supplier_balances: buildSupplierBalances,
  pricing_health: buildPricingHealth,
  low_stock: buildLowStock,
};

export type AISnapshotType = keyof typeof BUILDERS;
export type AISnapshotData<T extends AISnapshotType> = Awaited<ReturnType<(typeof BUILDERS)[T]>>;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return a cached snapshot or compute + cache a fresh one.
 *
 * @param companyId    ERP company id
 * @param snapshotType one of the 7 defined types
 * @param ttlSeconds   override the default TTL for this type
 */
export async function getOrBuildAISnapshot<T extends AISnapshotType>(
  companyId: number,
  snapshotType: T,
  ttlSeconds?: number
): Promise<AISnapshotData<T>> {
  const ttl = ttlSeconds ?? DEFAULT_TTLS[snapshotType] ?? 300;
  const now = new Date();

  // 1. Try to serve from cache
  const [existing] = await db
    .select()
    .from(aiCompanySnapshots)
    .where(and(eq(aiCompanySnapshots.companyId, companyId), eq(aiCompanySnapshots.snapshotType, snapshotType)));

  if (existing && existing.expiresAt > now) {
    logger.info(
      `[AISnapshot] HIT  company=${companyId} type=${snapshotType}` +
        ` (expires in ${Math.round((existing.expiresAt.getTime() - now.getTime()) / 1000)}s)`
    );
    return existing.data as AISnapshotData<T>;
  }

  // 2. Build fresh data
  const builder = BUILDERS[snapshotType];
  if (!builder) throw new Error(`[AISnapshot] Unknown snapshot type: ${snapshotType}`);

  const t0 = Date.now();
  const data = await builder(companyId);
  logger.info(
    `[AISnapshot] MISS company=${companyId} type=${snapshotType}` + ` built in ${Date.now() - t0}ms, TTL=${ttl}s`
  );

  const expiresAt = new Date(now.getTime() + ttl * 1000);

  // 3. Upsert (one row per company+type)
  await db
    .insert(aiCompanySnapshots)
    .values({ companyId, snapshotType, data, calculatedAt: now, expiresAt })
    .onConflictDoUpdate({
      target: [aiCompanySnapshots.companyId, aiCompanySnapshots.snapshotType],
      set: { data, calculatedAt: now, expiresAt },
    });

  return data as AISnapshotData<T>;
}

/**
 * Expire one or more snapshot types for a company so the next chatbot request
 * rebuilds fresh data. Pass no types to expire all snapshots for the company.
 */
export async function invalidateAISnapshots(companyId: number, types?: string[]): Promise<void> {
  const past = new Date(0); // Unix epoch → always expired
  const where =
    types && types.length > 0
      ? and(eq(aiCompanySnapshots.companyId, companyId), inArray(aiCompanySnapshots.snapshotType, types))
      : eq(aiCompanySnapshots.companyId, companyId);

  await db.update(aiCompanySnapshots).set({ expiresAt: past }).where(where);
}
