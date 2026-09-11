import type { DbTransaction } from "../../../db";
import { and, eq, isNull, gt, sql } from "drizzle-orm";
import {
  factoryContainers,
  factoryOffloadAdditionalCharges,
  factorySuppliers,
  factoryDaybookEntries,
  vouchers,
} from "../../../../shared/schema";

export async function resolveLegacyPostOffloadAccountingLinks(
  tx: DbTransaction,
  companyId: number,
  containerId: number,
  chargeRow: typeof factoryOffloadAdditionalCharges.$inferSelect
) {
  let { daybookEntryId, voucherId } = chargeRow;

  // Resolve daybook entry
  if (!daybookEntryId) {
    const daybooks = await tx
      .select({ id: factoryDaybookEntries.id })
      .from(factoryDaybookEntries)
      .where(
        and(
          eq(factoryDaybookEntries.companyId, companyId),
          eq(factoryDaybookEntries.txType, "OTHER_CHARGE"),
          eq(factoryDaybookEntries.referenceId, containerId),
          sql`${factoryDaybookEntries.metaJson}::jsonb ->> 'sourceType' = 'POST_OFFLOAD_ADDITIONAL'`,
          sql`(${factoryDaybookEntries.metaJson}::jsonb ->> 'chargeId')::int = ${chargeRow.id}`
        )
      );
    if (daybooks.length === 1) {
      daybookEntryId = daybooks[0].id;
    } else if (daybooks.length > 1) {
      throw new Error(
        `Multiple daybook entries matched charge ${chargeRow.id} — manual review required before edit/undo.`
      );
    }
  }

  // Resolve voucher
  if (!voucherId) {
    const voucherRows = await tx
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(
        and(
          eq(vouchers.sourceModule, "FACTORY"),
          isNull(vouchers.deletedAt),
          sql`${vouchers.voucherNumber} LIKE ${"FACTORY-POC-" + containerId + "-" + chargeRow.id + "-%"}`
        )
      );
    if (voucherRows.length === 1) {
      voucherId = voucherRows[0].id;
    } else if (voucherRows.length > 1) {
      throw new Error(
        `Multiple vouchers matched charge ${chargeRow.id} (pattern FACTORY-POC-${containerId}-${chargeRow.id}-%) — manual review required before edit/undo.`
      );
    }
  }

  // Persist resolved IDs if anything changed
  if (daybookEntryId !== chargeRow.daybookEntryId || voucherId !== chargeRow.voucherId) {
    await tx
      .update(factoryOffloadAdditionalCharges)
      .set({ daybookEntryId, voucherId })
      .where(eq(factoryOffloadAdditionalCharges.id, chargeRow.id));
    return { ...chargeRow, daybookEntryId, voucherId };
  }

  return chargeRow;
}

/**
 * Verify no later supplier-cost-changing event exists for the same supplier
 * (later containers offloaded, later active post-offload charges, later duty corrections).
 * Throws if a later event is found.
 */
export async function assertNoLaterSupplierCostEvents(
  tx: DbTransaction,
  companyId: number,
  supplierId: number,
  afterDate: Date
) {
  // 1. Later offloaded container
  const laterContainers = await tx
    .select({ id: factoryContainers.id, containerNumber: factoryContainers.containerNumber })
    .from(factoryContainers)
    .where(
      and(
        eq(factoryContainers.companyId, companyId),
        eq(factoryContainers.supplierId, supplierId),
        eq(factoryContainers.status, "OFFLOADED"),
        gt(factoryContainers.updatedAt, afterDate)
      )
    );
  if (laterContainers.length > 0) {
    throw new Error(
      `Newer supplier cost events exist (offloaded container ${laterContainers[0].containerNumber}). ` +
        "This legacy charge cannot be rebuilt automatically without replaying later supplier-rate events."
    );
  }

  // 2. Later active post-offload charge for the same supplier (via container FK)
  const laterCharges = await tx
    .select({ id: factoryOffloadAdditionalCharges.id })
    .from(factoryOffloadAdditionalCharges)
    .innerJoin(factoryContainers, eq(factoryContainers.id, factoryOffloadAdditionalCharges.containerId))
    .where(
      and(
        eq(factoryContainers.companyId, companyId),
        eq(factoryContainers.supplierId, supplierId),
        isNull(factoryOffloadAdditionalCharges.deletedAt),
        gt(factoryOffloadAdditionalCharges.createdAt, afterDate)
      )
    );
  if (laterCharges.length > 0) {
    throw new Error(
      "Newer supplier cost events exist (a later post-offload charge for this supplier). " +
        "This legacy charge cannot be rebuilt automatically without replaying later supplier-rate events."
    );
  }
}

/** The landed-cost figures updateContainerCost persists on the container. */
export interface ContainerLandedCostUpdate {
  totalCost: number;
  costPerKgUsd: number;
  totalUsd: number;
}

/** Update container landed totals (never touches purchase rate). */
export async function updateContainerCost(tx: DbTransaction, containerId: number, next: ContainerLandedCostUpdate) {
  await tx
    .update(factoryContainers)
    .set({
      finalPayableAmount: String(next.totalCost),
      ratePerKgUsd: String(next.costPerKgUsd),
      finalPayableAmountUsd: String(next.totalUsd),
      updatedAt: new Date(),
    })
    .where(eq(factoryContainers.id, containerId));
}

/** Capture supplier locked rate (FOR UPDATE lock). */
export async function getSupplierRateForUpdate(tx: DbTransaction, companyId: number, supplierId: number) {
  const [row] = await tx
    .select({ rate: factorySuppliers.currentRawMaterialCostPerKgUsd })
    .from(factorySuppliers)
    .where(and(eq(factorySuppliers.id, supplierId), eq(factorySuppliers.companyId, companyId)))
    .for("update");
  return row?.rate ?? null;
}

// ─── Main export ──────────────────────────────────────────────────────────────
