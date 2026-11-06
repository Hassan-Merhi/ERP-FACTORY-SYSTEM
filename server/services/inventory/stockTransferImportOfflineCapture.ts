/**
 * Plan batch 3 (owner-approved 2026-11-05): an Excel stock-transfer import on
 * the factory LAN server. The online import posts through its own code; on
 * the LAN each imported transfer goes through the same code as a transfer
 * typed by hand (createStockTransferTx) and is recorded as an ordinary
 * stock.transfer.v1 record in the same transaction. The cloud replays it with
 * the checks proven for single transfers, so a cloud shortfall is held, as
 * for any offline transfer.
 */
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { db } from "../../db";
import { capturePhase9StockTransferTx } from "../../edge/phase9StockOutbox";
import { stockTransferEvidence } from "../../routes/fiscal-transfers/stockTransferOfflineEvidence";
import type { Decimal } from "../../routes/stockTransferImportQuantity";
import { createStockTransferTx } from "./createStockTransfer";

export interface LanImportedTransferInput {
  companyId: number;
  destinationLocationId: number;
  transferDate: string;
  notes: unknown;
  lines: ReadonlyArray<{ stockItemId: number; sourceLocationId: number; quantity: Decimal; rate: Decimal }>;
}

export async function importStockTransferOnLan(req: Request, input: LanImportedTransferInput) {
  const requestId = randomUUID();
  const items = input.lines.map((line) => ({
    stockItemId: line.stockItemId,
    sourceLocationId: line.sourceLocationId,
    quantity: line.quantity.toFixed(),
    rate: line.rate.toFixed(),
  }));
  const sources = new Set(items.map((item) => item.sourceLocationId));
  const header = sources.size === 1 ? [...sources][0] : null;
  const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes : null;
  return db.transaction(async (tx) => {
    const created = await createStockTransferTx(tx, {
      companyId: input.companyId,
      requestId,
      items,
      sourceLocationId: header,
      destinationLocationId: input.destinationLocationId,
      resolvedHeaderSourceId: header,
      effectiveDate: input.transferDate,
      notes,
      optional: false,
      // The online import moves stock below zero too; the cloud holds any shortfall for review.
      allowNegativeInventory: true,
      actorUserId: String(req.session.userId),
    });
    await capturePhase9StockTransferTx(
      tx,
      stockTransferEvidence(req, created, {
        companyId: input.companyId,
        requestId,
        items,
        sourceLocationId: header,
        destinationLocationId: input.destinationLocationId,
        effectiveDate: input.transferDate,
        notes,
        optional: false,
        allowNegativeInventory: true,
      })
    );
    return created;
  });
}
