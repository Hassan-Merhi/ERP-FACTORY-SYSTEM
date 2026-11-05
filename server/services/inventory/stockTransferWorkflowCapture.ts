/**
 * Plan batch 3 (owner-approved 2026-11-05): evidence for changes to existing
 * stock transfers made on the factory LAN server. Each change is recorded on
 * the "stock" stream in the same transaction as the change itself
 * (server/edge/phase9StockOutbox.ts).
 *
 * Off the LAN primary every helper here is a no-op (or runs the plain
 * service), so the cloud routes behave exactly as before.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { db, type DbTransaction } from "../../db";
import { isPhase9LanPrimary } from "../../edge/phase9PosOutbox";
import {
  capturePhase9StockTransferEditTx,
  capturePhase9StockTransferFinalizeTx,
  capturePhase9StockTransferRevisionReviewTx,
  capturePhase9StockTransferRevisionTx,
  phase9RevisionRefTx,
  phase9TransferRefTx,
  phase9TransferSnapshotTx,
} from "../../edge/phase9StockOutbox";
import type {
  Phase9TransferEditTarget,
  Phase9TransferRevisionBody,
} from "../../edge/phase9StockTransferWorkflowEnvelope.mjs";
import { getClientDate } from "../../lib/dateUtils";
import {
  finalizeOptionalStockTransfer,
  finalizeOptionalStockTransferTx,
  saveStockTransferLifecycle,
  saveStockTransferLifecycleTx,
  type SaveStockTransferLifecycleInput,
  type StockTransferLifecycleResult,
} from "../stockTransferLifecycle";

function actor(req: Request) {
  return {
    companyId: Number(req.session.currentCompanyId),
    actorUserId: String(req.user?.id ?? req.session.userId),
    actorUsername: req.session.username || "unknown",
    requestId: randomUUID(),
    businessDate: getClientDate(req).slice(0, 10),
  };
}

/** PUT /api/stock-transfers/:id: on the LAN primary the edit and its record commit together. */
export async function saveStockTransferWithCapture(
  req: Request,
  input: SaveStockTransferLifecycleInput & { notes: string }
): Promise<StockTransferLifecycleResult> {
  if (!isPhase9LanPrimary()) return saveStockTransferLifecycle(input);
  return db.transaction(async (tx) => {
    const before = await phase9TransferSnapshotTx(tx, input.transferId);
    const saved = await saveStockTransferLifecycleTx(tx, input);
    if (before) {
      const after: Phase9TransferEditTarget = {
        destinationLocationId: input.destinationLocationId,
        notes: input.notes,
        items: input.items.map((item) => ({
          stockItemId: item.stockItemId,
          sourceLocationId: item.sourceLocationId,
          quantity: item.quantity,
          rate: item.rate,
        })),
      };
      await capturePhase9StockTransferEditTx(tx, {
        ...actor(req),
        transfer: await phase9TransferRefTx(tx, input.transferId),
        before,
        after,
      });
    }
    return saved;
  });
}

/** Finalize/approve a transfer voucher: on the LAN primary the finalize and its record commit together. */
export async function finalizeStockTransferWithCapture(
  req: Request,
  companyId: number,
  voucherId: number
): Promise<StockTransferLifecycleResult> {
  if (!isPhase9LanPrimary()) return finalizeOptionalStockTransfer(companyId, voucherId);
  return db.transaction(async (tx) => {
    const found = await tx.execute(sql`SELECT id FROM stock_transfer_vouchers WHERE voucher_id = ${voucherId}`);
    const transferId = Number((found.rows[0] as { id?: number } | undefined)?.id ?? 0);
    const before = transferId ? await phase9TransferSnapshotTx(tx, transferId) : null;
    const result = await finalizeOptionalStockTransferTx(tx, companyId, voucherId);
    // Finalizing an already-final transfer changes nothing, so nothing is recorded.
    if (before && result.transition !== "no-op") {
      await capturePhase9StockTransferFinalizeTx(tx, {
        ...actor(req),
        transfer: await phase9TransferRefTx(tx, transferId),
        before,
      });
    }
    return result;
  });
}

/** Inside the revision service's transaction (its audit hook): record a new revision. */
export async function captureStockTransferRevisionTx(
  req: Request,
  tx: DbTransaction,
  written: { revisionId: number; transferId: number },
  revision: Phase9TransferRevisionBody
): Promise<void> {
  if (!isPhase9LanPrimary()) return;
  await capturePhase9StockTransferRevisionTx(tx, {
    ...actor(req),
    localRevisionId: written.revisionId,
    transfer: await phase9TransferRefTx(tx, written.transferId),
    revision,
  });
}

/** Inside the revision service's transaction (its audit hook): record an approve or reject. */
export async function captureStockTransferRevisionReviewTx(
  req: Request,
  tx: DbTransaction,
  written: { revisionId: number; transition: string },
  decision: "approve" | "reject",
  reason: string | null
): Promise<void> {
  // A review that changed nothing (already approved / rejected) is not recorded.
  if (!isPhase9LanPrimary() || written.transition === "no-op") return;
  await capturePhase9StockTransferRevisionReviewTx(tx, {
    ...actor(req),
    revision: await phase9RevisionRefTx(tx, written.revisionId),
    decision,
    reason: decision === "approve" ? null : reason,
  });
}
