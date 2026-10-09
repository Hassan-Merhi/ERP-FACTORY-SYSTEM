/**
 * The stock side of the stock-transfer Excel imports (wave 15, H2).
 *
 * Both import routes (single source and multi-source) move their lines
 * through moveTransferLegConservedTx, like every other transfer writer: the
 * destination receives exactly the value the source relieved, each line
 * records it as value_moved (so a later edit, unpost or delete moves exactly
 * that back), and the net of the legs (a short destination's settlement
 * variance) is posted as an INV-MOVE journal against COGS
 * (postTransferResidualTx, a no-op before the cut-over). They used to issue
 * the source at its average and receive the destination at the source's 2dp
 * rate, or at the item's selling price when the source had no row: the
 * destination could hold value the source never gave up.
 *
 * After the company's perpetual cut-over (for the transfer's date) a line
 * whose source location has no inventory row for the item is refused (409
 * STOCK_TRANSFER_IMPORT_SOURCE_MISSING): there is no cost to move, and the
 * selling-price fallback would put a sales price on the stock. Before the
 * cut-over the fallback stays as the short source's cost memory (the source
 * carries the negative value, so nothing is created). A factory bale-mirror
 * item is refused after the cut-over (assertNoBaleMirrorMovementTx).
 */
import type Decimal from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";

import { inventory, stockTransferItems } from "@shared/schema";

import type { DbTransaction } from "../db";
import { HttpError } from "../lib/httpHandlers";
import { MoneyDecimal } from "../lib/money";
import { assertNoBaleMirrorMovementTx } from "../services/accounting/perpetualInventory/cutoverRefusal";
import { isPerpetualInventoryActive } from "../services/accounting/perpetualInventory/cutover";
import { moveTransferLegConservedTx, postTransferResidualTx } from "../services/inventory/conservedStockTransfer";
import { createDatabaseStockMovementAdapter } from "../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../services/inventory/stockMovementIntegrityService";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export const STOCK_TRANSFER_IMPORT_SOURCE_MISSING = "STOCK_TRANSFER_IMPORT_SOURCE_MISSING" as const;
export const STOCK_TRANSFER_IMPORT_SOURCE_MISSING_MESSAGE =
  "A stock transfer from a location that holds no stock of the item cannot be imported after the company's perpetual inventory cut-over: there is no cost to move.";

export class StockTransferImportSourceMissingError extends HttpError {
  readonly code = STOCK_TRANSFER_IMPORT_SOURCE_MISSING;
  constructor(readonly lines: Array<{ stockItemId: number; sourceLocationId: number }>) {
    super(409, STOCK_TRANSFER_IMPORT_SOURCE_MISSING_MESSAGE);
    this.name = "StockTransferImportSourceMissingError";
  }
}

export interface ImportedTransferLine {
  stockItemId: number;
  sourceLocationId: number;
  quantity: Decimal;
  /** The document rate: the source's average, else the fallback cost memory. */
  rate: Decimal;
}

export interface ImportedTransferPosting {
  companyId: number;
  voucherId: number;
  transferId: number;
  destinationLocationId: number;
  /** The transfer's date (YYYY-MM-DD): movement date and cut-over test. */
  date: string;
  lines: readonly ImportedTransferLine[];
  movementSourceType: string;
  idempotencyPrefix: string;
  actor: { userId?: string; username?: string; reason: string };
}

/** Writes the transfer's lines and moves their stock (see the module comment). */
export async function postImportedTransferLinesTx(tx: DbTransaction, posting: ImportedTransferPosting): Promise<void> {
  const { companyId } = posting;
  await assertNoBaleMirrorMovementTx(
    tx,
    companyId,
    posting.lines.map((line) => line.stockItemId),
    "stock-transfer-import"
  );

  if (await isPerpetualInventoryActive(tx, companyId, posting.date)) {
    const sourceIds = [...new Set(posting.lines.map((line) => line.sourceLocationId))];
    const itemIds = [...new Set(posting.lines.map((line) => line.stockItemId))];
    const held = await tx
      .select({ locationId: inventory.locationId, stockItemId: inventory.stockItemId })
      .from(inventory)
      .where(
        and(
          eq(inventory.companyId, companyId),
          inArray(inventory.locationId, sourceIds),
          inArray(inventory.stockItemId, itemIds)
        )
      );
    const rows = new Set(held.map((row) => `${row.locationId}:${row.stockItemId}`));
    const missing = posting.lines
      .filter((line) => !rows.has(`${line.sourceLocationId}:${line.stockItemId}`))
      .map((line) => ({ stockItemId: line.stockItemId, sourceLocationId: line.sourceLocationId }));
    if (missing.length > 0) throw new StockTransferImportSourceMissingError(missing);
  }

  const deltas: Decimal[] = [];
  for (const line of posting.lines) {
    const moved = await moveTransferLegConservedTx(tx, {
      companyId,
      sourceLocationId: line.sourceLocationId,
      destinationLocationId: posting.destinationLocationId,
      stockItemId: line.stockItemId,
      quantity: line.quantity,
      fallbackRate: line.rate,
      sourceVoucherType: "Stock Transfer",
      sourceVoucherId: posting.voucherId,
    });
    deltas.push(moved.sourceDelta, moved.destinationDelta);

    const [transferItem] = await tx
      .insert(stockTransferItems)
      .values({
        transferId: posting.transferId,
        stockItemId: line.stockItemId,
        sourceLocationId: line.sourceLocationId,
        quantity: line.quantity.toFixed(),
        rate: line.rate.toFixed(),
        totalAmount: line.quantity.times(line.rate).toFixed(),
        valueMoved: moved.relieved.toFixed(2),
      })
      .returning({ id: stockTransferItems.id });

    const unitCost = moved.relieved.gt(0) ? moved.rate : line.rate;
    await postStockMovementTx(
      tx,
      {
        companyId,
        stockItemId: line.stockItemId,
        kind: "transfer",
        quantity: line.quantity.toFixed(),
        unitCost: (unitCost.greaterThan(0) ? unitCost : new MoneyDecimal(0)).toFixed(),
        fromLocationId: line.sourceLocationId,
        toLocationId: posting.destinationLocationId,
        occurredAt: new Date(`${posting.date}T00:00:00.000Z`).toISOString(),
        source: {
          sourceType: posting.movementSourceType,
          sourceId: String(posting.voucherId),
          idempotencyKey: `${posting.idempotencyPrefix}:${posting.voucherId}:${transferItem.id}`,
        },
        actor: posting.actor,
        allowNegativeStock: true,
      },
      canonicalStockMovementAdapter
    );
  }

  await postTransferResidualTx(tx, {
    companyId,
    transferId: posting.transferId,
    date: posting.date,
    reference: `Transfer ${posting.transferId}`,
    deltas,
  });
}
