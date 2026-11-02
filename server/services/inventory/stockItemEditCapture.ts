/**
 * Stock-item master edits that the factory LAN server records for the cloud
 * (owner decision 2026-11-02): bulk edits, update-by-code imports and
 * single-item edits of whitelisted fields on EXISTING items.
 *
 * Routes make their writes through these helpers on one transaction. Off the
 * LAN primary the recorder is inactive and the helpers only write. On the LAN
 * each helper locks the row, writes, and records "field: before -> after";
 * finishStockItemEditCaptureTx then appends the net changes to the "stock"
 * outbox in the same transaction. A field outside the whitelist (code, grade,
 * reorder level...) is refused on the LAN, never silently left unsynced.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import Decimal from "decimal.js";
import { stockItemCodeAliases, stockItemLocationPrices, stockItems, type InsertStockItem } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { isPhase9LanPrimary } from "../../edge/phase9PosOutbox";
import { capturePhase9StockItemEditTx } from "../../edge/phase9StockOutbox";
import { PHASE9_STOCK_ITEM_EDIT_FIELDS, type Phase9StockItemChange } from "../../edge/phase9StockItemEditEnvelope.mjs";
import { getClientDate } from "../../lib/dateUtils";

const ITEM_FIELDS = PHASE9_STOCK_ITEM_EDIT_FIELDS.item;
const CHUNK = 2000;

export class StockItemEditCloudOnlyError extends Error {
  readonly status = 409;
  readonly code = "EDGE_PHASE9_STOCK_ITEM_FIELD_CLOUD_ONLY";
  constructor(readonly fields: string[]) {
    super(`These stock item fields can only be changed in the cloud: ${fields.join(", ")}`);
    this.name = "StockItemEditCloudOnlyError";
  }
}

export interface StockItemEditRecorder {
  readonly active: boolean;
  readonly route: string;
  readonly changes: Phase9StockItemChange[];
}

export function stockItemEditRecorder(route: string): StockItemEditRecorder {
  return { active: isPhase9LanPrimary(), route, changes: [] };
}

/** The canonical string a field value is recorded as (the envelope's format). */
function canonical(type: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (type === "decimal") {
    if (value === "") return null;
    return new Decimal(String(value)).toDecimalPlaces(6).toFixed();
  }
  if (type === "boolean") return value === true || value === "true" ? "true" : "false";
  if (type === "ref") return String(Number(value));
  const text = String(value);
  return text === "" ? null : text;
}

/** Update an item's fields; on the LAN only whitelisted fields, recorded before -> after. */
export async function updateStockItemFieldsTx(
  tx: DbTransaction,
  recorder: StockItemEditRecorder | null,
  stockItemId: number,
  updates: Partial<InsertStockItem>
) {
  const keys = Object.keys(updates).filter((key) => updates[key as keyof InsertStockItem] !== undefined);
  if (!recorder?.active) {
    const [updated] = await tx.update(stockItems).set(updates).where(eq(stockItems.id, stockItemId)).returning();
    return updated;
  }
  const refused = keys.filter((key) => !Object.prototype.hasOwnProperty.call(ITEM_FIELDS, key));
  if (refused.length) throw new StockItemEditCloudOnlyError(refused);
  const [before] = await tx.select().from(stockItems).where(eq(stockItems.id, stockItemId)).for("update");
  if (!before) return undefined;
  const [after] = await tx.update(stockItems).set(updates).where(eq(stockItems.id, stockItemId)).returning();
  for (const field of keys) {
    const type = ITEM_FIELDS[field];
    const from = canonical(type, before[field as keyof typeof before]);
    const to = canonical(type, after[field as keyof typeof after]);
    if (from !== to) {
      recorder.changes.push({ target: "item", stockItemId, code: before.code, field, before: from, after: to });
    }
  }
  return after;
}

