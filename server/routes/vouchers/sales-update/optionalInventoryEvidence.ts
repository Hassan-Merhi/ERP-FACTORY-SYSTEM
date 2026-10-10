/**
 * The stock side of `PATCH /api/vouchers/:id` when the edit changes the
 * voucher's optional flag (wave 15).
 *
 * It used to move the stock its own way (pre-wave-11): transfers issued at the
 * source's average and received at the line's 2dp rate, a sale was issued and
 * returned with no COGS journal, a debit note was received like a credit note.
 * It now runs the same value-exact toggle as `PATCH /api/vouchers/:id/optional`
 * (optionalStockToggle.ts): each document moves back exactly the value it
 * moved, activation records the new value_moved and posts the sale's COGS
 * journal, a factory bale-mirror item is refused after the cut-over, and the
 * part of the sub-ledger change the ledger's Inventory did not move with is
 * posted as an INV-MOVE journal (a no-op before the cut-over).
 *
 * The flag and the stock adjustment's inventory line are written here, before
 * the residual is measured; the caller writes the flag again with the rest of
 * the header and re-syncs the inventory line, which changes nothing more.
 */
import { eq } from "drizzle-orm";

import { vouchers } from "@shared/schema";

import type { DbTransaction } from "../../../db";
import { syncStockAdjustmentInventoryTx } from "../../../services/accounting/perpetualInventory/stockAdjustments";
import { nextCanonicalSourceRevision } from "../../../services/inventory/canonicalSourceRevision";
import { postOptionalToggleResidualTx, toggleVoucherStockTx, voucherInventoryLedgerTx } from "./optionalStockToggle";

type VoucherRow = typeof vouchers.$inferSelect;

export async function applyVoucherOptionalInventoryChange(
  tx: DbTransaction,
  voucher: VoucherRow,
  willBeOptional: boolean,
  actor?: { userId?: string | null; username?: string | null; reason?: string | null }
): Promise<void> {
  if (voucher.optional === willBeOptional) return;

  const evidenceRevision = await nextCanonicalSourceRevision(
    tx,
    voucher.companyId,
    "voucher-optional-toggle",
    String(voucher.id)
  );
  const toggleVoucher = {
    id: voucher.id,
    companyId: voucher.companyId,
    voucherNumber: voucher.voucherNumber,
    voucherDate: String(voucher.voucherDate),
    voucherType: voucher.voucherType,
    locationId: voucher.locationId,
  };
  const ledgerBefore = await voucherInventoryLedgerTx(tx, toggleVoucher);
  const deltas = await toggleVoucherStockTx(tx, {
    voucher: toggleVoucher,
    willBeOptional,
    evidenceRevision,
    occurredAt: new Date().toISOString(),
    evidenceActor: {
      userId: actor?.userId ?? undefined,
      username: actor?.username ?? undefined,
      reason: actor?.reason || `${willBeOptional ? "Suspend" : "Activate"} voucher ${voucher.voucherNumber}`,
    },
  });

  await tx.update(vouchers).set({ optional: willBeOptional }).where(eq(vouchers.id, voucher.id));
  await syncStockAdjustmentInventoryTx(tx, voucher.companyId, voucher.id);
  await postOptionalToggleResidualTx(tx, {
    voucher: toggleVoucher,
    evidenceRevision,
    deltas,
    ledgerBefore,
    actor: actor?.userId && actor.username ? { userId: actor.userId, username: actor.username } : null,
  });
}
