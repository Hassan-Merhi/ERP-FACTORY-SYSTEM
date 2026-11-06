/**
 * Plan batch 3 (owner-approved 2026-11-05): the Excel inventory import for a
 * location (POST /api/locations/:locationId/import-inventory) on the factory
 * LAN server, recorded as quantity changes, never as overwritten balances.
 *
 * The import already adds each row's quantity to the location's stock, so the
 * row's quantity IS the change. On the LAN each row goes through the same
 * code as a quick stock adjustment, in its own transaction, and is recorded
 * as an ordinary stock.quick-adjust.v1 record. The cloud then adds the same
 * change to its own figure (so stock it sold meanwhile is not wiped out) and
 * holds a result below zero for Admin/Developer approve/reject.
 *
 * Differences from the online import, all on the safe side:
 * - a code that is not a stock item yet is reported back, not created (items
 *   can be created offline on the Stock Items page), and no barcode alias is
 *   registered;
 * - the row is valued at the location's current average cost, the same rule
 *   as a quick adjustment, not at the spreadsheet's rate;
 * - a row that would take the location below zero is refused on the LAN.
 */
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { db } from "../../db";
import { capturePhase9StockAdjustTx } from "../../edge/phase9StockOutbox";
import { offlineEdgeText } from "../../i18n/offlineEdgeMessages";
import { getErrorMessage } from "../../lib/httpHandlers";
import { toMoney } from "../../lib/money";
import { buildPermissionMap, canAccess } from "../../lib/permissionHelpers";
import { applyQuickAdjustmentCoreTx } from "../../routes/inventory/inventoryQuickAdjustCore";
import { storage } from "../../storage";

/** The cloud replays each row as a quick adjustment, which needs this action. */
const ADJUST_ACTION = "act_adjust_stock";

export interface LanLocationImportRow {
  Item_barcode?: unknown;
  quantity?: unknown;
}

export async function lanCanImportInventory(req: Request, companyId: number): Promise<boolean> {
  const role = String(req.session.currentRole ?? req.user?.role ?? "");
  if (role === "Admin" || role === "Developer") return true;
  const permissions = buildPermissionMap(await storage.getRoleFeaturePermissions(companyId), role);
  return canAccess(role, ADJUST_ACTION, permissions);
}

export async function importLocationInventoryOnLan(
  req: Request,
  input: { companyId: number; location: { id: number; name: string }; items: LanLocationImportRow[] }
) {
  const language = req.headers["accept-language"];
  const actor = { userId: String(req.session.userId), username: req.session.username || "unknown" };
  const results = {
    created: [] as { code: unknown; itemName: string; quantity: number }[],
    updated: [] as { code: unknown; itemName: string; addedQuantity: number; newQuantity: number }[],
    skipped: [] as { code: unknown; reason: string }[],
    errors: [] as { code?: unknown; reason?: string; error?: string }[],
  };
  for (const row of input.items) {
    const code = typeof row.Item_barcode === "string" ? row.Item_barcode.trim() : "";
    try {
      const stockItem = code ? await storage.getStockItemByCodeOrAlias(code, input.companyId) : undefined;
      if (!stockItem) {
        results.errors.push({
          code: row.Item_barcode,
          reason: offlineEdgeText("inventoryImportUnknownItem", language),
        });
        continue;
      }
      const change = toMoney(row.quantity as string);
      if (change.isZero()) {
        results.skipped.push({ code, reason: "zero quantity" });
        continue;
      }
      const operationId = randomUUID();
      const occurredAt = new Date().toISOString();
      const applied = await db.transaction(async (tx) => {
        const done = await applyQuickAdjustmentCoreTx(tx, {
          companyId: input.companyId,
          stockItem: { id: stockItem.id, code: stockItem.code },
          location: input.location,
          direction: change.isNegative() ? "subtract" : "add",
          quantity: change.abs().toFixed(),
          actor,
          operationId,
          occurredAt,
          allowNegative: false,
        });
        await capturePhase9StockAdjustTx(tx, {
          companyId: input.companyId,
          localMovementId: done.movementId,
          stockItemId: stockItem.id,
          locationId: input.location.id,
          actorUserId: actor.userId,
          actorUsername: actor.username,
          requestId: operationId,
          direction: change.isNegative() ? "subtract" : "add",
          quantity: done.normalizedQuantity,
          occurredAt,
          businessDate: occurredAt.slice(0, 10),
        });
        return done;
      });
      results.updated.push({
        code,
        itemName: stockItem.name,
        addedQuantity: Number(applied.adjustedQuantity),
        newQuantity: Number(applied.newQuantity),
      });
    } catch (error: unknown) {
      results.errors.push({ code: row.Item_barcode, error: getErrorMessage(error) });
    }
  }
  return results;
}