/** Insert or update a location selling price, recorded on the LAN. */
export async function upsertLocationPriceTx(
  tx: DbTransaction,
  recorder: StockItemEditRecorder | null,
  input: { stockItemId: number; locationId: number; sellingPrice: string }
) {
  let before: string | null = null;
  let code = "";
  if (recorder?.active) {
    const [item] = await tx
      .select({ code: stockItems.code })
      .from(stockItems)
      .where(eq(stockItems.id, input.stockItemId))
      .for("update");
    code = item?.code ?? "";
    const [row] = await tx
      .select({ sellingPrice: stockItemLocationPrices.sellingPrice })
      .from(stockItemLocationPrices)
      .where(
        and(
          eq(stockItemLocationPrices.stockItemId, input.stockItemId),
          eq(stockItemLocationPrices.locationId, input.locationId)
        )
      );
    before = canonical("decimal", row?.sellingPrice);
  }
  const [saved] = await tx
    .insert(stockItemLocationPrices)
    .values(input)
    .onConflictDoUpdate({
      target: [stockItemLocationPrices.stockItemId, stockItemLocationPrices.locationId],
      set: { sellingPrice: input.sellingPrice, updatedAt: new Date() },
    })
    .returning();
  if (recorder?.active) {
    const after = canonical("decimal", saved.sellingPrice);
    if (after !== before) {
      recorder.changes.push({
        target: "location-price",
        stockItemId: input.stockItemId,
        code,
        locationId: input.locationId,
        field: "sellingPrice",
        before,
        after,
      });
    }
  }
  return saved;
}

/** Add a barcode alias; true when a row was added (recorded on the LAN). */
export async function addStockItemAliasTx(
  tx: DbTransaction,
  recorder: StockItemEditRecorder | null,
  input: { companyId: number; stockItemId: number; aliasCode: string }
): Promise<boolean> {
  const inserted = await tx.insert(stockItemCodeAliases).values(input).onConflictDoNothing().returning();
  if (!inserted.length) return false;
  if (recorder?.active) {
    const [item] = await tx
      .select({ code: stockItems.code })
      .from(stockItems)
      .where(eq(stockItems.id, input.stockItemId));
    recorder.changes.push({
      target: "alias",
      stockItemId: input.stockItemId,
      code: item?.code ?? "",
      field: "aliasCode",
      before: null,
      after: input.aliasCode,
    });
  }
  return true;
}

/** One net change per field: the first "before" and the last "after". */
function netChanges(changes: Phase9StockItemChange[]): Phase9StockItemChange[] {
  const byKey = new Map<string, Phase9StockItemChange>();
  for (const change of changes) {
    const key = `${change.target}:${change.stockItemId}:${change.locationId ?? ""}:${change.field}:${
      change.target === "alias" ? String(change.after).toLowerCase() : ""
    }`;
    const prior = byKey.get(key);
    byKey.set(key, prior ? { ...prior, after: change.after } : change);
  }
  return [...byKey.values()].filter((change) => change.before !== change.after);
}

/** Append the recorded changes to the stock outbox (LAN primary only), in chunks. */
export async function finishStockItemEditCaptureTx(
  tx: DbTransaction,
  req: Pick<Request, "session" | "headers" | "query" | "body">,
  recorder: StockItemEditRecorder
): Promise<void> {
  if (!recorder.active) return;
  const changes = netChanges(recorder.changes);
  const companyId = Number(req.session.currentCompanyId);
  for (let start = 0; start < changes.length; start += CHUNK) {
    await capturePhase9StockItemEditTx(tx, {
      companyId,
      actorUserId: String(req.session.userId),
      actorUsername: req.session.username || "unknown",
      requestId: randomUUID(),
      businessDate: getClientDate(req as Request).slice(0, 10),
      route: recorder.route,
      changes: changes.slice(start, start + CHUNK),
    });
  }
}

/** Express helper: the refusal a LAN request gets for a cloud-only field. */
export function sendStockItemEditRefusal(
  res: { status(code: number): { json(body: unknown): unknown } },
  error: unknown
): boolean {
  if (!(error instanceof StockItemEditCloudOnlyError)) return false;
  res.status(error.status).json({ code: error.code, message: error.message, fields: error.fields });
  return true;
}
