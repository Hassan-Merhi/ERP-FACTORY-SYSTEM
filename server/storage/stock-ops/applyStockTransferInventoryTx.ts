// Extracted from ./transfers-create.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  addInventoryValues,
  inventoryQuantity,
  inventoryUnitCost,
  multiplyInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import * as schema from "@shared/schema";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import { lockInventoryRow } from "../inventoryRowLock";
import { assertNoBaleMirrorMovementTx } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import {
  moveTransferLegConservedTx,
  postTransferResidualTx,
  recordTransferValueMovedTx,
  transferVoucherDateTx,
} from "../../services/inventory/conservedStockTransfer";

export const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

/**
 * A second stock adjustment was created for a voucher that already had one.
 *
 * The route checks for this before it calls in, but a check made in one
 * connection and an insert made in another are two separate moments: two
 * submissions arriving together both find nothing and both apply their items to
 * inventory. The check below is made under a lock on the voucher row inside the
 * same transaction as the insert, so the second one loses.
 */
export class DuplicateStockAdjustmentError extends Error {
  readonly code = "STOCK_ADJUSTMENT_ALREADY_EXISTS";

  constructor(voucherId: number) {
    super(`Voucher ${voucherId} already has a stock adjustment`);
    this.name = "DuplicateStockAdjustmentError";
  }
}

/**
 * A second stock transfer document was created for a voucher that already had
 * one. The endpoint that attaches items to an existing voucher had no guard at
 * all: submitting it twice built a second transfer and moved the stock again.
 */
export class DuplicateStockTransferError extends Error {
  readonly code = "STOCK_TRANSFER_ALREADY_EXISTS";

  constructor(voucherId: number) {
    super(`Voucher ${voucherId} already has a stock transfer`);
    this.name = "DuplicateStockTransferError";
  }
}

export class StockTransferPolicyError extends Error {
  constructor(
    readonly code: "STOCK_TRANSFER_SCOPE_INVALID" | "STOCK_TRANSFER_NEGATIVE_STOCK_DISABLED",
    message: string
  ) {
    super(message);
    this.name = "StockTransferPolicyError";
  }
}

export type TransferMovementItem = {
  sourceLocationId: number;
  stockItemId: number;
  quantity: string;
  rate: string;
};

function groupTransferMovementItems(items: TransferMovementItem[]): TransferMovementItem[] {
  const grouped = new Map<
    string,
    {
      sourceLocationId: number;
      stockItemId: number;
      quantity: ReturnType<typeof toInventoryDecimal>;
      value: ReturnType<typeof toInventoryDecimal>;
    }
  >();

  for (const item of items) {
    const quantity = toInventoryDecimal(item.quantity);
    const rate = toInventoryDecimal(item.rate);
    const key = `${item.sourceLocationId}:${item.stockItemId}`;
    const existing = grouped.get(key);
    const value = multiplyInventoryValues(quantity, rate);
    if (existing) {
      existing.quantity = addInventoryValues(existing.quantity, quantity);
      existing.value = addInventoryValues(existing.value, value);
    } else {
      grouped.set(key, {
        sourceLocationId: item.sourceLocationId,
        stockItemId: item.stockItemId,
        quantity,
        value,
      });
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => a.sourceLocationId - b.sourceLocationId || a.stockItemId - b.stockItemId)
    .map((item) => ({
      sourceLocationId: item.sourceLocationId,
      stockItemId: item.stockItemId,
      quantity: inventoryQuantity(item.quantity),
      rate: inventoryUnitCost(item.quantity.isZero() ? toInventoryDecimal(0) : item.value.dividedBy(item.quantity)),
    }));
}

export async function assertTransferCompanyScopeTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: number,
  destinationLocationId: number,
  items: TransferMovementItem[]
): Promise<void> {
  const locationIds = Array.from(new Set([destinationLocationId, ...items.map((item) => item.sourceLocationId)]));
  const validLocations = await tx
    .select({ id: schema.locations.id })
    .from(schema.locations)
    .where(
      and(
        eq(schema.locations.companyId, companyId),
        inArray(schema.locations.id, locationIds),
        isNull(schema.locations.deletedAt)
      )
    );
  if (validLocations.length !== locationIds.length) {
    throw new StockTransferPolicyError(
      "STOCK_TRANSFER_SCOPE_INVALID",
      "One or more transfer locations do not belong to the active company"
    );
  }

  const stockItemIds = Array.from(new Set(items.map((item) => item.stockItemId)));
  const validItems = await tx
    .select({ id: schema.stockItems.id })
    .from(schema.stockItems)
    .where(
      and(
        eq(schema.stockItems.companyId, companyId),
        inArray(schema.stockItems.id, stockItemIds),
        isNull(schema.stockItems.deletedAt)
      )
    );
  if (validItems.length !== stockItemIds.length) {
    throw new StockTransferPolicyError(
      "STOCK_TRANSFER_SCOPE_INVALID",
      "One or more stock items do not belong to the active company"
    );
  }
}

