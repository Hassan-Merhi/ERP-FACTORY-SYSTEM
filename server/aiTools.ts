import { db } from "./db";
import * as schema from "@shared/schema";
import { eq, and, desc, sql, isNull, ilike, or, gte, inArray } from "drizzle-orm";
import { toMoney } from "./lib/money";
export { searchStockItems, searchVouchers, getLowStockItems, getPricingHealth } from "./aiToolsHelpers";

export async function getStockByLocation(companyId: number, stockItemId: number) {
  const rows = await db
    .select({
      locationId: schema.inventory.locationId,
      quantity: schema.inventory.quantity,
      averageRate: schema.inventory.averageRate,
      totalValue: schema.inventory.totalValue,
    })
    .from(schema.inventory)
    .where(and(eq(schema.inventory.companyId, companyId), eq(schema.inventory.stockItemId, stockItemId)));

  const locationIds = rows.map((r) => r.locationId).filter((id): id is number => id != null);
  let locationMap = new Map<number, string>();
  if (locationIds.length > 0) {
    const locs = await db
      .select({ id: schema.locations.id, name: schema.locations.name, code: schema.locations.code })
      .from(schema.locations)
      .where(and(eq(schema.locations.companyId, companyId), inArray(schema.locations.id, locationIds)));
    locationMap = new Map(locs.map((l) => [l.id, `${l.name} (${l.code})`]));
  }

  return rows
    .map((r) => ({
      locationId: r.locationId,
      location: locationMap.get(r.locationId!) || "Unknown",
      quantity: toMoney(r.quantity).toFixed(3),
      avgCost: toMoney(r.averageRate).toFixed(2),
      totalValue: toMoney(r.totalValue).toFixed(2),
    }))
    .filter((r) => toMoney(r.quantity).toNumber() > 0);
}

export async function searchSuppliers(companyId: number, query: string, limit = 15) {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const conditions = terms.map((t) =>
    or(ilike(schema.suppliers.legalName, `%${t}%`), ilike(schema.suppliers.code, `%${t}%`))
  );

  const rows = await db
    .select({
      id: schema.suppliers.id,
      code: schema.suppliers.code,
      legalName: schema.suppliers.legalName,
      phone: schema.suppliers.phone,
      email: schema.suppliers.email,
      openingBalance: schema.suppliers.openingBalance,
    })
    .from(schema.suppliers)
    .where(and(eq(schema.suppliers.active, true), isNull(schema.suppliers.deletedAt), or(...conditions)))
    .limit(limit);

  return rows.map((s) => ({
    id: s.id,
    code: s.code || "",
    name: s.legalName || "Unknown",
    phone: s.phone || "",
    email: s.email || "",
    openingBalance: toMoney(s.openingBalance).toFixed(2),
  }));
}

export async function searchCustomers(companyId: number, query: string, limit = 15) {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const conditions = terms.map((t) =>
    or(ilike(schema.customers.legalName, `%${t}%`), ilike(schema.customers.code, `%${t}%`))
  );

  const rows = await db
    .select({
      id: schema.customers.id,
      code: schema.customers.code,
      legalName: schema.customers.legalName,
      phone: schema.customers.phone,
    })
    .from(schema.customers)
    .where(
      and(
        eq(schema.customers.companyId, companyId),
        eq(schema.customers.active, true),
        isNull(schema.customers.deletedAt),
        or(...conditions)
      )
    )
    .limit(limit);

  return rows.map((c) => ({
    id: c.id,
    code: c.code || "",
    name: c.legalName || "Unknown",
    phone: c.phone || "",
  }));
}

export async function searchLedgerAccounts(companyId: number, query: string, limit = 15) {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const conditions = terms.map((t) =>
    or(ilike(schema.ledgerAccounts.name, `%${t}%`), ilike(schema.ledgerAccounts.code, `%${t}%`))
  );

  const rows = await db
    .select({
      id: schema.ledgerAccounts.id,
      code: schema.ledgerAccounts.code,
      name: schema.ledgerAccounts.name,
      accountType: schema.ledgerAccounts.accountType,
      openingBalance: schema.ledgerAccounts.openingBalance,
      openingBalanceSide: schema.ledgerAccounts.openingBalanceSide,
    })
    .from(schema.ledgerAccounts)
    .where(
      and(
        eq(schema.ledgerAccounts.companyId, companyId),
        eq(schema.ledgerAccounts.active, true),
        isNull(schema.ledgerAccounts.deletedAt),
        or(...conditions)
      )
    )
    .limit(limit);

  return rows.map((a) => ({
    id: a.id,
    code: a.code || "",
    name: a.name,
    accountType: a.accountType,
    openingBalance: toMoney(a.openingBalance).toFixed(2),
    openingBalanceSide: a.openingBalanceSide || "Dr",
  }));
}

