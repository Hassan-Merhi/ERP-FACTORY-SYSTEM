import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type {} from "@shared/schema";
import { removeLinkedJournalTx } from "../../services/accounting/perpetualInventory/linkedJournal";
import {
  containerStockInVoucherNumber,
  removePurchaseOrderGitTx,
} from "../../services/accounting/perpetualInventory/stockReceipts";

export async function deleteContainer(id: number): Promise<void> {
  const [container] = await db.select().from(schema.containers).where(eq(schema.containers.id, id)).limit(1);
  if (!container) throw new Error("Container not found");

  const pos = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.containerId, id));
  for (const po of pos) {
    await db.delete(schema.poLineItems).where(eq(schema.poLineItems.poId, po.id));
    if (po.voucherId) {
      await db.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, po.voucherId));
      await db.delete(schema.vouchers).where(eq(schema.vouchers.id, po.voucherId));
    }
    await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.id));
  }

  const chargeVouchers = await db
    .select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.companyId, container.companyId),
        sql`${schema.vouchers.description} LIKE ${"% - Container " + container.containerNumber}`
      )
    );
  for (const chargeVoucher of chargeVouchers) {
    await db.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, chargeVoucher.id));
    await db.delete(schema.vouchers).where(eq(schema.vouchers.id, chargeVoucher.id));
  }

  await db.delete(schema.containerCharges).where(eq(schema.containerCharges.containerId, id));

  const sales = await db.select().from(schema.containerSales).where(eq(schema.containerSales.containerId, id));
  for (const sale of sales) {
    if (sale.voucherId) {
      await db.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, sale.voucherId));
      await db.delete(schema.vouchers).where(eq(schema.vouchers.id, sale.voucherId));
    }
  }
  await db.delete(schema.containerSales).where(eq(schema.containerSales.containerId, id));

  const offloads = await db
    .select({ id: schema.containerOffloads.id })
    .from(schema.containerOffloads)
    .where(eq(schema.containerOffloads.containerId, id));
  for (const offload of offloads) {
    await db.delete(schema.containerOffloadItems).where(eq(schema.containerOffloadItems.offloadId, offload.id));
  }
  await db.delete(schema.containerOffloads).where(eq(schema.containerOffloads.containerId, id));

  const freights = await db
    .select({ id: schema.containerFreight.id })
    .from(schema.containerFreight)
    .where(eq(schema.containerFreight.containerId, id));
  for (const freight of freights) {
    await db
      .delete(schema.containerFreightPayments)
      .where(eq(schema.containerFreightPayments.containerFreightId, freight.id));
  }
  await db.delete(schema.containerFreight).where(eq(schema.containerFreight.containerId, id));
  await db.delete(schema.containerDocuments).where(eq(schema.containerDocuments.containerId, id));
  await db.delete(schema.importLogs).where(eq(schema.importLogs.containerId, id));
  await db.delete(schema.containers).where(eq(schema.containers.id, id));

  // Perpetual inventory (wave 8.2): the container's linked journals go with it,
  // once everything above has gone (a failed delete leaves them in place).
  await db.transaction(async (tx) => {
    await removeLinkedJournalTx(tx, container.companyId, containerStockInVoucherNumber(id));
    for (const po of pos) await removePurchaseOrderGitTx(tx, container.companyId, po.id);
  });
}

// ---------------------------------------------------------------------------
// PO Line Items
// ---------------------------------------------------------------------------