/**
 * Canonical stock-transfer movement path shared by both create routes.
 *
 * Every existing inventory row is locked before the first mutation. A missing
 * source is treated as a zero balance: it can become a negative row only when
 * the caller explicitly permits negative stock, otherwise the whole transaction
 * is rejected before either side changes.
 */
export async function applyStockTransferInventoryTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    companyId: number;
    transferId: number;
    sourceVoucherId: number;
    destinationLocationId: number;
    items: TransferMovementItem[];
    allowNegativeInventory: boolean;
  }
): Promise<void> {
  const movementItems = groupTransferMovementItems(input.items);
  await assertTransferCompanyScopeTx(tx, input.companyId, input.destinationLocationId, movementItems);
  // Wave 11: a factory bale-mirror item is moved in the factory after the cut-over.
  await assertNoBaleMirrorMovementTx(
    tx,
    input.companyId,
    movementItems.map((item) => item.stockItemId),
    "stock-transfer"
  );

  const lockKeys = new Map<string, { locationId: number; stockItemId: number }>();
  for (const item of movementItems) {
    lockKeys.set(`${item.sourceLocationId}:${item.stockItemId}`, {
      locationId: item.sourceLocationId,
      stockItemId: item.stockItemId,
    });
    lockKeys.set(`${input.destinationLocationId}:${item.stockItemId}`, {
      locationId: input.destinationLocationId,
      stockItemId: item.stockItemId,
    });
  }

  const lockedRows = new Map<string, Awaited<ReturnType<typeof lockInventoryRow>>>();
  const orderedLocks = Array.from(lockKeys.values()).sort(
    (a, b) => a.locationId - b.locationId || a.stockItemId - b.stockItemId
  );
  for (const key of orderedLocks) {
    lockedRows.set(`${key.locationId}:${key.stockItemId}`, await lockInventoryRow(tx, key.locationId, key.stockItemId));
  }

  if (!input.allowNegativeInventory) {
    for (const item of movementItems) {
      const source = lockedRows.get(`${item.sourceLocationId}:${item.stockItemId}`);
      const available = toInventoryDecimal(source?.quantity ?? "0");
      const required = toInventoryDecimal(item.quantity);
      if (available.lessThan(required)) {
        throw new StockTransferPolicyError(
          "STOCK_TRANSFER_NEGATIVE_STOCK_DISABLED",
          `Location ${item.sourceLocationId} has ${inventoryQuantity(available)} available for stock item ${item.stockItemId}, but ${inventoryQuantity(required)} is required`
        );
      }
    }
  }

  // Wave 11: the destination receives exactly the value the source relieved,
  // and each line records it as value_moved (see conservedStockTransfer).
  const relievedByGroup = new Map<string, Decimal>();
  const deltas: Decimal[] = [];
  for (const item of movementItems) {
    const quantity = toInventoryDecimal(item.quantity);
    const rate = toInventoryDecimal(item.rate);

    const sourceWasMissing = !lockedRows.get(`${item.sourceLocationId}:${item.stockItemId}`);

    // The transfer's historical rate is only the cost memory of a source that
    // has no row (the negative layer's provisional rate); the destination is
    // valued at what the source relieved.
    const moved = await moveTransferLegConservedTx(tx, {
      companyId: input.companyId,
      sourceLocationId: item.sourceLocationId,
      destinationLocationId: input.destinationLocationId,
      stockItemId: item.stockItemId,
      quantity,
      fallbackRate: rate,
      sourceVoucherType: "Stock Transfer",
      sourceVoucherId: input.sourceVoucherId,
    });
    relievedByGroup.set(`${item.sourceLocationId}:${item.stockItemId}`, moved.relieved);
    deltas.push(moved.sourceDelta, moved.destinationDelta);
    // Wave 15 (H3): a source with no row goes short at the transfer's rate
    // and keeps that negative value (negative-stock policy), exactly what the
    // destination received. It used to be reset to zero after the move, which
    // left the destination's value standing on nothing: value created from a
    // transfer, with no journal.

    await postStockMovementTx(
      tx,
      {
        companyId: input.companyId,
        stockItemId: item.stockItemId,
        kind: "transfer",
        quantity: inventoryQuantity(quantity),
        unitCost: inventoryUnitCost(sourceWasMissing ? rate : moved.rate),
        fromLocationId: item.sourceLocationId,
        toLocationId: input.destinationLocationId,
        occurredAt: new Date().toISOString(),
        source: {
          sourceType: "stock-transfer",
          sourceId: String(input.transferId),
          idempotencyKey: `stock-transfer:${input.transferId}:${item.stockItemId}:${item.sourceLocationId}:${input.destinationLocationId}`,
        },
        allowNegativeStock: true,
      },
      canonicalStockMovementAdapter
    );
  }
  await recordTransferValueMovedTx(tx, input.transferId, relievedByGroup);
  await postTransferResidualTx(tx, {
    companyId: input.companyId,
    transferId: input.transferId,
    date: await transferVoucherDateTx(tx, input.companyId, input.sourceVoucherId),
    reference: `Transfer ${input.transferId}`,
    deltas,
  });
}
