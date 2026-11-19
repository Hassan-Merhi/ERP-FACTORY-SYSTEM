// Extracted from ./offload.ts: a stage of offload.
import { postFactoryVoucherTx } from "../../services/factory/factoryVoucherPosting";
import { eq, and } from "drizzle-orm";
import type Decimal from "decimal.js";
import {
  addInventoryValues,
  divideInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import * as schema from "@shared/schema";
import { getLocationById } from "../inventory";
import { lockInventoryRow } from "../inventoryRowLock";
import { DecimalMax } from "./offloadHelpers";
import type { offloadStep } from "./offloadStep";
import type { DbTransaction } from "../../db";

type OffloadStepResult = Awaited<ReturnType<typeof offloadStep>>;

export async function offloadStep2({
  off1,
  inventoryCostCorrections,
  tx,
  locationId,
  offloadDate,
  duties,
  containerId,
  dutiesAccountId,
}: {
  off1: OffloadStepResult;
  inventoryCostCorrections: Array<{ stockItemId: number; correctRate: number }>;
  tx: DbTransaction;
  locationId: number;
  offloadDate: string | undefined;
  duties: string;
  containerId: number;
  dutiesAccountId: number | null | undefined;
}) {
  const {
    itemsMap,
    itemsArray,
    additionalCostPerBale,
    lastItemIndex,
    roundingDifference,
    offloadItemsToStore,
    pos,
    container,
  } = off1;
  const validCorrectionItemIds = new Set(itemsMap.keys());
  for (const correction of inventoryCostCorrections) {
    const correctRate = toInventoryDecimal(correction.correctRate);
    if (!correctRate.isPositive() || !validCorrectionItemIds.has(correction.stockItemId)) continue;
    const correctionRow = await lockInventoryRow(tx, locationId, correction.stockItemId);
    if (!correctionRow) continue;
    const existingQuantity = toInventoryDecimal(correctionRow.quantity);
    if (!existingQuantity.isPositive()) continue;
    const newTotalValue = multiplyInventoryValues(existingQuantity, correctRate);
    await tx
      .update(schema.inventory)
      .set({
        averageRate: inventoryUnitCost(correctRate),
        totalValue: inventoryMoney(newTotalValue),
        lastUpdated: new Date(),
      })
      .where(eq(schema.inventory.id, correctionRow.id));
  }

  for (let index = 0; index < itemsArray.length; index++) {
    const [stockItemId, data] = itemsArray[index];
    if (data.totalQuantity.isZero()) continue;

    const averageOriginalRate = divideInventoryValues(data.weightedRateSum, data.totalQuantity);
    const newRate = addInventoryValues(averageOriginalRate, additionalCostPerBale);
    let offloadValue = multiplyInventoryValues(data.totalQuantity, newRate).toDecimalPlaces(2);
    if (index === lastItemIndex && !roundingDifference.isZero()) {
      offloadValue = addInventoryValues(offloadValue, roundingDifference);
    }
    const adjustedRate = divideInventoryValues(offloadValue, data.totalQuantity);

    offloadItemsToStore.push({
      stockItemId,
      quantity: data.totalQuantity,
      rate: adjustedRate,
      totalValue: offloadValue,
    });

    if (!newRate.isFinite()) throw new Error(`Calculated rate is infinite for stock item ${stockItemId}`);

    const existing = await lockInventoryRow(tx, locationId, stockItemId);

    if (existing) {
      const existingQuantity = toInventoryDecimal(existing.quantity);
      const existingValue = toInventoryDecimal(existing.total_value);
      const newQuantity = addInventoryValues(existingQuantity, data.totalQuantity);
      let weightedAverageRate: Decimal;
      let newTotalValue: Decimal;

      if (newQuantity.isZero()) {
        weightedAverageRate = adjustedRate;
        newTotalValue = toInventoryDecimal(0);
      } else if (newQuantity.isNegative()) {
        weightedAverageRate = adjustedRate;
        newTotalValue = multiplyInventoryValues(newQuantity, adjustedRate);
      } else {
        if (existingQuantity.isNegative()) {
          newTotalValue = multiplyInventoryValues(newQuantity, DecimalMax(adjustedRate, 0));
        } else {
          newTotalValue = addInventoryValues(existingValue, offloadValue);
          if (newTotalValue.isNegative()) {
            newTotalValue = multiplyInventoryValues(newQuantity, DecimalMax(adjustedRate, 0));
          }
        }
        weightedAverageRate = divideInventoryValues(newTotalValue, newQuantity);
      }

      if (!weightedAverageRate.isFinite()) {
        throw new Error(`Calculated weighted average rate is infinite for stock item ${stockItemId}`);
      }

      await tx
        .update(schema.inventory)
        .set({
          quantity: inventoryQuantity(newQuantity),
          averageRate: inventoryUnitCost(weightedAverageRate),
          totalValue: inventoryMoney(newTotalValue),
          lastUpdated: new Date(),
        })
        .where(eq(schema.inventory.id, existing.id));
    } else {
      const [location] = await tx.select().from(schema.locations).where(eq(schema.locations.id, locationId));
      if (!location) throw new Error(`Location ${locationId} not found when creating inventory record`);
      await tx.insert(schema.inventory).values({
        companyId: location.companyId,
        locationId,
        stockItemId,
        quantity: inventoryQuantity(data.totalQuantity),
        averageRate: inventoryUnitCost(adjustedRate),
        totalValue: inventoryMoney(offloadValue),
        lastUpdated: new Date(),
      });
    }
  }

  const resolvedOffloadDate = offloadDate || new Date().toISOString().split("T")[0];
  const containerUpdateSet: Record<string, unknown> = { status: "OFFLOADED", offloadDate: resolvedOffloadDate };
  if (toInventoryDecimal(duties).isPositive()) containerUpdateSet.dutyFee = duties;
  await tx.update(schema.containers).set(containerUpdateSet).where(eq(schema.containers.id, containerId));

  const location = await getLocationById(locationId);
  if (!location) throw new Error("Location not found");
  const voucherDate = offloadDate || new Date().toISOString().split("T")[0];

  const findOrCreateImportChargesParent = async () => {
    let [parentAccount] = await tx
      .select()
      .from(schema.ledgerAccounts)
      .where(
        and(eq(schema.ledgerAccounts.companyId, location.companyId), eq(schema.ledgerAccounts.code, "IMPORT_CHARGES"))
      )
      .limit(1);
    if (!parentAccount) {
      [parentAccount] = await tx
        .insert(schema.ledgerAccounts)
        .values({
          companyId: location.companyId,
          code: "IMPORT_CHARGES",
          name: "Import Charges",
          accountType: "Direct Expense",
          subType: "Direct Expense",
          openingBalance: "0",
          openingBalanceSide: "Dr",
        })
        .returning();
    }
    return parentAccount.id;
  };

  const findOrCreateExpenseAccount = async (code: string, name: string, parentId: number) => {
    let account = await tx
      .select()
      .from(schema.ledgerAccounts)
      .where(and(eq(schema.ledgerAccounts.companyId, location.companyId), eq(schema.ledgerAccounts.code, code)))
      .limit(1);
    if (!account.length) {
      const [newAccount] = await tx
        .insert(schema.ledgerAccounts)
        .values({
          companyId: location.companyId,
          code,
          name,
          accountType: "Direct Expense",
          subType: "Direct Expense",
          parentId,
          openingBalance: "0",
          openingBalanceSide: "Dr",
        })
        .returning();
      account = [newAccount];
    }
    return account[0].id;
  };

  const importChargesParentId = await findOrCreateImportChargesParent();

  for (const po of pos) {
    if (po.voucherId) {
      await tx
        .update(schema.vouchers)
        .set({ description: `Purchase Order ${po.poNumber} - Container ${container.containerNumber} (Offloaded)` })
        .where(eq(schema.vouchers.id, po.voucherId));
    }
  }

  if (dutiesAccountId && toInventoryDecimal(duties).isPositive()) {
    const dutiesExpenseAccountId = await findOrCreateExpenseAccount("DUTIES", "Duties", importChargesParentId);
    const voucherNumber = `DUTY-${container.containerNumber}-${containerId}`;
    const amount = inventoryMoney(duties);
    await postFactoryVoucherTx(tx, {
      companyId: location.companyId,
      voucherNumber,
      voucherType: "Payment",
      voucherDate,
      description: `Duties for container ${container.containerNumber}`,
      sourceModule: "ERP",
      source: {
        sourceType: "container-offload",
        sourceId: String(location.companyId) + ":" + String(containerId),
        phase: "voucher",
      },
      lines: [
        {
          ledgerAccountId: dutiesExpenseAccountId,
          debit: amount,
          narration: `Duties for container ${container.containerNumber}`,
        },
        {
          ledgerAccountId: dutiesAccountId,
          credit: amount,
          narration: `Duties for container ${container.containerNumber}`,
        },
      ],
    });
  }

  return { location, voucherDate, findOrCreateExpenseAccount, importChargesParentId };
}
