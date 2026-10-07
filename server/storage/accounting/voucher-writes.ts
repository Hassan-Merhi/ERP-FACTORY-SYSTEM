import { and, eq, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { db } from "../../db";
import * as schema from "@shared/schema";
import { adjustInventory } from "../../inventoryHelper";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import type { VoucherEntry, InsertVoucherEntry } from "@shared/schema";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export async function createVoucherEntry(entry: InsertVoucherEntry): Promise<VoucherEntry> {
  const [created] = await db.insert(schema.voucherEntries).values(entry).returning();
  return created;
}

export async function updateVoucherEntry(id: number, updates: Partial<InsertVoucherEntry>): Promise<VoucherEntry> {
  const [updated] = await db
    .update(schema.voucherEntries)
    .set(updates)
    .where(eq(schema.voucherEntries.id, id))
    .returning();
  return updated;
}

export async function deleteVoucherEntry(id: number): Promise<void> {
  await db.delete(schema.voucherEntries).where(eq(schema.voucherEntries.id, id));
}

export async function deleteVoucher(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [voucher] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, id));

    if (!voucher) {
      throw new Error("Voucher not found");
    }
    const occurredAt = new Date().toISOString();

    if (voucher.voucherType === "Sales" && voucher.locationId) {
      const salesItemsList = await tx.select().from(schema.salesItems).where(eq(schema.salesItems.voucherId, id));

      for (const saleItem of salesItemsList) {
        const quantity = Number(saleItem.quantity);
        const costPrice = Number(saleItem.costPrice);
        await adjustInventory(
          tx,
          voucher.locationId,
          saleItem.stockItemId,
          quantity,
          voucher.companyId,
          costPrice,
          "Sales-Reversal",
          id
        );
        await postStockMovementTx(
          tx,
          {
            companyId: voucher.companyId,
            stockItemId: saleItem.stockItemId,
            kind: "adjustment",
            quantity: String(Math.abs(quantity)),
            unitCost: String(Math.max(costPrice || 0, 0)),
            toLocationId: voucher.locationId,
            occurredAt,
            source: {
              sourceType: "storage-voucher-delete-sales",
              sourceId: String(id),
              idempotencyKey: `storage-voucher-delete:sales:${voucher.companyId}:${id}:${saleItem.id}`,
            },
            allowNegativeStock: true,
          },
          canonicalStockMovementAdapter
        );
      }
      await tx.delete(schema.salesItems).where(eq(schema.salesItems.voucherId, id));
    }

    if (voucher.voucherType === "Stock Transfer") {
      const [transferVoucher] = await tx
        .select()
        .from(schema.stockTransferVouchers)
        .where(eq(schema.stockTransferVouchers.voucherId, id));

      if (transferVoucher) {
        const transferItems = await tx
          .select()
          .from(schema.stockTransferItems)
          .where(eq(schema.stockTransferItems.transferId, transferVoucher.id));

        const sourceLocationId = transferVoucher.sourceLocationId;
        const destinationLocationId = transferVoucher.destinationLocationId;

        for (const item of transferItems) {
          const quantity = Number(item.quantity);
          const rate = Number(item.rate);

          if (!sourceLocationId)
            throw new Error(`Cannot reverse stock transfer: source location ID is missing for transfer voucher ${id}`);
          if (!destinationLocationId)
            throw new Error(
              `Cannot reverse stock transfer: destination location ID is missing for transfer voucher ${id}`
            );

          await adjustInventory(
            tx,
            sourceLocationId,
            item.stockItemId,
            quantity,
            voucher.companyId,
            rate,
            "StockTransfer-Reversal",
            id
          );
          await adjustInventory(
            tx,
            destinationLocationId,
            item.stockItemId,
            -quantity,
            voucher.companyId,
            rate,
            "StockTransfer-Reversal",
            id
          );
          await postStockMovementTx(
            tx,
            {
              companyId: voucher.companyId,
              stockItemId: item.stockItemId,
              kind: "transfer",
              quantity: String(Math.abs(quantity)),
              unitCost: String(Math.max(rate || 0, 0)),
              fromLocationId: destinationLocationId,
              toLocationId: sourceLocationId,
              occurredAt,
              source: {
                sourceType: "storage-voucher-delete-transfer",
                sourceId: String(id),
                idempotencyKey: `storage-voucher-delete:transfer:${voucher.companyId}:${id}:${item.id}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }

        await tx.delete(schema.stockTransferItems).where(eq(schema.stockTransferItems.transferId, transferVoucher.id));
        await tx.delete(schema.stockTransferVouchers).where(eq(schema.stockTransferVouchers.id, transferVoucher.id));
      }
    }

    if (
      voucher.voucherType === "Production" ||
      voucher.voucherType === "Consumption" ||
      voucher.voucherType === "Mixed" ||
      voucher.voucherType === "Stock Adjustment"
    ) {
      const [adjustmentVoucher] = await tx
        .select()
        .from(schema.stockAdjustmentVouchers)
        .where(eq(schema.stockAdjustmentVouchers.voucherId, id));

      if (adjustmentVoucher) {
        const adjustmentItems = await tx
          .select()
          .from(schema.stockAdjustmentItems)
          .where(eq(schema.stockAdjustmentItems.adjustmentId, adjustmentVoucher.id));

        const adjustmentType = adjustmentVoucher.adjustmentType;

        for (const item of adjustmentItems) {
          const rawQuantity = Number(item.quantity);
          const quantity = Math.abs(rawQuantity);
          const rate = Number(item.rate);

          const isConsumption = adjustmentType === "Consumption" || (adjustmentType === "Mixed" && rawQuantity < 0);
          const reversedQuantity = isConsumption ? quantity : -quantity;

          await adjustInventory(
            tx,
            adjustmentVoucher.locationId,
            item.stockItemId,
            reversedQuantity,
            voucher.companyId,
            rate,
            `${adjustmentType}-Reversal`,
            id
          );
          await postStockMovementTx(
            tx,
            {
              companyId: voucher.companyId,
              stockItemId: item.stockItemId,
              kind: "adjustment",
              quantity: String(quantity),
              unitCost: String(Math.max(rate || 0, 0)),
              fromLocationId: isConsumption ? undefined : adjustmentVoucher.locationId,
              toLocationId: isConsumption ? adjustmentVoucher.locationId : undefined,
              occurredAt,
              source: {
                sourceType: "storage-voucher-delete-adjustment",
                sourceId: String(id),
                idempotencyKey: `storage-voucher-delete:adjustment:${voucher.companyId}:${id}:${item.id}`,
              },
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }

        await tx
          .delete(schema.stockAdjustmentItems)
          .where(eq(schema.stockAdjustmentItems.adjustmentId, adjustmentVoucher.id));
        await tx
          .delete(schema.stockAdjustmentVouchers)
          .where(eq(schema.stockAdjustmentVouchers.id, adjustmentVoucher.id));
      }
    }

    const linkedPOs = await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.voucherId, id));

    if (linkedPOs.length > 0) {
      const containerUpdates = new Map<number, { itemsTotal: Decimal; containerNumber: string }>();
      for (const po of linkedPOs) {
        const itemsTotal = toMoney(po.itemsTotal);
        const container = await tx
          .select()
          .from(schema.containers)
          .where(eq(schema.containers.id, po.containerId))
          .limit(1);
        const containerNumber = container.length > 0 ? container[0].containerNumber : "";
        const existing = containerUpdates.get(po.containerId) || { itemsTotal: new MoneyDecimal(0), containerNumber };
        containerUpdates.set(po.containerId, { itemsTotal: existing.itemsTotal.plus(itemsTotal), containerNumber });
        await tx.delete(schema.poLineItems).where(eq(schema.poLineItems.poId, po.id));
      }

      await tx.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.voucherId, id));

      for (const [containerId, totals] of Array.from(containerUpdates.entries())) {
        const [container] = await tx
          .select()
          .from(schema.containers)
          .where(eq(schema.containers.id, containerId))
          .limit(1);
        if (container) {
          const prefix = `CHARGE-${container.containerNumber}-`;
          const chargeVouchers = await tx
            .select({ id: schema.vouchers.id })
            .from(schema.vouchers)
            .where(
              and(
                eq(schema.vouchers.companyId, container.companyId),
                // Prefix match without LIKE so a "_" or "%" in the container
                // number cannot widen it to other containers' charge vouchers.
                sql`left(${schema.vouchers.voucherNumber}, ${prefix.length}) = ${prefix}`
              )
            );
          for (const chargeVoucher of chargeVouchers) {
            await tx.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, chargeVoucher.id));
            await tx.delete(schema.vouchers).where(eq(schema.vouchers.id, chargeVoucher.id));
          }
          const newItemsTotal = MoneyDecimal.max(0, toMoney(container.itemsTotal).minus(totals.itemsTotal));
          const newChargesTotal = new MoneyDecimal(0);
          const newGrandTotal = newItemsTotal.plus(newChargesTotal);
          const remainingPOs = await tx
            .select()
            .from(schema.purchaseOrders)
            .where(eq(schema.purchaseOrders.containerId, containerId))
            .limit(1);
          if (remainingPOs.length === 0) {
            await tx.delete(schema.containerCharges).where(eq(schema.containerCharges.containerId, containerId));
            await tx.delete(schema.containers).where(eq(schema.containers.id, containerId));
          } else {
            await tx
              .update(schema.containers)
              .set({
                itemsTotal: newItemsTotal.toFixed(2),
                chargesTotal: newChargesTotal.toFixed(2),
                grandTotal: newGrandTotal.toFixed(2),
              })
              .where(eq(schema.containers.id, containerId));
          }
        }
      }
    }

    await tx.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, id));
    await tx.execute(
      sql`DELETE FROM factory_daybook_entries WHERE reference_table = 'vouchers' AND reference_id = ${id}`
    );
    await tx.delete(schema.vouchers).where(eq(schema.vouchers.id, id));
  });
}

// ---------------------------------------------------------------------------
// Fiscal Period
// ---------------------------------------------------------------------------
