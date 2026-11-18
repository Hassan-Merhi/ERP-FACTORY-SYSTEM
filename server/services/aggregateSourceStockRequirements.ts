// Extracted from ./stockTransferLifecycle.ts to keep that module under the source-size cap.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { reverseTransferLegExactTx } from "./inventory/conservedStockTransfer";
import { lineValueMoved } from "./inventory/valueExactReversal";
import { locations, stockItems, stockTransferItems } from "@shared/schema";
import { journalStockTransferLeg } from "./inventory/stockTransferJournal";
import { db, type DbTransaction } from "../db";
import { firstRow } from "../lib/queryResult";
import { lineAmount, MoneyDecimal, toMoney } from "../lib/money";

/** A stock-transfer voucher row locked FOR UPDATE, joined to its voucher header. */
type LockedTransferRow = Record<string, unknown> & {
  id: number;
  voucher_id: number;
  company_id: number;
  optional: boolean;
  voucher_type: string;
  deleted_at: Date | null;
  total_amount: string;
};

export interface StockTransferLifecycleItem {
  stockItemId: number;
  sourceLocationId: number;
  quantity: number;
  rate: number;
}

export interface SaveStockTransferLifecycleInput {
  companyId: number;
  transferId: number;
  destinationLocationId: number;
  notes: string;
  items: StockTransferLifecycleItem[];
  voucherDate?: string;
  description?: string;
}

export interface StockTransferLifecycleResult {
  voucherId: number;
  transferId: number;
  optional: boolean;
  inventoryApplied: boolean;
  transition: "draft-edit" | "post" | "unpost" | "posted-edit" | "no-op" | "recover";
  totalAmount: string;
  items: Array<typeof stockTransferItems.$inferSelect>;
}

export interface SourceStockRequirement {
  sourceLocationId: number;
  stockItemId: number;
  quantity: number;
}

export function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function normalizeItems(
  items: StockTransferLifecycleItem[],
  destinationLocationId: number
): StockTransferLifecycleItem[] {
  if (!Array.isArray(items) || items.length === 0) throw new Error("At least one stock transfer item is required");

  const merged = new Map<string, StockTransferLifecycleItem>();
  for (const raw of items) {
    const stockItemId = positiveInteger(raw.stockItemId, "Stock item ID");
    const sourceLocationId = positiveInteger(raw.sourceLocationId, "Source location ID");
    if (sourceLocationId === destinationLocationId)
      throw new Error("Source and destination locations must be different");

    const quantity = Number(raw.quantity);
    const rate = Number(raw.rate);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Transfer quantity must be greater than zero");
    if (!Number.isFinite(rate) || rate < 0) throw new Error("Transfer rate cannot be negative");

    const key = `${stockItemId}:${sourceLocationId}`;
    const existing = merged.get(key);
    if (existing) {
      // Exact merge: the combined value over the combined quantity.
      const totalQuantity = toMoney(existing.quantity).plus(quantity);
      const weightedRate = totalQuantity.gt(0)
        ? lineAmount(existing.quantity, existing.rate).plus(lineAmount(quantity, rate)).dividedBy(totalQuantity)
        : toMoney(rate);
      merged.set(key, {
        stockItemId,
        sourceLocationId,
        quantity: totalQuantity.toNumber(),
        rate: weightedRate.toNumber(),
      });
    } else {
      merged.set(key, { stockItemId, sourceLocationId, quantity, rate });
    }
  }

  return Array.from(merged.values()).sort(
    (a, b) => a.sourceLocationId - b.sourceLocationId || a.stockItemId - b.stockItemId
  );
}

export function aggregateSourceStockRequirements(
  items: Array<Pick<StockTransferLifecycleItem, "sourceLocationId" | "stockItemId" | "quantity">>
): SourceStockRequirement[] {
  const requirements = new Map<string, SourceStockRequirement>();
  for (const item of items) {
    const key = `${item.sourceLocationId}:${item.stockItemId}`;
    const existing = requirements.get(key);
    if (existing) existing.quantity += item.quantity;
    else requirements.set(key, { ...item });
  }
  return Array.from(requirements.values()).sort(
    (a, b) => a.sourceLocationId - b.sourceLocationId || a.stockItemId - b.stockItemId
  );
}

