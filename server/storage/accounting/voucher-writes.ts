import { and, eq, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { db } from "../../db";
import * as schema from "@shared/schema";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { reverseVoucherStockTx } from "../../services/inventory/voucherStockReversal";
import { retireVouchersTx, type VoucherRetirementActor } from "../../services/accounting/voucherRetirement";
import type { VoucherEntry, InsertVoucherEntry } from "@shared/schema";

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

/**
 * Deletes a voucher the storage way: its stock moves back, its linked POs and
 * their container charge vouchers go. Wave 16 (A): the vouchers are retired
 * (soft delete with their lines, audited in this transaction, number and
 * posting identity released, voucherRetirement.ts), not hard-deleted.
 */
export async function deleteVoucher(id: number, actor?: VoucherRetirementActor | null): Promise<void> {
  await db.transaction(async (tx) => {
    const [voucher] = await tx.select().from(schema.vouchers).where(eq(schema.vouchers.id, id));

    if (!voucher) {
      throw new Error("Voucher not found");
    }
    // Wave 11: the stock documents move back exactly the value their lines
    // moved, and a sale's COGS journal leaves with it (voucherStockReversal).
    await reverseVoucherStockTx(tx, {
      companyId: voucher.companyId,
      voucher,
      occurredAt: new Date().toISOString(),
      sourcePrefix: "storage_voucher_delete",
      keyPrefix: "storage-voucher-delete",
    });

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
          await retireVouchersTx(tx, {
            companyId: container.companyId,
            voucherIds: chargeVouchers.map((chargeVoucher) => chargeVoucher.id),
            reason: "container-charge-voucher-removed-with-po",
            actor,
          });
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

    await tx.execute(
      sql`DELETE FROM factory_daybook_entries WHERE reference_table = 'vouchers' AND reference_id = ${id}`
    );
    await retireVouchersTx(tx, {
      companyId: voucher.companyId,
      voucherIds: [id],
      reason: "storage-voucher-delete",
      actor,
    });
  });
}

// ---------------------------------------------------------------------------
// Fiscal Period
// ---------------------------------------------------------------------------
