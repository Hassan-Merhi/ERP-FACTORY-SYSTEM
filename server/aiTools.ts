import { db } from "./db";
import * as schema from "@shared/schema";
import { eq, and, desc, sql, isNull, ilike, or, gte, inArray } from "drizzle-orm";
import { toMoney } from "./lib/money";

export async function searchStockItems(companyId: number, query: string, limit = 20) {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const nameConditions = terms.map((t) => ilike(schema.stockItems.name, `%${t}%`));
  const codeConditions = terms.map((t) => ilike(schema.stockItems.code, `%${t}%`));
  const searchCondition = or(...nameConditions, ...codeConditions);

  const rows = await db
    .select({
      id: schema.stockItems.id,
      code: schema.stockItems.code,
      name: schema.stockItems.name,
      sellingPrice: schema.stockItems.sellingPrice,
      reorderLevel: schema.stockItems.reorderLevel,
    })
    .from(schema.stockItems)
    .where(
      and(
        eq(schema.stockItems.companyId, companyId),
        eq(schema.stockItems.active, true),
        isNull(schema.stockItems.deletedAt),
        searchCondition
      )
    )
    .limit(limit);

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const invRows = await db
    .select({
      stockItemId: schema.inventory.stockItemId,
      totalQty: sql<string>`COALESCE(SUM(CAST(${schema.inventory.quantity} AS NUMERIC)), 0)`,
      totalValue: sql<string>`COALESCE(SUM(CAST(${schema.inventory.totalValue} AS NUMERIC)), 0)`,
      avgRate: sql<string>`COALESCE(AVG(NULLIF(CAST(${schema.inventory.averageRate} AS NUMERIC), 0)), 0)`,
    })
    .from(schema.inventory)
    .where(and(eq(schema.inventory.companyId, companyId), inArray(schema.inventory.stockItemId, ids)))
    .groupBy(schema.inventory.stockItemId);

  const invMap = new Map(invRows.map((i) => [i.stockItemId, i]));

  return rows.map((item) => {
    const inv = invMap.get(item.id);
    const sellPrice = toMoney(item.sellingPrice).toNumber();
    const avgCost = toMoney(inv?.avgRate).toNumber();
    const totalQty = toMoney(inv?.totalQty).toNumber();
    return {
      id: item.id,
      code: item.code || "",
      name: item.name,
      sellingPrice: sellPrice.toFixed(2),
      avgCost: avgCost.toFixed(2),
      reorderLevel: toMoney(item.reorderLevel).toFixed(2),
      totalQty: totalQty.toFixed(3),
      totalValue: toMoney(inv?.totalValue).toFixed(2),
      pricingStatus:
        avgCost > 0
          ? sellPrice < avgCost
            ? "LOSING"
            : sellPrice === avgCost
              ? "BREAK_EVEN"
              : "PROFITABLE"
          : "UNKNOWN",
    };
  });
}

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

export async function searchVouchers(companyId: number, query: string, limit = 20) {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const conditions = terms.map((t) =>
    or(ilike(schema.vouchers.description, `%${t}%`), ilike(schema.vouchers.voucherNumber, `%${t}%`))
  );

  const rows = await db
    .select({
      id: schema.vouchers.id,
      voucherNumber: schema.vouchers.voucherNumber,
      voucherType: schema.vouchers.voucherType,
      voucherDate: schema.vouchers.voucherDate,
      totalAmount: schema.vouchers.totalAmount,
      description: schema.vouchers.description,
    })
    .from(schema.vouchers)
    .where(and(eq(schema.vouchers.companyId, companyId), isNull(schema.vouchers.deletedAt), or(...conditions)))
    .orderBy(desc(schema.vouchers.voucherDate))
    .limit(limit);

  return rows.map((v) => ({
    id: v.id,
    number: v.voucherNumber,
    type: v.voucherType,
    date: v.voucherDate,
    amount: toMoney(v.totalAmount).toFixed(2),
    description: v.description || "",
  }));
}

