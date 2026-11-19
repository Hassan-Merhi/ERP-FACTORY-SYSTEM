// Extracted from ./offload.ts: a stage of offload.
import type Decimal from "decimal.js";
import { logger } from "../../lib/logger";
import {
  addInventoryValues,
  divideInventoryValues,
  multiplyInventoryValues,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import type { POLineItem } from "@shared/schema";
import { getContainerById, getPurchaseOrdersByContainer } from "./containers";
import { getLineItemsByPO } from "./line-items-charges";

export async function offloadStep({
  containerId,
  additionalCharges,
  duties,
  officeCharges,
  transferCharges,
  transportFees,
}: {
  containerId: number;
  additionalCharges: Array<{ description: string; amount: number; ledgerAccountId: number }>;
  duties: string;
  officeCharges: string;
  transferCharges: string;
  transportFees: string;
}) {
  const container = await getContainerById(containerId);
  if (!container) throw new Error(`Container ${containerId} not found`);

  const pos = await getPurchaseOrdersByContainer(containerId);
  const allLineItems: POLineItem[] = [];
  for (const po of pos) allLineItems.push(...(await getLineItemsByPO(po.id)));

  const validLineItems = allLineItems.filter((item) => item.stockItemId && item.stockItemId !== 0);
  const totalBales = addInventoryValues(...validLineItems.map((item) => item.quantity));
  const additionalChargesTotal = addInventoryValues(...additionalCharges.map((charge) => charge.amount));
  const totalCharges = addInventoryValues(
    duties,
    officeCharges,
    transferCharges,
    transportFees,
    additionalChargesTotal,
    container.chargesTotal
  );

  const additionalCostPerBale = divideInventoryValues(totalCharges, totalBales);
  const expectedChargesApplied = multiplyInventoryValues(additionalCostPerBale, totalBales);
  const roundingDifference = subtractInventoryValues(totalCharges, expectedChargesApplied).toDecimalPlaces(2);

  const itemsMap = new Map<number, { stockItemId: number; totalQuantity: Decimal; weightedRateSum: Decimal }>();
  for (const item of allLineItems) {
    const stockItemId = item.stockItemId;
    if (!stockItemId || stockItemId === 0) {
      logger.warn(`Skipping line item ${item.id} - invalid stock item ID: ${stockItemId}`);
      continue;
    }
    const quantity = toInventoryDecimal(item.quantity);
    const weightedValue = multiplyInventoryValues(item.rate, quantity);
    const existing = itemsMap.get(stockItemId);
    if (existing) {
      existing.totalQuantity = addInventoryValues(existing.totalQuantity, quantity);
      existing.weightedRateSum = addInventoryValues(existing.weightedRateSum, weightedValue);
    } else {
      itemsMap.set(stockItemId, { stockItemId, totalQuantity: quantity, weightedRateSum: weightedValue });
    }
  }

  const offloadItemsToStore: Array<{
    stockItemId: number;
    quantity: Decimal;
    rate: Decimal;
    totalValue: Decimal;
  }> = [];
  const itemsArray = Array.from(itemsMap.entries());
  const lastItemIndex = itemsArray.length - 1;

  return {
    container,
    pos,
    totalBales,
    totalCharges,
    additionalCostPerBale,
    roundingDifference,
    itemsMap,
    offloadItemsToStore,
    itemsArray,
    lastItemIndex,
  };
}
