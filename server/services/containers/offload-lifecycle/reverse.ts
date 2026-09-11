import type { DbTransaction } from "../../../db";
import { and, eq, sql } from "drizzle-orm";
import { reverseInventoryByExactValue } from "../../../inventoryHelper";
import * as schema from "@shared/schema";
import { deleteInfrastructurePostingIdentityForVoucherTx } from "../../accounting/infrastructureVoucherIdentity";
import { createDatabaseStockMovementAdapter } from "../../inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../inventory/stockMovementIntegrityService";

import { amount, buildItemMap } from "./types";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

async function deleteVoucherWithEntries(tx: DbTransaction, voucherId: number): Promise<void> {
  // The voucher row and its durable posting identity must be retired together.
  // Otherwise a later re-offload replays a marker that points at a deleted
  // voucher and the accounting writer either blocks or rebuilds against stale
  // state instead of creating the new duties/transport/etc. posting.
  await deleteInfrastructurePostingIdentityForVoucherTx(tx, voucherId);
  await tx.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, voucherId));
  await tx.delete(schema.vouchers).where(eq(schema.vouchers.id, voucherId));
}

export async function reverseExistingOffload(
  tx: DbTransaction,
  container: typeof schema.containers.$inferSelect,
  existingOffload: typeof schema.containerOffloads.$inferSelect,
  lineItems: Array<{ stockItemId: number; quantity: string; rate: string }>
): Promise<void> {
  const storedItems = await tx
    .select()
    .from(schema.containerOffloadItems)
    .where(eq(schema.containerOffloadItems.offloadId, existingOffload.id));
  const occurredAt = new Date().toISOString();

  if (storedItems.length > 0) {
    for (const item of storedItems) {
      const quantity = amount(item.quantity);
      const totalValue = amount(item.totalValue);
      await reverseInventoryByExactValue(tx, existingOffload.locationId, item.stockItemId, quantity, totalValue);
      await postStockMovementTx(
        tx,
        {
          companyId: container.companyId,
          stockItemId: item.stockItemId,
          kind: "adjustment",
          quantity: String(quantity),
          unitCost: String(quantity > 0 ? Math.max(totalValue / quantity, 0) : 0),
          fromLocationId: existingOffload.locationId,
          occurredAt,
          source: {
            sourceType: "container_offload_reverse",
            sourceId: String(existingOffload.id),
            idempotencyKey: `container-offload-reverse:${container.companyId}:${existingOffload.id}:${item.id}`,
          },
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
    }
  } else {
    const legacyAdditionalCost = amount(existingOffload.additionalCostPerBale);
    const legacyItems = buildItemMap(lineItems);
    for (const [stockItemId, item] of legacyItems) {
      const estimatedValue = item.weightedRateSum + item.totalQuantity * legacyAdditionalCost;
      await reverseInventoryByExactValue(
        tx,
        existingOffload.locationId,
        stockItemId,
        item.totalQuantity,
        estimatedValue
      );
      await postStockMovementTx(
        tx,
        {
          companyId: container.companyId,
          stockItemId,
          kind: "adjustment",
          quantity: String(item.totalQuantity),
          unitCost: String(item.totalQuantity > 0 ? Math.max(estimatedValue / item.totalQuantity, 0) : 0),
          fromLocationId: existingOffload.locationId,
          occurredAt,
          source: {
            sourceType: "container_offload_reverse_legacy",
            sourceId: String(existingOffload.id),
            idempotencyKey: `container-offload-reverse:legacy:${container.companyId}:${existingOffload.id}:${stockItemId}`,
          },
          allowNegativeStock: true,
        },
        canonicalStockMovementAdapter
      );
    }
  }

  await tx.delete(schema.containerOffloadItems).where(eq(schema.containerOffloadItems.offloadId, existingOffload.id));

  const containerPattern = `%container ${container.containerNumber}%`;
  const localVouchers = await tx
    .select({ id: schema.vouchers.id })
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.companyId, container.companyId),
        sql`(
          (
            LOWER(${schema.vouchers.description}) LIKE LOWER(${containerPattern})
            AND (
              ${schema.vouchers.voucherNumber} LIKE 'DUTY-%' OR
              ${schema.vouchers.voucherNumber} LIKE 'OFFICE-%' OR
              ${schema.vouchers.voucherNumber} LIKE 'TRANS-%' OR
              ${schema.vouchers.voucherNumber} LIKE 'CHG-%' OR
              ${schema.vouchers.voucherNumber} LIKE 'XFER-%'
            )
          )
          OR ${schema.vouchers.voucherNumber} LIKE ${`SP-OTW-REV-ERP-${container.id}-%`}
          OR ${schema.vouchers.voucherNumber} LIKE ${`SP-STOCK-ERP-${container.id}-%`}
          OR ${schema.vouchers.voucherNumber} LIKE ${`SP-AGENT-SETTLE-${container.id}-%`}
        )`
      )
    );

  for (const voucher of localVouchers) {
    await deleteVoucherWithEntries(tx, voucher.id);
  }

  const parentAgentVouchers = await tx
    .select({ id: schema.vouchers.id })
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.companyId, 1),
        sql`${schema.vouchers.voucherNumber} LIKE ${`SP-AGENT-ERP-${container.id}-%`}`
      )
    );
  for (const voucher of parentAgentVouchers) {
    await deleteVoucherWithEntries(tx, voucher.id);
  }

  await tx.delete(schema.containerOffloads).where(eq(schema.containerOffloads.id, existingOffload.id));
}
