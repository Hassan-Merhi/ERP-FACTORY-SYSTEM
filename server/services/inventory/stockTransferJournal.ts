import { nextCanonicalSourceRevision } from "./canonicalSourceRevision";
import { createDatabaseStockMovementAdapter } from "./databaseStockMovementAdapter";
import { postStockMovementTx } from "./stockMovementIntegrityService";
import type { CompanyScopedTransaction } from "../security/transactionCompanyScope";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export const STOCK_TRANSFER_SOURCE_TYPE = "stock-transfer";

export interface StockTransferJournalLeg {
  stockItemId: number;
  quantity: number;
  rate?: number | null;
}

/**
 * Canonical evidence for one leg of a stock transfer.
 *
 * Creating a transfer has written these rows since the journal existed. The
 * paths that move the stock back — editing, unposting, deleting, revising —
 * wrote none, so the journal recorded the issue and never the return. A
 * transfer edited from ten units to two left evidence saying ten moved, and
 * because reconciliation compares the document against the journal rather than
 * the other way round, that is not a discrepancy it reports; it is one it
 * cannot see, and the document quietly wins.
 *
 * The journal is append-only, so each phase appends under its own revision
 * rather than rewriting what the original posting recorded. Callers take a
 * revision once per operation and pass it to every leg, so the reversal and the
 * reissue of a single edit read back as one event.
 */
export async function journalStockTransferLeg(
  tx: CompanyScopedTransaction,
  input: {
    companyId: number;
    transferId: number;
    revision: number;
    phase: "issue" | "reverse";
    fromLocationId: number;
    toLocationId: number;
    leg: StockTransferJournalLeg;
  }
): Promise<void> {
  // A leg whose source and destination are the same location moves nothing
  // between locations and has no balanced pair to record. The create path
  // declines to invent a movement there and so does this.
  if (input.fromLocationId === input.toLocationId) return;
  if (!Number.isFinite(input.leg.quantity) || input.leg.quantity === 0) return;

  await postStockMovementTx(
    tx,
    {
      companyId: input.companyId,
      stockItemId: input.leg.stockItemId,
      kind: "transfer",
      quantity: Math.abs(input.leg.quantity).toFixed(3),
      unitCost: Number(input.leg.rate ?? 0).toFixed(2),
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      occurredAt: new Date().toISOString(),
      source: {
        sourceType: STOCK_TRANSFER_SOURCE_TYPE,
        sourceId: String(input.transferId),
        idempotencyKey: `${STOCK_TRANSFER_SOURCE_TYPE}:${input.transferId}:rev${input.revision}:${input.phase}:${input.leg.stockItemId}`,
      },
      // The journal records what the transfer did. Stock transfers deliberately
      // permit negative inventory, and evidence must not impose a rule the
      // operation itself does not enforce.
      allowNegativeStock: true,
    },
    canonicalStockMovementAdapter
  );
}

/** The revision index this operation's legs should share. */
export function nextStockTransferRevision(
  tx: CompanyScopedTransaction,
  companyId: number,
  transferId: number
): Promise<number> {
  return nextCanonicalSourceRevision(tx, companyId, STOCK_TRANSFER_SOURCE_TYPE, String(transferId));
}
