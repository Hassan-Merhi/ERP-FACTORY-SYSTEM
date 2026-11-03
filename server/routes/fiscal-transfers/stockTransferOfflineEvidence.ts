import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { Phase9StockTransferEvidence } from "../../edge/phase9StockEnvelope.mjs";
import { inventoryQuantity } from "../../lib/inventoryMath";
import { toMoney } from "../../lib/money";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The evidence of a stock transfer created on the factory LAN server (owner
 * decision 2026-11-02): the inputs as entered. The request id is the caller's
 * own (when it is a UUID) or a fresh one; the cloud replay uses it as the
 * transfer's idempotency key, so the transfer can never be created twice.
 */
export function stockTransferEvidence(
  req: Pick<Request, "session">,
  created: { transfer: { id: number } },
  input: {
    companyId: number;
    requestId: string | null | undefined;
    items: Array<{ sourceLocationId?: unknown; stockItemId: unknown; quantity: unknown; rate?: unknown }>;
    sourceLocationId: unknown;
    destinationLocationId: unknown;
    effectiveDate: string;
    notes: unknown;
    optional: unknown;
    allowNegativeInventory: unknown;
  }
): Phase9StockTransferEvidence {
  const header = Number(input.sourceLocationId);
  return {
    companyId: input.companyId,
    localTransferId: created.transfer.id,
    actorUserId: String(req.session.userId),
    actorUsername: req.session.username || "unknown",
    requestId: typeof input.requestId === "string" && UUID.test(input.requestId) ? input.requestId : randomUUID(),
    businessDate: String(input.effectiveDate).slice(0, 10),
    sourceLocationId: Number.isSafeInteger(header) && header > 0 ? header : null,
    destinationLocationId: Number(input.destinationLocationId),
    notes: typeof input.notes === "string" && input.notes.trim() ? input.notes : null,
    optional: input.optional === true,
    allowNegativeInventory: input.allowNegativeInventory !== false,
    items: input.items.map((item) => ({
      sourceLocationId: Number(item.sourceLocationId || input.sourceLocationId),
      stockItemId: Number(item.stockItemId),
      quantity: inventoryQuantity(item.quantity as string),
      rate: toMoney(item.rate == null || item.rate === "" ? "0" : String(item.rate))
        .toDecimalPlaces(6)
        .toFixed(),
    })),
  };
}