export async function getSalesForItem(companyId: number, stockItemId: number, limit = 20) {
  const rows = await db
    .select({
      voucherId: schema.salesItems.voucherId,
      voucherDate: schema.vouchers.voucherDate,
      voucherNumber: schema.vouchers.voucherNumber,
      quantity: schema.salesItems.quantity,
      sellingPrice: schema.salesItems.sellingPrice,
      costPrice: schema.salesItems.costPrice,
      totalSales: schema.salesItems.totalSales,
      profit: sql<string>`(${schema.salesItems.totalSales}::numeric - ${schema.salesItems.totalCost}::numeric)`,
    })
    .from(schema.salesItems)
    .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
    .where(
      and(
        eq(schema.vouchers.companyId, companyId),
        eq(schema.salesItems.stockItemId, stockItemId),
        isNull(schema.vouchers.deletedAt)
      )
    )
    .orderBy(desc(schema.vouchers.voucherDate))
    .limit(limit);

  return rows.map((r) => ({
    voucherNumber: r.voucherNumber,
    date: r.voucherDate,
    qty: toMoney(r.quantity).toFixed(3),
    sellingPrice: toMoney(r.sellingPrice).toFixed(2),
    costPrice: toMoney(r.costPrice).toFixed(2),
    totalSales: toMoney(r.totalSales).toFixed(2),
    profit: toMoney(r.profit).toFixed(2),
  }));
}

export async function getBusinessSummary(companyId: number) {
  const todayStr = new Date().toISOString().split("T")[0];
  const monthStartStr = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split("T")[0];

  const salesCols = {
    revenue: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC)), 0)`,
    cost: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.totalCost} AS NUMERIC)), 0)`,
    profit: sql<string>`COALESCE(SUM((CAST(${schema.salesItems.totalSales} AS NUMERIC) - CAST(${schema.salesItems.totalCost} AS NUMERIC))), 0)`,
    transactionCount: sql<number>`COUNT(DISTINCT ${schema.salesItems.voucherId})`,
    unitsSold: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.quantity} AS NUMERIC)), 0)`,
  };

  const [todayRaw, monthRaw, openPOs, topItems] = await Promise.all([
    db
      .select(salesCols)
      .from(schema.salesItems)
      .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
      .where(
        and(
          eq(schema.vouchers.companyId, companyId),
          eq(schema.vouchers.voucherDate, todayStr),
          isNull(schema.vouchers.deletedAt)
        )
      ),

    db
      .select(salesCols)
      .from(schema.salesItems)
      .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
      .where(
        and(
          eq(schema.vouchers.companyId, companyId),
          gte(schema.vouchers.voucherDate, monthStartStr),
          isNull(schema.vouchers.deletedAt)
        )
      ),

    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(schema.purchaseOrders)
      .where(and(eq(schema.purchaseOrders.companyId, companyId), eq(schema.purchaseOrders.status, "Open"))),

    db
      .select({
        stockItemId: schema.salesItems.stockItemId,
        itemName: schema.stockItems.name,
        itemCode: schema.stockItems.code,
        totalRevenue: sql<string>`SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC))`,
        totalProfit: sql<string>`SUM((CAST(${schema.salesItems.totalSales} AS NUMERIC) - CAST(${schema.salesItems.totalCost} AS NUMERIC)))`,
        totalQty: sql<string>`SUM(CAST(${schema.salesItems.quantity} AS NUMERIC))`,
      })
      .from(schema.salesItems)
      .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
      .innerJoin(schema.stockItems, eq(schema.salesItems.stockItemId, schema.stockItems.id))
      .where(
        and(
          eq(schema.vouchers.companyId, companyId),
          gte(schema.vouchers.voucherDate, monthStartStr),
          isNull(schema.vouchers.deletedAt)
        )
      )
      .groupBy(schema.salesItems.stockItemId, schema.stockItems.name, schema.stockItems.code)
      .orderBy(desc(sql`SUM(CAST(${schema.salesItems.totalSales} AS NUMERIC))`))
      .limit(5),
  ]);

  function summarise(row: (typeof todayRaw)[0], label: string) {
    const rev = toMoney(row.revenue).toNumber();
    const prof = toMoney(row.profit).toNumber();
    return {
      label,
      revenue: rev.toFixed(2),
      cost: toMoney(row.cost).toFixed(2),
      profit: prof.toFixed(2),
      margin: rev > 0 ? ((prof / rev) * 100).toFixed(1) + "%" : "0%",
      transactions: row.transactionCount || 0,
      unitsSold: toMoney(row.unitsSold).toFixed(2),
    };
  }

  return {
    fetchedAt: new Date().toISOString(),
    today: { date: todayStr, ...summarise(todayRaw[0], "Today") },
    thisMonth: { monthStart: monthStartStr, ...summarise(monthRaw[0], "This Month") },
    openPurchaseOrders: openPOs[0]?.count || 0,
    topItemsThisMonth: topItems.map((i) => ({
      name: i.itemName || "Unknown",
      code: i.itemCode || "",
      revenue: toMoney(i.totalRevenue).toFixed(2),
      profit: toMoney(i.totalProfit).toFixed(2),
      qty: toMoney(i.totalQty).toFixed(2),
    })),
  };
}
