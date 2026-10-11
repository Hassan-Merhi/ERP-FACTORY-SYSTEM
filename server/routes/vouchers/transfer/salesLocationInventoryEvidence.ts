import type { DbTransaction } from "../../../db";
import { salesItems, vouchers } from "@shared/schema";
import { eq } from "drizzle-orm";
import { adjustInventory } from "../../../inventoryHelper";
import { nextCanonicalSourceRevision } from "../../../services/inventory/canonicalSourceRevision";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import { toMoney } from "../../../lib/money";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();
type VoucherRow = typeof vouchers.$inferSelect;

export async function moveSalesVoucherInventoryLocation(
  tx: DbTransaction,
  voucher: VoucherRow,
  oldLocationId: number,
  newLocationId: number,
  actor?: { userId?: number | null; username?: string | null; reason?: string | null }
): Promise<void> {
  if (oldLocationId === newLocationId) return;
  const items = await tx.select().from(salesItems).where(eq(salesItems.voucherId, voucher.id)).for("update");
  if (items.length === 0) return;

  const revision = await nextCanonicalSourceRevision(
    tx,
    voucher.companyId,
    "voucher-sales-location-edit",
    String(voucher.id)
  );
  const occurredAt = new Date().toISOString();
  const evidenceActor = actor ?? { reason: `Move sales voucher ${voucher.voucherNumber} inventory location` };

  for (const item of items) {
    const quantity = toMoney(item.quantity).toNumber();
    const costPrice = toMoney(item.costPrice).toNumber();
    await adjustInventory(tx, oldLocationId, item.stockItemId, quantity, voucher.companyId, costPrice);
    await postStockMovementTx(
      tx,
      {
        companyId: voucher.companyId,
        stockItemId: item.stockItemId,
        kind: "adjustment",
        quantity: String(Math.abs(quantity)),
        unitCost: String(Math.max(costPrice || 0, 0)),
        toLocationId: oldLocationId,
        occurredAt,
        source: {
          sourceType: "voucher-sales-location-edit-reverse",
          sourceId: String(voucher.id),
          idempotencyKey: `voucher-sales-location:rev${revision}:reverse:${item.id}`,
        },
        actor: evidenceActor,
        allowNegativeStock: true,
      },
      canonicalStockMovementAdapter
    );

    const issueResult = await adjustInventory(tx, newLocationId, item.stockItemId, -quantity, voucher.companyId);
    await postStockMovementTx(
      tx,
      {
        companyId: voucher.companyId,
        stockItemId: item.stockItemId,
        kind: "issue",
        quantity: String(Math.abs(quantity)),
        unitCost: String(Math.max(issueResult.averageRate || costPrice || 0, 0)),
        fromLocationId: newLocationId,
        occurredAt,
        source: {
          sourceType: "voucher-sales-location-edit-apply",
          sourceId: String(voucher.id),
          idempotencyKey: `voucher-sales-location:rev${revision}:apply:${item.id}`,
        },
        actor: evidenceActor,
        allowNegativeStock: true,
      },
      canonicalStockMovementAdapter
    );
  }
}