export async function getLowStockItems(companyId: number, limit = 20) {
  const [items, invRows] = await Promise.all([
    db
      .select({
        id: schema.stockItems.id,
        code: schema.stockItems.code,
        name: schema.stockItems.name,
        reorderLevel: schema.stockItems.reorderLevel,
      })
      .from(schema.stockItems)
      .where(
        and(
          eq(schema.stockItems.companyId, companyId),
          eq(schema.stockItems.active, true),
          isNull(schema.stockItems.deletedAt),
          sql`CAST(${schema.stockItems.reorderLevel} AS NUMERIC) > 0`
        )
      ),

    db
      .select({
        stockItemId: schema.inventory.stockItemId,
        totalQty: sql<string>`COALESCE(SUM(CAST(${schema.inventory.quantity} AS NUMERIC)), 0)`,
      })
      .from(schema.inventory)
      .where(eq(schema.inventory.companyId, companyId))
      .groupBy(schema.inventory.stockItemId),
  ]);

  const invMap = new Map(invRows.map((i) => [i.stockItemId, toMoney(i.totalQty).toNumber()]));

  return items
    .map((item) => {
      const qty = invMap.get(item.id) ?? 0;
      const reorder = toMoney(item.reorderLevel).toNumber();
      return { id: item.id, code: item.code || "", name: item.name, qty, reorderLevel: reorder };
    })
    .filter((item) => item.qty <= item.reorderLevel)
    .sort((a, b) => a.qty - b.qty)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      code: item.code,
      name: item.name,
      qty: item.qty.toFixed(3),
      reorderLevel: item.reorderLevel.toFixed(2),
      status: item.qty === 0 ? "OUT_OF_STOCK" : "LOW_STOCK",
    }));
}

export async function getPricingHealth(companyId: number, limit = 20) {
  const [items, invRows] = await Promise.all([
    db
      .select({
        id: schema.stockItems.id,
        code: schema.stockItems.code,
        name: schema.stockItems.name,
        sellingPrice: schema.stockItems.sellingPrice,
      })
      .from(schema.stockItems)
      .where(
        and(
          eq(schema.stockItems.companyId, companyId),
          eq(schema.stockItems.active, true),
          isNull(schema.stockItems.deletedAt)
        )
      ),

    db
      .select({
        stockItemId: schema.inventory.stockItemId,
        totalQty: sql<string>`COALESCE(SUM(CAST(${schema.inventory.quantity} AS NUMERIC)), 0)`,
        avgRate: sql<string>`COALESCE(AVG(NULLIF(CAST(${schema.inventory.averageRate} AS NUMERIC), 0)), 0)`,
        totalValue: sql<string>`COALESCE(SUM(CAST(${schema.inventory.totalValue} AS NUMERIC)), 0)`,
      })
      .from(schema.inventory)
      .where(eq(schema.inventory.companyId, companyId))
      .groupBy(schema.inventory.stockItemId),
  ]);

  const invMap = new Map(invRows.map((i) => [i.stockItemId, i]));

  return items
    .map((item) => {
      const inv = invMap.get(item.id);
      const avgCost = toMoney(inv?.avgRate).toNumber();
      const sellPrice = toMoney(item.sellingPrice).toNumber();
      const qty = toMoney(inv?.totalQty).toNumber();
      const gap = sellPrice - avgCost;
      return {
        id: item.id,
        code: item.code || "",
        name: item.name,
        sellingPrice: sellPrice.toFixed(2),
        avgCost: avgCost.toFixed(2),
        priceGap: gap.toFixed(2),
        qty: qty.toFixed(3),
        totalValue: toMoney(inv?.totalValue).toFixed(2),
        status: gap < 0 ? "LOSING" : gap === 0 ? "BREAK_EVEN" : "PROFITABLE",
        potentialLoss: qty > 0 && gap < 0 ? (Math.abs(gap) * qty).toFixed(2) : "0",
      };
    })
    .filter((item) => toMoney(item.avgCost).toNumber() > 0)
    .sort((a, b) => toMoney(a.priceGap).minus(toMoney(b.priceGap)).toNumber())
    .slice(0, limit);
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
      profit: schema.salesItems.profit,
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
    profit: sql<string>`COALESCE(SUM(CAST(${schema.salesItems.profit} AS NUMERIC)), 0)`,
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
        totalProfit: sql<string>`SUM(CAST(${schema.salesItems.profit} AS NUMERIC))`,
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
