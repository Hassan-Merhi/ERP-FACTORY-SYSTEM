/**
 * Location inventory import under perpetual inventory (wave 11).
 *
 * Before a company's cut-over the import keeps its behaviour: each row adds its
 * quantity and value to the location's stock, row by row, with no journal.
 *
 * Once the cut-over is applied (and the company is not a supplier partner) the
 * ledger carries the stock, so an import must say what it is:
 *   - importKind "opening": stock that existed but was never entered — offset
 *     to Opening Balance Equity. Owner only (a Developer passes, as with every
 *     role check);
 *   - importKind "count": a stock count — the gain or loss is offset to
 *     INVENTORY_ADJUSTMENT.
 * The rows are then applied in one transaction (all or none) and post one
 * INV-MOVE-{company}-{opening-import|count-import}-{operation} journal for the
 * exact change of inventory.total_value. A row that leaves the location short
 * holds no value (owner decision 1).
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { inventory, type StockItem } from "@shared/schema";

import { db, type DatabaseOrTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { getInventoryCutover } from "../../services/accounting/perpetualInventory/cutover";
import {
  inventoryMovementLine,
  postInventoryMovementJournalTx,
  type InventoryMovementLine,
} from "../../services/accounting/perpetualInventory/inventoryMovementJournal";
import { isSupplierPartnerCompany } from "../../services/accounting/perpetualInventory/linkedJournal";
import { updateInventoryTx } from "../../storage/inventory/locationInventoryStorage";

export const IMPORT_KIND_REQUIRED_MESSAGE =
  "After the perpetual inventory cut-over a stock import must say what it is: an opening balance or a stock count.";
export const OPENING_IMPORT_OWNER_ONLY_MESSAGE =
  "Only an Owner can import opening stock after the perpetual inventory cut-over.";

export type LocationImportKind = "opening" | "count";

export type LocationImportPlan =
  | { posted: false }
  | { posted: true; kind: LocationImportKind }
  | { refusal: { status: 400 | 403; body: { code: string; message: string } } };

export async function planLocationImport(
  executor: DatabaseOrTransaction,
  params: { companyId: number; importKind: unknown; role: string | undefined }
): Promise<LocationImportPlan> {
  if (!(await getInventoryCutover(executor, params.companyId))) return { posted: false };
  if (await isSupplierPartnerCompany(executor, params.companyId)) return { posted: false };
  if (params.importKind !== "opening" && params.importKind !== "count") {
    return {
      refusal: { status: 400, body: { code: "INVENTORY_IMPORT_KIND_REQUIRED", message: IMPORT_KIND_REQUIRED_MESSAGE } },
    };
  }
  if (params.importKind === "opening" && params.role !== "Owner" && params.role !== "Developer") {
    return {
      refusal: {
        status: 403,
        body: { code: "OPENING_STOCK_IMPORT_OWNER_ONLY", message: OPENING_IMPORT_OWNER_ONLY_MESSAGE },
      },
    };
  }
  return { posted: true, kind: params.importKind };
}

export interface PostedImportRow {
  code: unknown;
  stockItem: Pick<StockItem, "id" | "name">;
  quantity: number;
  rate: number;
  value: number;
}

export async function applyPostedLocationImport(params: {
  companyId: number;
  locationId: number;
  plan: { posted: true; kind: LocationImportKind };
  rows: readonly PostedImportRow[];
  actor: { userId: string; username: string };
}) {
  const operationId = randomUUID();
  const created: { code: unknown; itemName: string; quantity: number }[] = [];
  const updated: { code: unknown; itemName: string; addedQuantity: number; newQuantity: number }[] = [];
  await db.transaction(async (tx) => {
    const lines: InventoryMovementLine[] = [];
    for (const row of params.rows) {
      const [existing] = await tx
        .select({ quantity: inventory.quantity, averageRate: inventory.averageRate, totalValue: inventory.totalValue })
        .from(inventory)
        .where(and(eq(inventory.locationId, params.locationId), eq(inventory.stockItemId, row.stockItem.id)))
        .limit(1)
        .for("update");
      const previousQuantity = toMoney(existing?.quantity);
      const previousValue = MoneyDecimal.max(toMoney(existing?.totalValue), 0);
      const quantity = previousQuantity.plus(row.quantity);
      const value = quantity.gt(0) ? MoneyDecimal.max(previousValue.plus(row.value), 0) : new MoneyDecimal(0);
      const rate = quantity.gt(0) ? value.dividedBy(quantity) : toMoney(existing?.averageRate ?? row.rate);
      const result = await updateInventoryTx(
        tx,
        params.locationId,
        row.stockItem.id,
        quantity.toFixed(3),
        rate.toFixed(7),
        value.toFixed(2),
        params.companyId
      );
      lines.push(inventoryMovementLine(result, { stockItemId: row.stockItem.id, locationId: params.locationId }));
      if (existing) {
        updated.push({
          code: row.code,
          itemName: row.stockItem.name,
          addedQuantity: row.quantity,
          newQuantity: quantity.toNumber(),
        });
      } else {
        created.push({ code: row.code, itemName: row.stockItem.name, quantity: row.quantity });
      }
    }
    await postInventoryMovementJournalTx(tx, {
      companyId: params.companyId,
      sourceType: params.plan.kind === "opening" ? "opening-import" : "count-import",
      sourceId: operationId,
      date: new Date().toISOString().slice(0, 10),
      reference: `Location ${params.locationId}`,
      lines,
      offsetAccountCode: params.plan.kind === "opening" ? "OPENING_BALANCE_EQUITY" : "INVENTORY_ADJUSTMENT",
      narration: params.plan.kind === "opening" ? "Opening stock import" : "Stock count import",
      actor: params.actor,
      locationId: params.locationId,
    });
  });
  return { created, updated };
}
