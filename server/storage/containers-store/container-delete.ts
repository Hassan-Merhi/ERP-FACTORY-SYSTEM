import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type {} from "@shared/schema";
import { retireVouchersTx, type VoucherRetirementActor } from "../../services/accounting/voucherRetirement";
import {
  removeContainerStockInJournalsTx,
  removePurchaseOrderGitTx,
} from "../../services/accounting/perpetualInventory/stockReceipts";

/**
 * Deletes a container with its POs, charges, sales, offloads and freight, in one
 * transaction. Wave 16 (A): the vouchers go by retirement (soft delete with
 * their lines, audited in this transaction, number and posting identity
 * released), not by hard delete; it used to run statement by statement.
 */
export async function deleteContainer(id: number, actor?: VoucherRetirementActor | null): Promise<void> {
  await db.transaction(async (tx) => {
    const [container] = await tx.select().from(schema.containers).where(eq(schema.containers.id, id)).limit(1);
    if (!container) throw new Error("Container not found");
    const retire = (voucherIds: (number | null)[], reason: string) =>
      retireVouchersTx(tx, { companyId: container.companyId, voucherIds, reason, actor });

    const pos = await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.containerId, id));
    for (const po of pos) {
      await tx.delete(schema.poLineItems).where(eq(schema.poLineItems.poId, po.id));
      await tx.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.id));
    }
    await retire(
      pos.map((po) => po.voucherId),
      "container-delete-purchase-order"
    );

    const chargeVouchers = await tx
      .select({ id: schema.vouchers.id })
      .from(schema.vouchers)
      .where(
        and(
          eq(schema.vouchers.companyId, container.companyId),
          sql`${schema.vouchers.description} LIKE ${"% - Container " + container.containerNumber}`
        )
      );
    await retire(
      chargeVouchers.map((voucher) => voucher.id),
      "container-delete-charge"
    );

    await tx.delete(schema.containerCharges).where(eq(schema.containerCharges.containerId, id));

    const sales = await tx.select().from(schema.containerSales).where(eq(schema.containerSales.containerId, id));
    await tx.delete(schema.containerSales).where(eq(schema.containerSales.containerId, id));
    await retire(
      sales.map((sale) => sale.voucherId),
      "container-delete-sale"
    );

    const offloads = await tx
      .select({ id: schema.containerOffloads.id })
      .from(schema.containerOffloads)
      .where(eq(schema.containerOffloads.containerId, id));
    for (const offload of offloads) {
      await tx.delete(schema.containerOffloadItems).where(eq(schema.containerOffloadItems.offloadId, offload.id));
    }
    await tx.delete(schema.containerOffloads).where(eq(schema.containerOffloads.containerId, id));

    const freights = await tx
      .select({ id: schema.containerFreight.id })
      .from(schema.containerFreight)
      .where(eq(schema.containerFreight.containerId, id));
    for (const freight of freights) {
      await tx
        .delete(schema.containerFreightPayments)
        .where(eq(schema.containerFreightPayments.containerFreightId, freight.id));
    }
    await tx.delete(schema.containerFreight).where(eq(schema.containerFreight.containerId, id));
    await tx.delete(schema.containerDocuments).where(eq(schema.containerDocuments.containerId, id));
    await tx.delete(schema.importLogs).where(eq(schema.importLogs.containerId, id));
    await tx.delete(schema.containers).where(eq(schema.containers.id, id));

    // Perpetual inventory (wave 8.2): the container's linked journals go with it.
    await removeContainerStockInJournalsTx(tx, container.companyId, id);
    for (const po of pos) await removePurchaseOrderGitTx(tx, container.companyId, po.id);
  });
}

// ---------------------------------------------------------------------------
// PO Line Items
// ---------------------------------------------------------------------------
