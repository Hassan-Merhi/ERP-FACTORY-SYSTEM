// Extracted from ./permanent-delete.ts: per-type delete handlers.
import { db } from "../../../db";
import {
  customerOrders,
  customerOrderLines,
  customerOrderBales,
  customerOrderCharges,
  customerProformas,
  customerProformaLines,
  proformaStockReservations,
  factoryRawMaterialAdjustments,
  factoryContainers,
  factoryRawStock,
  factoryMixBatchSources,
  factoryContainerCommissions,
  factoryDutyAuditLog,
  factoryFxAllocations,
  factoryWasteEntries,
  vouchers,
  voucherEntries,
  salesItems,
} from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { snapshotRow, ORPHANED_POS_POSTED_MESSAGE, PermanentDeleteRefused } from "./permanent-deleteHelpers";
import type { permanentDeleteStep } from "./permanentDeleteStep";
import type { Request, Response } from "express";
import { writeAuditEvent } from "../../../services/audit";

type PermanentDeleteStepResult = Awaited<ReturnType<typeof permanentDeleteStep>>;

export async function permanentDeleteCustomerOrder({
  pd1,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
}) {
  const { itemId, companyId, audit } = pd1;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM ${customerOrders} t WHERE t.id = ${itemId} FOR UPDATE`);
    const row = await snapshotRow(tx, customerOrders, itemId);
    const bales = await tx.delete(customerOrderBales).where(eq(customerOrderBales.orderId, itemId)).returning();
    const lines = await tx.delete(customerOrderLines).where(eq(customerOrderLines.orderId, itemId)).returning();
    const charges = await tx.delete(customerOrderCharges).where(eq(customerOrderCharges.orderId, itemId)).returning();
    await tx.delete(customerOrders).where(and(eq(customerOrders.id, itemId), eq(customerOrders.companyId, companyId)));
    await audit(tx, "customer_orders", row, { bales, lines, charges });
  });
}

export async function permanentDeleteCustomerProforma({
  pd1,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
}) {
  const { itemId, companyId, audit } = pd1;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM ${customerProformas} t WHERE t.id = ${itemId} FOR UPDATE`);
    const row = await snapshotRow(tx, customerProformas, itemId);
    const lines = await tx
      .delete(customerProformaLines)
      .where(eq(customerProformaLines.proformaId, itemId))
      .returning();
    const reservations = await tx
      .delete(proformaStockReservations)
      .where(eq(proformaStockReservations.proformaId, itemId))
      .returning();
    await tx
      .delete(customerProformas)
      .where(and(eq(customerProformas.id, itemId), eq(customerProformas.companyId, companyId)));
    await audit(tx, "customer_proformas", row, { lines, reservations });
  });
}

export async function permanentDeleteFactoryRawMaterialAdjustment({
  pd1,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
}) {
  const { removeOne, itemId, companyId } = pd1;
  await removeOne(factoryRawMaterialAdjustments, "factory_raw_material_adjustments", (tx) =>
    tx
      .delete(factoryRawMaterialAdjustments)
      .where(and(eq(factoryRawMaterialAdjustments.id, itemId), eq(factoryRawMaterialAdjustments.companyId, companyId)))
  );
}

export async function permanentDeleteFactoryContainer({
  pd1,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
}) {
  const { itemId, companyId, audit } = pd1;
  // Delete child rows in FK dependency order before the parent.
  // RESTRICT tables must be cleared manually; CASCADE tables
  // (factory_offload_additional_charges, factory_container_other_charges,
  //  factory_container_profit_snapshots) are handled automatically.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT 1 FROM ${factoryContainers} t WHERE t.id = ${itemId} FOR UPDATE`);
    const row = await snapshotRow(tx, factoryContainers, itemId);
    const ids = (rows: { id: number }[]) => rows.map((r) => r.id);
    const dependents = {
      wasteEntryIds: ids(
        await tx
          .delete(factoryWasteEntries)
          .where(eq(factoryWasteEntries.containerId, itemId))
          .returning({ id: factoryWasteEntries.id })
      ),
      dutyAuditLogIds: ids(
        await tx
          .delete(factoryDutyAuditLog)
          .where(eq(factoryDutyAuditLog.containerId, itemId))
          .returning({ id: factoryDutyAuditLog.id })
      ),
      fxAllocationIds: ids(
        await tx
          .delete(factoryFxAllocations)
          .where(eq(factoryFxAllocations.containerId, itemId))
          .returning({ id: factoryFxAllocations.id })
      ),
      commissionIds: ids(
        await tx
          .delete(factoryContainerCommissions)
          .where(eq(factoryContainerCommissions.containerId, itemId))
          .returning({ id: factoryContainerCommissions.id })
      ),
      // mix_batch_sources refs both container and raw_stock — delete before raw_stock
      mixBatchSourceIds: ids(
        await tx
          .delete(factoryMixBatchSources)
          .where(eq(factoryMixBatchSources.containerId, itemId))
          .returning({ id: factoryMixBatchSources.id })
      ),
      rawStockIds: ids(
        await tx
          .delete(factoryRawStock)
          .where(eq(factoryRawStock.containerId, itemId))
          .returning({ id: factoryRawStock.id })
      ),
    };
    await tx
      .delete(factoryContainers)
      .where(and(eq(factoryContainers.id, itemId), eq(factoryContainers.companyId, companyId)));
    await audit(tx, "factory_containers", row, dependents);
  });
}

export async function permanentDeleteOrphanedPosSale({
  pd1,
  req,
}: {
  pd1: { pd1: Extract<PermanentDeleteStepResult, { done: false }>; req: Request; res: Response }["pd1"];
  req: Request;
}) {
  const { itemId, companyId } = pd1;
  // Wave 12: refused when posted (ledger or stock lines); otherwise the
  // empty voucher goes in one transaction, audited.
  await db.transaction(async (tx) => {
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId)))
      .for("update");
    const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, itemId));
    const items = await tx.select().from(salesItems).where(eq(salesItems.voucherId, itemId));
    if (entries.length > 0 || items.length > 0) throw new PermanentDeleteRefused(ORPHANED_POS_POSTED_MESSAGE);
    await tx.delete(vouchers).where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId)));
    await writeAuditEvent(
      {
        userId: req.session.userId ?? "unknown",
        username: req.session.username || "unknown",
        companyId: companyId,
        action: "delete",
        tableName: "vouchers",
        recordId: itemId,
        recordIdentifier: voucher?.voucherNumber ?? null,
        changes: {
          permanentDelete: { new: true },
          orphanedPosSale: { new: true },
          voucher: { old: voucher ?? null },
        },
      },
      tx
    );
  });
}
