import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import * as schema from "@shared/schema";

const uniqueIds = (values: Array<number | null | undefined>) => [
  ...new Set(values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)),
];

async function loadStockItemMap(ids: number[]) {
  if (ids.length === 0) return new Map<number, { code: string; name: string; uom: string }>();
  const rows = await db
    .select({
      id: schema.stockItems.id,
      code: schema.stockItems.code,
      name: schema.stockItems.name,
      uom: schema.stockItems.uom,
    })
    .from(schema.stockItems)
    .where(inArray(schema.stockItems.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

async function loadLocationMap(ids: number[]) {
  if (ids.length === 0) return new Map<number, string>();
  const rows = await db
    .select({ id: schema.locations.id, name: schema.locations.name })
    .from(schema.locations)
    .where(inArray(schema.locations.id, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function loadPurchaseData(voucherId: number, companyId: number) {
  const [purchaseOrder] = await db
    .select()
    .from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.companyId, companyId), eq(schema.purchaseOrders.voucherId, voucherId)))
    .limit(1);
  if (!purchaseOrder) return null;
  const items = await storage.getLineItemsByPO(purchaseOrder.id);
  return { ...purchaseOrder, items };
}

async function loadSalesData(voucherId: number, locationId: number | null | undefined) {
  const items = await db.select().from(schema.salesItems).where(eq(schema.salesItems.voucherId, voucherId));
  if (items.length === 0) return null;

  const itemIds = uniqueIds(items.map((item) => item.stockItemId));
  const [stockItemMap, locationPrices] = await Promise.all([
    loadStockItemMap(itemIds),
    locationId && itemIds.length > 0
      ? db
          .select({
            stockItemId: schema.stockItemLocationPrices.stockItemId,
            sellingPrice: schema.stockItemLocationPrices.sellingPrice,
          })
          .from(schema.stockItemLocationPrices)
          .where(
            and(
              inArray(schema.stockItemLocationPrices.stockItemId, itemIds),
              eq(schema.stockItemLocationPrices.locationId, locationId)
            )
          )
      : Promise.resolve([]),
  ]);
  const priceMap = new Map(locationPrices.map((row) => [row.stockItemId, row.sellingPrice]));

  return items.map((item) => {
    const stockItem = stockItemMap.get(item.stockItemId);
    const configuredPrice =
      item.configuredPrice && item.configuredPrice !== "0"
        ? item.configuredPrice
        : (priceMap.get(item.stockItemId) ?? "0");
    const quantity = Number.parseFloat(item.quantity || "0") || 0;
    const configuredPriceNumber = Number.parseFloat(configuredPrice || "0") || 0;
    const actualPrice = Number.parseFloat(item.sellingPrice || "0") || 0;
    const hassansProfit = (actualPrice - configuredPriceNumber) * quantity;
    const hassansTotal = configuredPriceNumber * quantity;
    const hassansPercentage = hassansTotal > 0 ? (hassansProfit / hassansTotal) * 100 : 0;
    return {
      ...item,
      stockItemCode: stockItem?.code || "",
      stockItemName: stockItem?.name || "",
      stockItemUom: stockItem?.uom || "",
      configuredPrice,
      hassansProfit: hassansProfit.toFixed(2),
      hassansTotal: hassansTotal.toFixed(2),
      hassansPercentage: hassansPercentage.toFixed(1),
    };
  });
}

async function loadAdjustmentData(voucher: {
  id: number;
  description: string | null;
  createdAt: Date;
  companyId: number;
  locationId: number | null;
  optional: boolean;
  exchangeRate: string | null;
  currency: string;
  effectiveDate: string | null;
  deletedAt: Date | null;
  locationName: string | null;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  totalAmount: string;
  shiftId: number | null;
  sourceModule: string | null;
  isCreditSale: boolean | null;
  clientSaleId: string | null;
}) {
  const [adjustment] = await db
    .select()
    .from(schema.stockAdjustmentVouchers)
    .where(eq(schema.stockAdjustmentVouchers.voucherId, voucher.id))
    .limit(1);
  if (!adjustment) {
    const adjustmentType =
      voucher.voucherType === "Consumption" ? "consumption" : voucher.voucherType === "Mixed" ? "mixed" : "production";
    return {
      id: 0,
      voucherId: voucher.id,
      locationId: voucher.locationId || 1,
      locationName: "",
      adjustmentType,
      notes: voucher.description || "",
      items: [],
      createdAt: new Date(),
    };
  }

  const items = await db
    .select()
    .from(schema.stockAdjustmentItems)
    .where(eq(schema.stockAdjustmentItems.adjustmentId, adjustment.id));
  const [stockItemMap, locationMap] = await Promise.all([
    loadStockItemMap(uniqueIds(items.map((item) => item.stockItemId))),
    loadLocationMap([adjustment.locationId]),
  ]);
  return {
    ...adjustment,
    locationName: locationMap.get(adjustment.locationId) || "",
    items: items.map((item) => {
      const stockItem = stockItemMap.get(item.stockItemId);
      return {
        ...item,
        stockItemCode: stockItem?.code || "",
        stockItemName: stockItem?.name || "",
        stockItemUom: stockItem?.uom || "",
      };
    }),
  };
}

async function loadTransferData(voucher: {
  id: number;
  description: string | null;
  createdAt: Date;
  companyId: number;
  locationId: number | null;
  optional: boolean;
  exchangeRate: string | null;
  currency: string;
  effectiveDate: string | null;
  deletedAt: Date | null;
  locationName: string | null;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  totalAmount: string;
  shiftId: number | null;
  sourceModule: string | null;
  isCreditSale: boolean | null;
  clientSaleId: string | null;
}) {
  const [transfer] = await db
    .select()
    .from(schema.stockTransferVouchers)
    .where(eq(schema.stockTransferVouchers.voucherId, voucher.id))
    .limit(1);
  if (!transfer) {
    return {
      id: 0,
      voucherId: voucher.id,
      sourceLocationId: voucher.locationId || 1,
      destinationLocationId: voucher.locationId || 1,
      sourceLocationName: "",
      destinationLocationName: "",
      notes: voucher.description || "",
      items: [],
      createdAt: new Date(),
    };
  }

  const items = await db
    .select()
    .from(schema.stockTransferItems)
    .where(eq(schema.stockTransferItems.transferId, transfer.id));
  const stockItemIds = uniqueIds(items.map((item) => item.stockItemId));
  const locationIds = uniqueIds([
    transfer.sourceLocationId,
    transfer.destinationLocationId,
    ...items.map((item) => item.sourceLocationId),
  ]);
  const [stockItemMap, locationMap] = await Promise.all([loadStockItemMap(stockItemIds), loadLocationMap(locationIds)]);
  const transferSourceName = transfer.sourceLocationId ? locationMap.get(transfer.sourceLocationId) || "" : "";
  return {
    ...transfer,
    sourceLocationName: transferSourceName,
    destinationLocationName: transfer.destinationLocationId
      ? locationMap.get(transfer.destinationLocationId) || ""
      : "",
    items: items.map((item) => {
      const stockItem = stockItemMap.get(item.stockItemId);
      const sourceLocationName = item.sourceLocationId
        ? locationMap.get(item.sourceLocationId) || transferSourceName
        : transferSourceName;
      return {
        ...item,
        stockItemCode: stockItem?.code || "",
        stockItemName: stockItem?.name || "",
        stockItemUom: stockItem?.uom || "",
        sourceLocationName,
      };
    }),
  };
}

export async function loadVoucherRelatedData(voucher: {
  id: number;
  description: string | null;
  createdAt: Date;
  companyId: number;
  locationId: number | null;
  optional: boolean;
  exchangeRate: string | null;
  currency: string;
  effectiveDate: string | null;
  deletedAt: Date | null;
  locationName: string | null;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  totalAmount: string;
  shiftId: number | null;
  sourceModule: string | null;
  isCreditSale: boolean | null;
  clientSaleId: string | null;
}) {
  // Exactly one of these is populated, chosen by voucherType. Deriving each
  // field from its loader keeps the shape accurate without restating it, and
  // without the `null as any` seeds that erased all four.
  const result: {
    purchaseOrder: Awaited<ReturnType<typeof loadPurchaseData>> | null;
    salesItems: Awaited<ReturnType<typeof loadSalesData>> | null;
    adjustmentData: Awaited<ReturnType<typeof loadAdjustmentData>> | null;
    transferData: Awaited<ReturnType<typeof loadTransferData>> | null;
  } = {
    purchaseOrder: null,
    salesItems: null,
    adjustmentData: null,
    transferData: null,
  };

  if (voucher.voucherType === "Purchase") {
    result.purchaseOrder = await loadPurchaseData(voucher.id, voucher.companyId);
  } else if (voucher.voucherType === "Sales") {
    result.salesItems = await loadSalesData(voucher.id, voucher.locationId);
  } else if (["Consumption", "Mixed", "Production"].includes(voucher.voucherType)) {
    result.adjustmentData = await loadAdjustmentData(voucher);
  } else if (["Stock Transfer", "StockTransfer", "Transfer"].includes(voucher.voucherType)) {
    result.transferData = await loadTransferData(voucher);
  }

  return result;
}
