/**
 * Linked journal for a stock movement outside the document flows (wave 11).
 *
 * Quick adjustments, silent production/consumption, location imports,
 * stock-group archive/restore, offload cost corrections, re-pricing and the
 * other paths that change the stock sub-ledger without a sale, receipt or
 * stock adjustment voucher post their value change here once the company's
 * perpetual-inventory cut-over applies:
 *
 *   INV-MOVE-{companyId}-{sourceType}-{sourceId}, dated with the movement:
 *     net > 0   Dr Inventory / Cr offset account
 *     net < 0   Dr offset account / Cr Inventory
 *
 * where net is the sum of the lines' valueDelta: the signed change of
 * `inventory.total_value` each `adjustInventory` call reports
 * (`AdjustInventoryResult.valueDelta`), so the ledger moves exactly with the
 * sub-ledger. The offset account is a registry system account
 * (INVENTORY_ADJUSTMENT, INVENTORY_REVALUATION, OPENING_BALANCE_EQUITY, ...).
 *
 * Like the other linked journals the journal is derived from the movement and
 * replaced whole on every call (remove, then post), under a deterministic
 * posting identity in accounting_posting_requests, in the caller's
 * transaction. Nothing is posted for a supplier-partner company, a movement
 * dated before the cut-over or a zero net; any earlier journal of the source
 * is still removed then.
 *
 * Wave 15 (M1): every call also records its lines, dated with the movement,
 * in `inventory_value_movements`, before and after the cut-over and whether a
 * journal is posted or not, replacing the source's earlier evidence like the
 * journal. These movements leave no document line, so the as-of stock
 * valuation (calculateHistoricalLocationInventory, companyStockValuationAsOf)
 * replays them from this evidence.
 */
import { sql } from "drizzle-orm";

import { auditLog } from "@shared/schema";

import type { DbTransaction } from "../../../db";
import type { AdjustInventoryResult } from "../../../inventoryHelper";
import { MoneyDecimal, toMoney, type MoneyInput } from "../../../lib/money";
import { getOrCreateInventoryControlAccount } from "../inventoryControlAccount";
import { systemAccountDefinition } from "../systemAccounts";
import { isPerpetualInventoryActive } from "./cutover";
import {
  isSupplierPartnerCompany,
  postLinkedJournalTx,
  removeLinkedJournalTx,
  systemAccountIdsTx,
} from "./linkedJournal";

export interface InventoryMovementLine {
  stockItemId?: number | null;
  locationId?: number | null;
  /** Signed change of the sub-ledger value (positive = stock value received). */
  valueDelta: MoneyInput;
  /** Signed change of the row's quantity, when the movement moved quantity (evidence for the as-of replay). */
  quantityDelta?: MoneyInput | null;
}

export interface InventoryMovementSource {
  companyId: number;
  /** Stable kind of movement, e.g. "quick-adjust" (letters, digits, "_" and "-"). */
  sourceType: string;
  /** Stable id of the movement within its kind (letters, digits, "_", "-", ":" and "."). */
  sourceId: string | number;
}

export interface InventoryMovementJournalParams extends InventoryMovementSource {
  /** Movement date, YYYY-MM-DD. Decides whether the cut-over applies. */
  date: string;
  /** Human reference shown in the journal description (document number, item code, ...). */
  reference: string;
  lines: InventoryMovementLine[];
  /** Registry system account code of the contra side; never INVENTORY. */
  offsetAccountCode: string;
  narration: string;
  /** Who made the movement; recorded in the audit log with the journal. */
  actor?: { userId: string; username: string } | null;
  /** Voucher location (optional). */
  locationId?: number | null;
}

export interface InventoryMovementJournalResult {
  voucherId: number;
  voucherNumber: string;
  /** Net amount posted to Inventory, signed (positive = debit), 2dp. */
  net: string;
}

export const INVALID_SOURCE_MESSAGE = "The inventory movement has an invalid company or source";
export const INVALID_OFFSET_MESSAGE =
  "The offset of an inventory movement must be a registry account other than Inventory";

const SOURCE_TYPE = /^[A-Za-z0-9_-]{1,40}$/;
const SOURCE_ID = /^[A-Za-z0-9_.:-]{1,40}$/;

/** The deterministic journal number of a movement. */
export function inventoryMovementVoucherNumber(source: InventoryMovementSource): string {
  const sourceId = String(source.sourceId);
  if (
    !Number.isInteger(source.companyId) ||
    source.companyId <= 0 ||
    !SOURCE_TYPE.test(source.sourceType) ||
    !SOURCE_ID.test(sourceId)
  ) {
    throw new Error(INVALID_SOURCE_MESSAGE);
  }
  return `INV-MOVE-${source.companyId}-${source.sourceType}-${sourceId}`;
}

const identitySourceType = (sourceType: string) => `perpetual-inventory-movement:${sourceType}`;

/** A movement line from an adjustInventory result. */
export function inventoryMovementLine(
  result: Pick<AdjustInventoryResult, "valueDelta"> & { previousQuantity?: MoneyInput; newQuantity?: MoneyInput },
  ids: { stockItemId?: number | null; locationId?: number | null } = {}
): InventoryMovementLine {
  const quantityDelta =
    result.previousQuantity === undefined || result.newQuantity === undefined
      ? null
      : toMoney(result.newQuantity).minus(toMoney(result.previousQuantity)).toDecimalPlaces(3).toFixed(3);
  return {
    stockItemId: ids.stockItemId ?? null,
    locationId: ids.locationId ?? null,
    valueDelta: result.valueDelta,
    quantityDelta,
  };
}