export async function lockTransfer(tx: DbTransaction, transferId: number) {
  const result = await tx.execute(sql`
    SELECT stv.*, v.company_id, v.optional, v.voucher_type, v.deleted_at, v.total_amount
    FROM stock_transfer_vouchers stv
    JOIN vouchers v ON v.id = stv.voucher_id
    WHERE stv.id = ${transferId}
    FOR UPDATE OF stv, v
  `);
  return firstRow<LockedTransferRow>(result);
}

export async function lockTransferByVoucher(tx: DbTransaction, voucherId: number) {
  const result = await tx.execute(sql`
    SELECT stv.*, v.company_id, v.optional, v.voucher_type, v.deleted_at, v.total_amount
    FROM stock_transfer_vouchers stv
    JOIN vouchers v ON v.id = stv.voucher_id
    WHERE stv.voucher_id = ${voucherId}
    FOR UPDATE OF stv, v
  `);
  return firstRow<LockedTransferRow>(result);
}

export async function loadTransferItems(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], transferId: number) {
  return tx.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, transferId));
}

export function persistedRowsToItems(
  rows: Array<typeof stockTransferItems.$inferSelect>,
  fallbackSourceLocationId: number | null | undefined,
  destinationLocationId: number
): StockTransferLifecycleItem[] {
  return normalizeItems(
    rows.map((item) => {
      const sourceLocationId = item.sourceLocationId ?? fallbackSourceLocationId;
      if (!sourceLocationId) throw new Error(`Transfer item ${item.id} is missing its source location`);
      return {
        stockItemId: item.stockItemId,
        sourceLocationId,
        quantity: Number(item.quantity),
        rate: Number(item.rate ?? 0),
      };
    }),
    destinationLocationId
  );
}

export async function assertCompanyScope(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: number,
  destinationLocationId: number,
  items: StockTransferLifecycleItem[]
) {
  const locationIds = Array.from(new Set([destinationLocationId, ...items.map((item) => item.sourceLocationId)]));
  const companyLocations = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), inArray(locations.id, locationIds), isNull(locations.deletedAt)));
  if (companyLocations.length !== locationIds.length) {
    throw new Error("One or more transfer locations do not belong to the current company");
  }

  const itemIds = Array.from(new Set(items.map((item) => item.stockItemId)));
  const companyItems = await tx
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(
      and(
        eq(stockItems.companyId, companyId),
        inArray(stockItems.id, itemIds),
        eq(stockItems.active, true),
        isNull(stockItems.deletedAt)
      )
    );
  if (companyItems.length !== itemIds.length) {
    throw new Error("One or more stock items do not belong to the current company or are inactive");
  }
}

/** The exact value each (source, item) group of a transfer's rows moved (legacy rows: their total). */
export function rowValuesByGroup(
  rows: Array<typeof stockTransferItems.$inferSelect>,
  fallbackSourceLocationId: number | null | undefined
): Map<string, Decimal> {
  const values = new Map<string, Decimal>();
  for (const row of rows) {
    const key = `${row.sourceLocationId ?? fallbackSourceLocationId}:${row.stockItemId}`;
    const value = lineValueMoved({ valueMoved: row.valueMoved, total: row.totalAmount });
    values.set(key, (values.get(key) ?? new MoneyDecimal(0)).plus(value));
  }
  return values;
}

/**
 * Moves the applied items back exactly (wave 11): the destination gives back
 * the value each group moved and the source takes it. Returns the signed
 * sub-ledger changes.
 */
export async function reverseAppliedItems(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: number,
  destinationLocationId: number,
  items: StockTransferLifecycleItem[],
  values: ReadonlyMap<string, Decimal>,
  journal?: { transferId: number; revision: number }
): Promise<Decimal[]> {
  const deltas: Decimal[] = [];
  for (const item of items) {
    const value =
      values.get(`${item.sourceLocationId}:${item.stockItemId}`) ??
      new MoneyDecimal(item.quantity).times(item.rate).toDecimalPlaces(2);
    const reversed = await reverseTransferLegExactTx(tx, {
      companyId,
      sourceLocationId: item.sourceLocationId,
      destinationLocationId,
      stockItemId: item.stockItemId,
      quantity: item.quantity,
      value,
    });
    deltas.push(reversed.sourceDelta, reversed.destinationDelta);

    if (journal) {
      await journalStockTransferLeg(tx, {
        companyId,
        transferId: journal.transferId,
        revision: journal.revision,
        phase: "reverse",
        fromLocationId: destinationLocationId,
        toLocationId: item.sourceLocationId,
        leg: item,
      });
    }
  }
  return deltas;
}
