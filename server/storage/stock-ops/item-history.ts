import { eq, and, sql } from "drizzle-orm";
import { db, pool, type RawQueryRow } from "../../db";
import * as schema from "@shared/schema";

export async function getLastPurchaseOrderForItem(stockItemId: number, companyId: number) {
  const result = await db
    .select({
      poNumber: schema.purchaseOrders.poNumber,
      poDate: schema.purchaseOrders.createdAt,
      supplierName: schema.suppliers.legalName,
      quantity: schema.poLineItems.quantity,
      rate: schema.poLineItems.rate,
      amount: schema.poLineItems.lineTotal,
    })
    .from(schema.poLineItems)
    .innerJoin(schema.purchaseOrders, eq(schema.poLineItems.poId, schema.purchaseOrders.id))
    .innerJoin(schema.suppliers, eq(schema.purchaseOrders.supplierId, schema.suppliers.id))
    .where(and(eq(schema.poLineItems.stockItemId, stockItemId), eq(schema.purchaseOrders.companyId, companyId)))
    .orderBy(sql`${schema.purchaseOrders.createdAt} DESC`)
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getLastSaleForItem(stockItemId: number, companyId: number) {
  const result = await db
    .select({
      voucherNumber: schema.vouchers.voucherNumber,
      saleDate: schema.vouchers.voucherDate,
      locationName: schema.locations.name,
      quantity: schema.salesItems.quantity,
      sellingPrice: schema.salesItems.sellingPrice,
      totalSales: schema.salesItems.totalSales,
    })
    .from(schema.salesItems)
    .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
    .leftJoin(schema.locations, eq(schema.vouchers.locationId, schema.locations.id))
    .where(and(eq(schema.salesItems.stockItemId, stockItemId), eq(schema.vouchers.companyId, companyId)))
    .orderBy(sql`${schema.vouchers.voucherDate} DESC`)
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getLastSoldPrices(companyId: number): Promise<Record<number, string>> {
  const result = await pool.query(
    `
    SELECT DISTINCT ON (si.stock_item_id)
      si.stock_item_id,
      si.selling_price
    FROM sales_items si
    INNER JOIN vouchers v ON si.voucher_id = v.id
    WHERE v.company_id = $1
    ORDER BY si.stock_item_id, v.voucher_date DESC, si.created_at DESC
  `,
    [companyId]
  );
  const priceMap: Record<number, string> = {};
  for (const row of result.rows) {
    priceMap[row.stock_item_id] = row.selling_price;
  }
  return priceMap;
}

export async function getAllPurchasesForItem(
  stockItemId: number,
  companyId: number,
  fromDate?: string,
  toDate?: string
) {
  const conditions = [
    eq(schema.poLineItems.stockItemId, stockItemId),
    eq(schema.purchaseOrders.companyId, companyId),
    sql`(${schema.purchaseOrders.containerId} IS NULL OR ${schema.containers.status} NOT IN ('OFFLOADED', 'SOLD'))`,
  ];
  if (fromDate) conditions.push(sql`${schema.purchaseOrders.createdAt}::date >= ${fromDate}::date`);
  if (toDate) conditions.push(sql`${schema.purchaseOrders.createdAt}::date <= ${toDate}::date`);

  return await db
    .select({
      poNumber: schema.purchaseOrders.poNumber,
      poDate: schema.purchaseOrders.createdAt,
      supplierName: schema.suppliers.legalName,
      containerNumber: schema.containers.containerNumber,
      quantity: schema.poLineItems.quantity,
      rate: schema.poLineItems.rate,
      amount: schema.poLineItems.lineTotal,
    })
    .from(schema.poLineItems)
    .innerJoin(schema.purchaseOrders, eq(schema.poLineItems.poId, schema.purchaseOrders.id))
    .innerJoin(schema.suppliers, eq(schema.purchaseOrders.supplierId, schema.suppliers.id))
    .leftJoin(schema.containers, eq(schema.purchaseOrders.containerId, schema.containers.id))
    .where(and(...conditions))
    .orderBy(sql`${schema.purchaseOrders.createdAt} DESC`);
}

export async function getAllSalesForItem(stockItemId: number, companyId: number, fromDate?: string, toDate?: string) {
  const conditions = [
    eq(schema.salesItems.stockItemId, stockItemId),
    eq(schema.vouchers.companyId, companyId),
    eq(schema.vouchers.optional, false),
  ];
  if (fromDate) conditions.push(sql`${schema.vouchers.voucherDate}::date >= ${fromDate}::date`);
  if (toDate) conditions.push(sql`${schema.vouchers.voucherDate}::date <= ${toDate}::date`);

  return await db
    .select({
      voucherId: schema.vouchers.id,
      voucherNumber: schema.vouchers.voucherNumber,
      saleDate: schema.vouchers.voucherDate,
      locationName: schema.locations.name,
      quantity: schema.salesItems.quantity,
      sellingPrice: schema.salesItems.sellingPrice,
      totalSales: schema.salesItems.totalSales,
      posStation: schema.vouchers.shiftId,
    })
    .from(schema.salesItems)
    .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
    .leftJoin(schema.locations, eq(schema.vouchers.locationId, schema.locations.id))
    .where(and(...conditions))
    .orderBy(sql`${schema.vouchers.voucherDate} DESC`);
}

/**
 * One row of the per-location inventory projection. The numeric columns are
 * `decimal`, which the driver returns as strings, so they are declared that way
 * rather than being assumed to be numbers by whoever consumes the result.
 */
export interface InventoryLocationRow {
  locationId: number;
  locationName: string;
  locationCode: string;
  quantity: string;
  averageRate: string;
  totalValue: string;
}

export async function getInventoryLocationsByItem(
  stockItemId: number,
  companyId: number
): Promise<InventoryLocationRow[]> {
  const results = await db.execute<RawQueryRow<InventoryLocationRow>>(sql`
    SELECT DISTINCT ON (i.location_id)
      i.location_id as "locationId",
      l.name as "locationName",
      l.code as "locationCode",
      i.quantity,
      i.average_rate as "averageRate",
      i.total_value as "totalValue"
    FROM inventory i
    INNER JOIN locations l ON i.location_id = l.id
    WHERE i.stock_item_id = ${stockItemId}
      AND l.company_id = ${companyId}
      AND i.quantity::numeric > 0
    ORDER BY i.location_id, i.last_updated DESC
  `);
  return [...results.rows].sort((a, b) => (a.locationName || "").localeCompare(b.locationName || ""));
}

export async function getVoucherHistoryForItem(stockItemId: number, companyId: number) {
  const sales = await db
    .select({
      voucherId: schema.vouchers.id,
      voucherNumber: schema.vouchers.voucherNumber,
      voucherType: schema.vouchers.voucherType,
      voucherDate: schema.vouchers.voucherDate,
      locationId: schema.vouchers.locationId,
      locationName: schema.locations.name,
      locationCode: schema.locations.code,
      quantityOut: schema.salesItems.quantity,
      quantityIn: sql<string>`'0'`,
      rate: schema.salesItems.sellingPrice,
      amount: schema.salesItems.totalSales,
    })
    .from(schema.salesItems)
    .innerJoin(schema.vouchers, eq(schema.salesItems.voucherId, schema.vouchers.id))
    .leftJoin(schema.locations, eq(schema.vouchers.locationId, schema.locations.id))
    .where(
      and(
        eq(schema.salesItems.stockItemId, stockItemId),
        eq(schema.vouchers.companyId, companyId),
        eq(schema.vouchers.optional, false)
      )
    );

  const transfersOut = await db
    .select({
      voucherId: schema.vouchers.id,
      voucherNumber: schema.vouchers.voucherNumber,
      voucherType: schema.vouchers.voucherType,
      voucherDate: schema.vouchers.voucherDate,
      locationId: schema.stockTransferItems.sourceLocationId,
      locationName: schema.locations.name,
      locationCode: schema.locations.code,
      quantityOut: schema.stockTransferItems.quantity,
      quantityIn: sql<string>`'0'`,
      rate: schema.stockTransferItems.rate,
      amount: sql<string>`(${schema.stockTransferItems.quantity}::numeric * ${schema.stockTransferItems.rate}::numeric)::text`,
    })
    .from(schema.stockTransferItems)
    .innerJoin(schema.stockTransferVouchers, eq(schema.stockTransferItems.transferId, schema.stockTransferVouchers.id))
    .innerJoin(schema.vouchers, eq(schema.stockTransferVouchers.voucherId, schema.vouchers.id))
    .leftJoin(schema.locations, eq(schema.stockTransferItems.sourceLocationId, schema.locations.id))
    .where(
      and(
        eq(schema.stockTransferItems.stockItemId, stockItemId),
        eq(schema.vouchers.companyId, companyId),
        eq(schema.vouchers.optional, false)
      )
    );

  const transfersIn = await db
    .select({
      voucherId: schema.vouchers.id,
      voucherNumber: schema.vouchers.voucherNumber,
      voucherType: schema.vouchers.voucherType,
      voucherDate: schema.vouchers.voucherDate,
      locationId: schema.stockTransferVouchers.destinationLocationId,
      locationName: schema.locations.name,
      locationCode: schema.locations.code,
      quantityOut: sql<string>`'0'`,
      quantityIn: schema.stockTransferItems.quantity,
      rate: schema.stockTransferItems.rate,
      amount: sql<string>`(${schema.stockTransferItems.quantity}::numeric * ${schema.stockTransferItems.rate}::numeric)::text`,
    })
    .from(schema.stockTransferItems)
    .innerJoin(schema.stockTransferVouchers, eq(schema.stockTransferItems.transferId, schema.stockTransferVouchers.id))
    .innerJoin(schema.vouchers, eq(schema.stockTransferVouchers.voucherId, schema.vouchers.id))
    .leftJoin(schema.locations, eq(schema.stockTransferVouchers.destinationLocationId, schema.locations.id))
    .where(
      and(
        eq(schema.stockTransferItems.stockItemId, stockItemId),
        eq(schema.vouchers.companyId, companyId),
        eq(schema.vouchers.optional, false)
      )
    );

  const adjustments = await db
    .select({
      voucherId: schema.vouchers.id,
      voucherNumber: schema.vouchers.voucherNumber,
      voucherType: schema.vouchers.voucherType,
      voucherDate: schema.vouchers.voucherDate,
      locationId: schema.stockAdjustmentVouchers.locationId,
      locationName: schema.locations.name,
      locationCode: schema.locations.code,
      quantityOut: sql<string>`CASE WHEN ${schema.stockAdjustmentItems.quantity}::numeric < 0 THEN ABS(${schema.stockAdjustmentItems.quantity}::numeric)::text ELSE '0' END`,
      quantityIn: sql<string>`CASE WHEN ${schema.stockAdjustmentItems.quantity}::numeric > 0 THEN ${schema.stockAdjustmentItems.quantity} ELSE '0' END`,
      rate: schema.stockAdjustmentItems.rate,
      amount: sql<string>`(${schema.stockAdjustmentItems.quantity}::numeric * ${schema.stockAdjustmentItems.rate}::numeric)::text`,
    })
    .from(schema.stockAdjustmentItems)
    .innerJoin(
      schema.stockAdjustmentVouchers,
      eq(schema.stockAdjustmentItems.adjustmentId, schema.stockAdjustmentVouchers.id)
    )
    .innerJoin(schema.vouchers, eq(schema.stockAdjustmentVouchers.voucherId, schema.vouchers.id))
    .leftJoin(schema.locations, eq(schema.stockAdjustmentVouchers.locationId, schema.locations.id))
    .where(
      and(
        eq(schema.stockAdjustmentItems.stockItemId, stockItemId),
        eq(schema.vouchers.companyId, companyId),
        eq(schema.vouchers.optional, false)
      )
    );

  const allTransactions = [...sales, ...transfersOut, ...transfersIn, ...adjustments];
  allTransactions.sort((a, b) => new Date(b.voucherDate).getTime() - new Date(a.voucherDate).getTime());
  return allTransactions;
}

// ---------------------------------------------------------------------------
// Bulk Stock Item Operations
// ---------------------------------------------------------------------------
