import { and, eq } from "drizzle-orm";
import { inventory } from "@shared/schema";

import type { DbTransaction } from "../../db";
import { adjustInventory } from "../../inventoryHelper";
import { inventoryQuantity } from "../../lib/inventoryMath";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import {
  inventoryMovementLine,
  postInventoryMovementJournalTx,
} from "../../services/accounting/perpetualInventory/inventoryMovementJournal";
import { writeAuditEvent } from "../../services/audit";
import { InventoryRouteError } from "./inventoryErrors";
import type { InventoryAuditActor } from "./inventoryRequestContext";
import { parseMoneyInput, toMoney } from "../../lib/money";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export interface QuickAdjustmentCoreInput {
  companyId: number;
  stockItem: { id: number; code: string };
  location: { id: number; name: string };
  direction: "add" | "subtract";
  quantity: number | string;
  actor: InventoryAuditActor;
  /** Identifies the movement for idempotency; the LAN operation id when replayed. */
  operationId: string;
  /** ISO instant the movement happened (the LAN commit time when replayed). */
  occurredAt: string;
  /** Only an Admin/Developer approve-override decision may set this. */
  allowNegative: boolean;
}

export interface QuickAdjustmentCoreResult {
  previousQuantity: number;
  newQuantity: number;
  adjustedQuantity: number;
  normalizedQuantity: string;
  movementId: number;
}

/** Thrown when a subtraction would take this location's stock below zero. */
/** An internal invariant broke (a machine code, never shown to users verbatim). */
export class QuickAdjustmentInvariantError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QuickAdjustmentInvariantError";
  }
}

export class QuickAdjustmentNegativeStockError extends InventoryRouteError {
  constructor(
    readonly requested: number,
    readonly available: number
  ) {
    super(400, `Cannot subtract ${requested} units. Only ${available} units available at this location.`);
  }
}

export function quickAdjustmentIdempotencyKey(companyId: number, operationId: string): string {
  return `inventory-quick-adjust:${companyId}:${operationId}`;
}

/**
 * The single implementation of a quick adjustment: inventory balance, the
 * canonical stock movement, the perpetual-inventory journal and the audit,
 * all on the caller's transaction. Used by the live route and by the Phase 9
 * cloud replay of a factory LAN movement, so both produce identical effects.
 */
export async function applyQuickAdjustmentCoreTx(
  tx: DbTransaction,
  input: QuickAdjustmentCoreInput
): Promise<QuickAdjustmentCoreResult> {
  const { companyId, stockItem, location } = input;
  const [existingInventory] = await tx
    .select()
    .from(inventory)
    .where(and(eq(inventory.stockItemId, stockItem.id), eq(inventory.locationId, location.id)))
    .limit(1);

  const normalizedQuantity = parseMoneyInput(inventoryQuantity(input.quantity))?.toNumber() ?? NaN;
  if (!Number.isFinite(normalizedQuantity) || normalizedQuantity <= 0) {
    throw new InventoryRouteError(400, "Quantity must be at least 0.001 units.");
  }

  const currentQuantity = existingInventory ? toMoney(existingInventory.quantity).toNumber() : 0;
  const adjustedQuantity = input.direction === "add" ? normalizedQuantity : -normalizedQuantity;
  const newQuantity = currentQuantity + adjustedQuantity;
  if (newQuantity < 0 && !input.allowNegative) {
    throw new QuickAdjustmentNegativeStockError(normalizedQuantity, currentQuantity);
  }

  const preAdjustmentRate = existingInventory ? toMoney(existingInventory.averageRate).toNumber() : 0;
  const adjustment = await adjustInventory(tx, location.id, stockItem.id, adjustedQuantity, companyId);
  const movementUnitCost =
    input.direction === "subtract" && Number.isFinite(preAdjustmentRate)
      ? Math.max(preAdjustmentRate, 0)
      : adjustment.averageRate;
  const movement = await postStockMovementTx(
    tx,
    {
      companyId,
      stockItemId: stockItem.id,
      kind: "adjustment",
      quantity: inventoryQuantity(normalizedQuantity),
      unitCost: String(movementUnitCost),
      fromLocationId: input.direction === "subtract" ? location.id : undefined,
      toLocationId: input.direction === "add" ? location.id : undefined,
      occurredAt: input.occurredAt,
      source: {
        sourceType: "inventory_quick_adjustment",
        sourceId: input.operationId,
        idempotencyKey: quickAdjustmentIdempotencyKey(companyId, input.operationId),
      },
      allowNegativeStock: true,
    },
    canonicalStockMovementAdapter
  );
  // Wave 11: under perpetual inventory the ledger moves with the sub-ledger
  // (Dr/Cr Inventory against INVENTORY_ADJUSTMENT), in this transaction.
  const journal = await postInventoryMovementJournalTx(tx, {
    companyId,
    sourceType: "quick-adjust",
    sourceId: input.operationId,
    date: input.occurredAt.slice(0, 10),
    reference: `${stockItem.code} @ ${location.name}`,
    lines: [inventoryMovementLine(adjustment, { stockItemId: stockItem.id, locationId: location.id })],
    offsetAccountCode: "INVENTORY_ADJUSTMENT",
    narration: "Inventory quick adjustment",
    actor: input.actor,
    locationId: location.id,
  });
  // The audit is written with the movement: both commit or neither does.
  await writeAuditEvent(
    {
      ...input.actor,
      companyId,
      action: "update",
      tableName: "inventory",
      recordId: stockItem.id,
      recordIdentifier: `${stockItem.code} @ ${location.name}`,
      changes: {
        item: { old: stockItem.code, new: stockItem.code },
        location: { new: location.name },
        adjustmentType: { new: input.direction === "add" ? "Add Stock" : "Subtract Stock" },
        quantity: { old: String(adjustment.previousQuantity), new: String(adjustment.newQuantity) },
        adjustment: { new: `${input.direction === "add" ? "+" : "-"}${Math.abs(adjustedQuantity)}` },
        valueDelta: { new: adjustment.valueDelta },
        ...(journal ? { journal: { new: journal.voucherNumber } } : {}),
      },
    },
    tx
  );
  const movementId = movement.movements[0]?.id;
  if (!Number.isSafeInteger(movementId) || movementId < 1) {
    throw new QuickAdjustmentInvariantError("QUICK_ADJUST_MOVEMENT_NOT_RECORDED");
  }
  return {
    previousQuantity: adjustment.previousQuantity,
    newQuantity: adjustment.newQuantity,
    adjustedQuantity,
    normalizedQuantity: inventoryQuantity(normalizedQuantity),
    movementId,
  };
}
