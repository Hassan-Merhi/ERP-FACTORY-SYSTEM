import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../services/accounting/infrastructureVoucherIdentity";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import { eq, and, isNull } from "drizzle-orm";
import type Decimal from "decimal.js";
import { logger } from "../../lib/logger";
import {
  addInventoryValues,
  divideInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type { POLineItem, ContainerOffload } from "@shared/schema";
import { getLocationById } from "../inventory";
import { getContainerById, getPurchaseOrdersByContainer } from "./containers";
import { getLineItemsByPO } from "./line-items-charges";
import { lockInventoryRow } from "../inventoryRowLock";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export async function offloadContainer(
  containerId: number,
  locationId: number,
  duties: string,
  dutiesAccountId: number | null | undefined,
  officeCharges: string,
  officeChargesAccountId: number | null | undefined,
  officeChargesCashAccountId: number | null | undefined,
  transferCharges: string,
  transportFees: string,
  transportAccountId: number | null | undefined,
  additionalCharges: Array<{ description: string; amount: number; ledgerAccountId: number }> = [],
  offloadDate?: string,
  inventoryCostCorrections: Array<{ stockItemId: number; correctRate: number }> = []
): Promise<ContainerOffload> {
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

  const offload = await db.transaction(async (tx) => {
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
      const voucherNumber = `DUTY-${container.containerNumber}-${Date.now()}`;
      const amount = inventoryMoney(duties);
      const { voucher: voucher } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId: location.companyId,
          voucherNumber,
          voucherType: "Payment",
          voucherDate,
          description: `Duties for container ${container.containerNumber}`,
          totalAmount: amount,
        },
        infrastructurePostingIdentity(
          "container-offload",
          String(location.companyId) + ":" + String(containerId),
          "voucher"
        ),
        { duties, officeCharges, transferCharges, transportFees, additionalCharges }
      );
      await tx.insert(schema.voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: dutiesExpenseAccountId,
        debitAmount: amount,
        creditAmount: "0",
        narration: `Duties for container ${container.containerNumber}`,
      });
      await tx.insert(schema.voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: dutiesAccountId,
        debitAmount: "0",
        creditAmount: amount,
        narration: `Duties for container ${container.containerNumber}`,
      });
    }

    if (officeChargesAccountId && officeChargesCashAccountId && toInventoryDecimal(officeCharges).isPositive()) {
      const [officeChargesAccount] = await tx
        .select({ accountType: schema.ledgerAccounts.accountType, name: schema.ledgerAccounts.name })
        .from(schema.ledgerAccounts)
        .where(and(eq(schema.ledgerAccounts.id, officeChargesAccountId), isNull(schema.ledgerAccounts.deletedAt)))
        .limit(1);
      const invalidTypes = [
        "Expense",
        "Direct Expense",
        "Indirect Expense",
        "Income",
        "Liability",
        "Current Liability",
        "Profit",
        "Government Taxes",
        "COGS",
      ];
      if (!officeChargesAccount || invalidTypes.includes(officeChargesAccount.accountType)) {
        throw new Error(
          `Office charges account "${officeChargesAccount?.name || `ID ${officeChargesAccountId}`}" has type "${officeChargesAccount?.accountType ?? "deleted/not found"}" which is invalid. It must be an Asset-type account.`
        );
      }
      const amount = inventoryMoney(officeCharges);
      const { voucher: voucher } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId: location.companyId,
          voucherNumber: `OFFICE-${container.containerNumber}-${Date.now()}`,
          voucherType: "Payment",
          voucherDate,
          description: `Office charges for container ${container.containerNumber}`,
          totalAmount: amount,
        },
        infrastructurePostingIdentity(
          "container-offload",
          String(location.companyId) + ":" + String(containerId),
          "office"
        ),
        { duties, officeCharges, transferCharges, transportFees, additionalCharges }
      );
      await tx.insert(schema.voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: officeChargesAccountId,
        debitAmount: amount,
        creditAmount: "0",
        narration: `Office charges for container ${container.containerNumber}`,
      });
      await tx.insert(schema.voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: officeChargesCashAccountId,
        debitAmount: "0",
        creditAmount: amount,
        narration: `Office charges for container ${container.containerNumber}`,
      });
    }

    if (toInventoryDecimal(transportFees).isPositive()) {
      const transportExpenseAccountId = await findOrCreateExpenseAccount(
        "TRANSPORT",
        "Transport Charges",
        importChargesParentId
      );
      const expenseTypes = ["Expense", "Direct Expense", "Indirect Expense"];
      const getTransportPayableAccount = async () => {
        let accounts = await tx
          .select()
          .from(schema.ledgerAccounts)
          .where(
            and(
              eq(schema.ledgerAccounts.companyId, location.companyId),
              eq(schema.ledgerAccounts.code, "TRANSPORT_PAYABLE"),
              isNull(schema.ledgerAccounts.deletedAt)
            )
          )
          .limit(1);
        if (!accounts.length) {
          const [newAccount] = await tx
            .insert(schema.ledgerAccounts)
            .values({
              companyId: location.companyId,
              code: "TRANSPORT_PAYABLE",
              name: "Transport Fees Payable",
              accountType: "Liability",
              subType: "Current Liability",
              openingBalance: "0",
              openingBalanceSide: "Cr",
            })
            .returning();
          accounts = [newAccount];
        }
        return accounts[0].id;
      };

      let creditAccountId = transportAccountId;
      if (transportAccountId) {
        const [selectedAccount] = await tx
          .select()
          .from(schema.ledgerAccounts)
          .where(and(eq(schema.ledgerAccounts.id, transportAccountId), isNull(schema.ledgerAccounts.deletedAt)))
          .limit(1);
        if (!selectedAccount || expenseTypes.includes(selectedAccount.accountType)) {
          creditAccountId = await getTransportPayableAccount();
        }
      } else {
        creditAccountId = await getTransportPayableAccount();
      }
      if (!creditAccountId) creditAccountId = await getTransportPayableAccount();

      const amount = inventoryMoney(transportFees);
      const { voucher: voucher } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId: location.companyId,
          voucherNumber: `TRANS-${container.containerNumber}-${Date.now()}`,
          voucherType: "Payment",
          voucherDate,
          description: `Transport fees for container ${container.containerNumber}`,
          totalAmount: amount,
        },
        infrastructurePostingIdentity(
          "container-offload",
          String(location.companyId) + ":" + String(containerId),
          "transport"
        ),
        { duties, officeCharges, transferCharges, transportFees, additionalCharges }
      );
      await tx.insert(schema.voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: transportExpenseAccountId,
        debitAmount: amount,
        creditAmount: "0",
        narration: `Transport fees for container ${container.containerNumber}`,
      });
      await tx.insert(schema.voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: creditAccountId,
        debitAmount: "0",
        creditAmount: amount,
        narration: `Transport fees for container ${container.containerNumber}`,
      });
    }

    if (toInventoryDecimal(transferCharges).isPositive()) {
      const transferExpenseAccountId = await findOrCreateExpenseAccount(
        "TRANSFER_CHARGES",
        "Transfer Charges",
        importChargesParentId
      );
      let transferPayableAccounts = await tx
        .select()
        .from(schema.ledgerAccounts)
        .where(
          and(
            eq(schema.ledgerAccounts.companyId, location.companyId),
            eq(schema.ledgerAccounts.code, "TRANSFER_PAYABLE"),
            isNull(schema.ledgerAccounts.deletedAt)
          )
        )
        .limit(1);
      if (!transferPayableAccounts.length) {
        const [newAccount] = await tx
          .insert(schema.ledgerAccounts)
          .values({
            companyId: location.companyId,
            code: "TRANSFER_PAYABLE",
            name: "Transfer Charges Payable",
            accountType: "Liability",
            subType: "Current Liability",
            openingBalance: "0",
            openingBalanceSide: "Cr",
          })
          .returning();
        transferPayableAccounts = [newAccount];
      }
      const amount = inventoryMoney(transferCharges);
      const { voucher: voucher } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId: location.companyId,
          voucherNumber: `XFER-${container.containerNumber}-${Date.now()}`,
          voucherType: "Payment",
          voucherDate,
          description: `Transfer charges for container ${container.containerNumber}`,
          totalAmount: amount,
        },
        infrastructurePostingIdentity(
          "container-offload",
          String(location.companyId) + ":" + String(containerId),
          "transfer"
        ),
        { duties, officeCharges, transferCharges, transportFees, additionalCharges }
      );
      await tx.insert(schema.voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: transferExpenseAccountId,
        debitAmount: amount,
        creditAmount: "0",
        narration: `Transfer charges for container ${container.containerNumber}`,
      });
      await tx.insert(schema.voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: transferPayableAccounts[0].id,
        debitAmount: "0",
        creditAmount: amount,
        narration: `Transfer charges for container ${container.containerNumber}`,
      });
    }

    for (const [chargeIndex, charge] of additionalCharges.entries()) {
      if (!toInventoryDecimal(charge.amount).isPositive()) continue;
      const [creditAccount] = await tx
        .select({ accountType: schema.ledgerAccounts.accountType, name: schema.ledgerAccounts.name })
        .from(schema.ledgerAccounts)
        .where(and(eq(schema.ledgerAccounts.id, charge.ledgerAccountId), isNull(schema.ledgerAccounts.deletedAt)))
        .limit(1);
      if (!creditAccount) {
        throw new Error(
          `Additional charge "${charge.description}" references a deleted or non-existent ledger account (ID: ${charge.ledgerAccountId}).`
        );
      }
      if (["Direct Expense", "Indirect Expense"].includes(creditAccount.accountType)) {
        throw new Error(
          `Additional charge "${charge.description}" cannot credit the "${creditAccount.name}" account (type: ${creditAccount.accountType}).`
        );
      }
      const expenseAccountId = await findOrCreateExpenseAccount(
        "ADDITIONAL_CHARGES",
        "Additional Container Charges",
        importChargesParentId
      );
      const amount = inventoryMoney(charge.amount);
      const { voucher: voucher } = await insertInfrastructureVoucherTx(
        tx,
        {
          companyId: location.companyId,
          voucherNumber: `CHG-${container.containerNumber}-${Date.now()}`,
          voucherType: "Payment",
          voucherDate,
          description: `${charge.description} for container ${container.containerNumber}`,
          totalAmount: amount,
        },
        infrastructurePostingIdentity(
          "container-offload",
          String(location.companyId) + ":" + String(containerId) + ":" + String(chargeIndex),
          "additional"
        ),
        { duties, officeCharges, transferCharges, transportFees, additionalCharges }
      );
      await tx.insert(schema.voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: expenseAccountId,
        debitAmount: amount,
        creditAmount: "0",
        narration: `${charge.description} for container ${container.containerNumber}`,
      });
      await tx.insert(schema.voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: charge.ledgerAccountId,
        debitAmount: "0",
        creditAmount: amount,
        narration: `${charge.description} for container ${container.containerNumber}`,
      });
    }

    const [offloadRecord] = await tx
      .insert(schema.containerOffloads)
      .values({
        containerId,
        locationId,
        duties: inventoryMoney(duties),
        officeCharges: inventoryMoney(officeCharges),
        transferCharges: inventoryMoney(transferCharges),
        transportFees: inventoryMoney(transportFees),
        totalCharges: inventoryMoney(totalCharges),
        totalBales: inventoryQuantity(totalBales),
        additionalCostPerBale: inventoryUnitCost(additionalCostPerBale),
        offloadedAt: offloadDate ? new Date(offloadDate) : new Date(),
      })
      .returning();

    for (const item of offloadItemsToStore) {
      await tx.insert(schema.containerOffloadItems).values({
        offloadId: offloadRecord.id,
        stockItemId: item.stockItemId,
        quantity: inventoryQuantity(item.quantity),
        rate: inventoryUnitCost(item.rate),
        totalValue: inventoryMoney(item.totalValue),
      });

      if (!item.quantity.isZero()) {
        await postStockMovementTx(
          tx,
          {
            companyId: location.companyId,
            stockItemId: item.stockItemId,
            kind: "receipt",
            quantity: inventoryQuantity(item.quantity.abs()),
            unitCost: inventoryUnitCost(item.rate.abs()),
            toLocationId: locationId,
            occurredAt: offloadRecord.offloadedAt.toISOString(),
            source: {
              sourceType: "legacy-container-offload",
              sourceId: String(offloadRecord.id),
              idempotencyKey: `legacy-container-offload:${offloadRecord.id}:${item.stockItemId}`,
            },
            allowNegativeStock: true,
          },
          canonicalStockMovementAdapter
        );
      }
    }

    return offloadRecord;
  });

  return offload;
}

function DecimalMax(value: Decimal.Value, minimum: Decimal.Value): Decimal {
  const decimalValue = toInventoryDecimal(value);
  const decimalMinimum = toInventoryDecimal(minimum);
  return decimalValue.greaterThan(decimalMinimum) ? decimalValue : decimalMinimum;
}