/** The net value of movement lines, 2dp. */
export function inventoryMovementNet(lines: readonly InventoryMovementLine[]) {
  return lines.reduce((sum, line) => sum.plus(toMoney(line.valueDelta)), new MoneyDecimal(0)).toDecimalPlaces(2);
}

/** Removes a movement's journal and its posting identity, if any. */
export async function removeInventoryMovementJournalTx(
  tx: DbTransaction,
  source: InventoryMovementSource
): Promise<void> {
  await removeLinkedJournalTx(tx, source.companyId, inventoryMovementVoucherNumber(source));
}

/**
 * Records (replacing any earlier evidence of the source) the movement's lines,
 * dated with the movement, for the as-of replay. Lines that move neither value
 * nor quantity are not recorded.
 */
async function recordInventoryValueMovementsTx(
  tx: DbTransaction,
  params: InventoryMovementJournalParams,
  voucherNumber: string
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM inventory_value_movements WHERE company_id = ${params.companyId} AND source_number = ${voucherNumber}
  `);
  for (const line of params.lines) {
    const value = toMoney(line.valueDelta).toDecimalPlaces(2);
    const quantity =
      line.quantityDelta === null || line.quantityDelta === undefined
        ? null
        : toMoney(line.quantityDelta).toDecimalPlaces(3);
    if (value.isZero() && (quantity === null || quantity.isZero())) continue;
    await tx.execute(sql`
      INSERT INTO inventory_value_movements
        (company_id, source_number, source_type, source_id, movement_date, stock_item_id, location_id,
         quantity_delta, value_delta)
      VALUES (${params.companyId}, ${voucherNumber}, ${params.sourceType}, ${String(params.sourceId)},
              ${params.date}::date, ${line.stockItemId ?? null}, ${line.locationId ?? null},
              ${quantity === null ? null : quantity.toFixed(3)}, ${value.toFixed(2)})
    `);
  }
}

/**
 * Posts (replacing any earlier one) the linked journal of a stock movement.
 * Returns null when nothing is posted (see the module comment). The movement's
 * evidence is recorded in every case.
 */
export async function postInventoryMovementJournalTx(
  tx: DbTransaction,
  params: InventoryMovementJournalParams
): Promise<InventoryMovementJournalResult | null> {
  const voucherNumber = inventoryMovementVoucherNumber(params);
  if (params.offsetAccountCode === "INVENTORY" || !systemAccountDefinition(params.offsetAccountCode)) {
    throw new Error(INVALID_OFFSET_MESSAGE);
  }
  await removeLinkedJournalTx(tx, params.companyId, voucherNumber);
  await recordInventoryValueMovementsTx(tx, params, voucherNumber);
  if (!(await isPerpetualInventoryActive(tx, params.companyId, params.date))) return null;
  if (await isSupplierPartnerCompany(tx, params.companyId)) return null;
  const net = inventoryMovementNet(params.lines);
  if (net.isZero()) return null;

  const offsetAccountId = (await systemAccountIdsTx(tx, params.companyId, [params.offsetAccountCode])).get(
    params.offsetAccountCode
  )!;
  const { id: inventoryAccountId } = await getOrCreateInventoryControlAccount(tx, params.companyId);
  const zero = new MoneyDecimal(0);
  const amount = net.abs();
  const description = [params.narration, params.reference].filter(Boolean).join(" - ");
  const voucherId = await postLinkedJournalTx(tx, {
    companyId: params.companyId,
    voucherNumber,
    voucherDate: params.date,
    description,
    identity: { sourceType: identitySourceType(params.sourceType), sourceId: `${params.companyId}:${params.sourceId}` },
    locationId: params.locationId ?? null,
    lines: [
      {
        ledgerAccountId: inventoryAccountId,
        debit: net.isPositive() ? amount : zero,
        credit: net.isNegative() ? amount : zero,
        narration: description,
      },
      {
        ledgerAccountId: offsetAccountId,
        debit: net.isNegative() ? amount : zero,
        credit: net.isPositive() ? amount : zero,
        narration: description,
      },
    ],
  });
  if (voucherId === null) return null;

  await tx.insert(auditLog).values({
    userId: params.actor?.userId ?? "system",
    username: params.actor?.username ?? "inventory-movement-journal",
    companyId: params.companyId,
    action: "post",
    tableName: "inventory_movement_journal",
    recordId: voucherId,
    recordIdentifier: voucherNumber,
    changes: {
      sourceType: { new: params.sourceType },
      sourceId: { new: String(params.sourceId) },
      offsetAccountCode: { new: params.offsetAccountCode },
      net: { new: net.toFixed(2) },
      lines: {
        new: params.lines.map((line) => ({
          stockItemId: line.stockItemId ?? null,
          locationId: line.locationId ?? null,
          valueDelta: toMoney(line.valueDelta).toFixed(2),
        })),
      },
    },
  });
  return { voucherId, voucherNumber, net: net.toFixed(2) };
}
