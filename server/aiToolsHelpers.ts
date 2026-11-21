// Extracted from ./aiTools.ts
import { db } from "./db";
import * as schema from "@shared/schema";
import { eq, and, desc, sql, isNull, ilike, or, inArray } from "drizzle-orm";
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
