// Extracted from ./transfers-create.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import {
  addInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import * as schema from "@shared/schema";
import { type StockAdjustmentItem } from "@shared/schema";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import { shouldInsertAdjustmentVoucherEntry } from "./adjustmentVoucherEntryGuard";
import { stockAdjustmentHeaderTotal, stockAdjustmentNetLine } from "./stockAdjustmentTotals";
import { lockInventoryRow } from "../inventoryRowLock";
import { adjustInventory } from "../../inventoryHelper";
import { syncStockAdjustmentInventoryTx } from "../../services/accounting/perpetualInventory/stockAdjustments";
import { DuplicateStockAdjustmentError, canonicalStockMovementAdapter } from "./applyStockTransferInventoryTx";
import type { StockAdjustmentInputItem, StockAdjustmentType } from "./createStockTransfer";

export async function createStockAdjustmentTx(
  tx: DbTransaction,
  voucherId: number,
  locationId: number,
  adjustmentType: StockAdjustmentType,
  notes: string,
  items: StockAdjustmentInputItem[],
  voucherHeader?: { currency?: string; voucherDate?: string; description?: string },
  storedAdjustmentType?: string
) {
  {
    // Locking the voucher row serialises everyone who wants to adjust it, so the
    // duplicate check below cannot be overtaken between reading and inserting.
    const [voucher] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, voucherId)).for("update");
    if (!voucher) throw new Error(`Voucher ${voucherId} not found`);
    const isOptional = voucher.optional;

    const [duplicate] = await tx
      .select({ id: schema.stockAdjustmentVouchers.id })
      .from(schema.stockAdjustmentVouchers)
      .where(eq(schema.stockAdjustmentVouchers.voucherId, voucherId))
      .limit(1);
    if (duplicate) throw new DuplicateStockAdjustmentError(voucherId);

    const [adjustment] = await tx
      .insert(schema.stockAdjustmentVouchers)
      .values({ voucherId, locationId, adjustmentType: storedAdjustmentType ?? adjustmentType, notes })
      .returning();

    const [location] = await tx.select().from(schema.locations).where(eq(schema.locations.id, locationId));
    if (!location) throw new Error(`Location ${locationId} not found`);

    const findOrCreateAdjustmentAccount = async (
      code: string,
      name: string,
      accountType: string,
      openingBalanceSide: "Dr" | "Cr"
    ): Promise<number> => {
      // System adjustment accounts are unique by (company_id, code). A soft-deleted
      // row still owns that unique key, so filtering deleted rows out and inserting
      // a replacement raises a unique-constraint error. Reuse/reactivate the
      // canonical row instead. The upsert also closes the race where two different
      // vouchers create the system account at the same time.
      let [account] = await tx
        .select()
        .from(schema.ledgerAccounts)
        .where(and(eq(schema.ledgerAccounts.companyId, location.companyId), eq(schema.ledgerAccounts.code, code)))
        .limit(1);

      if (account?.deletedAt || account?.active === false) {
        [account] = await tx
          .update(schema.ledgerAccounts)
          .set({
            name,
            accountType,
            subType: accountType,
            openingBalanceSide,
            active: true,
            isHidden: false,
            deletedAt: null,
          })
          .where(eq(schema.ledgerAccounts.id, account.id))
          .returning();
      }

      if (!account) {
        [account] = await tx
          .insert(schema.ledgerAccounts)
          .values({
            companyId: location.companyId,
            code,
            name,
            accountType,
            subType: accountType,
            openingBalance: "0",
            openingBalanceSide,
          })
          .onConflictDoUpdate({
            target: [schema.ledgerAccounts.companyId, schema.ledgerAccounts.code],
            set: {
              name,
              accountType,
              subType: accountType,
              openingBalanceSide,
              active: true,
              isHidden: false,
              deletedAt: null,
            },
          })
          .returning();
      }
      return account.id;
    };

    // Production and consumption both post to STOCK_ADJUSTMENT.
    let adjustmentAccountId: number | null = null;

    if (!isOptional) {
      adjustmentAccountId = await findOrCreateAdjustmentAccount(
        "STOCK_ADJUSTMENT",
        "Stock Adjustment (Production/Consumption)",
        "Indirect Expense",
        "Dr"
      );
    }

    let totalProductionValue = toInventoryDecimal(0);
    let totalConsumptionValue = toInventoryDecimal(0);

    const sortedAdjItems = [...items].sort((a, b) => a.stockItemId - b.stockItemId);
    const adjustmentItems: StockAdjustmentItem[] = [];
    for (const item of sortedAdjItems) {
      const quantity = toInventoryDecimal(item.quantity);
      const absoluteQuantity = quantity.abs();
      const rate = toInventoryDecimal(item.rate);
      const isProduction = adjustmentType === "Production" || (adjustmentType === "Mixed" && quantity.isPositive());
      let actualRate = rate;
      let actualTotalAmount = multiplyInventoryValues(absoluteQuantity, rate);

      let valueMoved: Decimal | null = null;
      if (!isOptional) {
        // Wave 11: every line moves stock through adjustInventory, so value is
        // inventory.total_value (never rebuilt from the rounded rate), a short
        // row holds no value and keeps a negative layer, and the line records
        // the exact value it moved.
        const currentInventory = await lockInventoryRow(tx, locationId, item.stockItemId);
        let incomingRate: number | undefined = isProduction ? rate.toNumber() : undefined;
        if (!isProduction) {
          if (currentInventory) {
            actualRate = Decimal.max(toInventoryDecimal(currentInventory.average_rate), 0);
          } else {
            const [stockItem] = await tx
              .select()
              .from(schema.stockItems)
              .where(eq(schema.stockItems.id, item.stockItemId));
            if (!stockItem) throw new Error(`Stock item ${item.stockItemId} not found.`);
            const fallbackRate = toInventoryDecimal(stockItem.openingRate);
            if (!fallbackRate.isPositive()) throw new Error(`Stock item "${stockItem.name}" has no opening rate set.`);
            // The opening rate is the provisional cost of the shortage.
            actualRate = fallbackRate;
            incomingRate = fallbackRate.toNumber();
          }
          actualTotalAmount = multiplyInventoryValues(absoluteQuantity, actualRate);
        }
        const moved = await adjustInventory(
          tx,
          locationId,
          item.stockItemId,
          isProduction ? absoluteQuantity.toNumber() : absoluteQuantity.negated().toNumber(),
          location.companyId,
          incomingRate,
          "Stock Adjustment",
          voucherId
        );
        const delta = toInventoryDecimal(moved.valueDelta);
        valueMoved = delta.abs();
        // The voucher's STOCK_ADJUSTMENT lines keep the document value
        // (quantity × rate); syncStockAdjustmentInventoryTx posts Inventory at
        // the recorded value_moved and any difference to INVENTORY_ADJUSTMENT.
        if (isProduction) totalProductionValue = addInventoryValues(totalProductionValue, actualTotalAmount);
        else totalConsumptionValue = addInventoryValues(totalConsumptionValue, actualTotalAmount);
      }

      // Canonical evidence for the applied adjustment, on the same transaction
      // that just moved the inventory above. The rate is the one the adjustment
      // actually resolved — a consumption line takes the location's current
      // average or the item's opening rate, not the rate the caller sent — so
      // the journal records the cost that was really applied.
      //
      // A zero-quantity adjustment changes no stock and gets no movement row:
      // the canonical boundary rejects a zero quantity precisely because it is
      // not a movement.
      if (!isOptional && !absoluteQuantity.isZero()) {
        await postStockMovementTx(
          tx,
          {
            companyId: voucher.companyId,
            stockItemId: item.stockItemId,
            kind: isProduction ? "receipt" : "issue",
            quantity: inventoryQuantity(absoluteQuantity),
            unitCost: inventoryUnitCost(actualRate),
            fromLocationId: isProduction ? null : locationId,
            toLocationId: isProduction ? locationId : null,
            occurredAt: new Date().toISOString(),
            source: {
              sourceType: "stock-adjustment",
              sourceId: String(adjustment.id),
              idempotencyKey: `stock-adjustment:${adjustment.id}:${item.stockItemId}`,
            },
            // The journal records what the adjustment did; it does not add a
            // negative-stock rule the adjustment does not itself enforce.
            allowNegativeStock: true,
          },
          canonicalStockMovementAdapter
        );
      }

      const [adjustmentItem] = await tx
        .insert(schema.stockAdjustmentItems)
        .values({
          adjustmentId: adjustment.id,
          stockItemId: item.stockItemId,
          quantity: inventoryQuantity(quantity),
          rate: inventoryUnitCost(actualRate),
          totalAmount: inventoryMoney(actualTotalAmount),
          valueMoved: valueMoved === null ? null : inventoryMoney(valueMoved),
        })
        .returning();
      adjustmentItems.push(adjustmentItem);
    }

    if (!isOptional) {
      // Production and consumption post to the same STOCK_ADJUSTMENT account: one net line.
      const netLine = stockAdjustmentNetLine(totalProductionValue, totalConsumptionValue, adjustmentType);
      const netValue = totalProductionValue.minus(totalConsumptionValue).abs();
      if (netLine && shouldInsertAdjustmentVoucherEntry(netValue, adjustmentAccountId)) {
        await tx.insert(schema.voucherEntries).values({ voucherId, ledgerAccountId: adjustmentAccountId, ...netLine });
      }
    }

    const headerTotal = stockAdjustmentHeaderTotal(adjustmentType, adjustmentItems);
    const [updatedVoucher] = await tx
      .update(schema.vouchers)
      .set({
        totalAmount: headerTotal,
        locationId,
        ...(voucherHeader?.currency ? { currency: voucherHeader.currency } : {}),
        ...(voucherHeader?.description !== undefined ? { description: voucherHeader.description } : {}),
        ...(voucherHeader?.voucherDate !== undefined ? { voucherDate: voucherHeader.voucherDate } : {}),
      })
      .where(eq(schema.vouchers.id, voucherId))
      .returning();

    if (!updatedVoucher) throw new Error(`Voucher ${voucherId} not found`);

    // Perpetual inventory (wave 8.3): the voucher carries the inventory side of the adjustment.
    await syncStockAdjustmentInventoryTx(tx, voucher.companyId, voucherId);

    return { adjustment, items: adjustmentItems, voucher: updatedVoucher };
  }
}
