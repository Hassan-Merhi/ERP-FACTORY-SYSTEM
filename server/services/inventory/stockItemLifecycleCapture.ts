/**
 * Plan batch 2 (owner-approved 2026-11-05): evidence for stock items created
 * or deleted on the factory LAN server, recorded on the "stock" stream in the
 * same transaction as the item itself (server/edge/phase9StockOutbox.ts).
 */
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { StockItem } from "@shared/schema";
import type { Phase9StockItemFields } from "../../edge/phase9StockItemLifecycleEnvelope.mjs";
import { getClientDate } from "../../lib/dateUtils";

function actor(req: Request) {
  return {
    companyId: Number(req.session.currentCompanyId),
    actorUserId: String(req.session.userId),
    actorUsername: req.session.username || "unknown",
    requestId: randomUUID(),
    businessDate: getClientDate(req).slice(0, 10),
  };
}

const decimal = (value: string | null | undefined) => (value === null || value === undefined ? null : String(value));

export function stockItemFieldsOf(item: StockItem): Phase9StockItemFields {
  return {
    code: item.code,
    name: item.name,
    uom: item.uom,
    stockGroupId: Number(item.stockGroupId),
    categoryId: item.categoryId ?? null,
    gradeId: item.gradeId ?? null,
    sellingPrice: decimal(item.sellingPrice),
    openingQty: decimal(item.openingQty),
    openingRate: decimal(item.openingRate),
    openingValue: decimal(item.openingValue),
    reorderLevel: decimal(item.reorderLevel),
    active: item.active,
  };
}

export function stockItemCreateEvidence(req: Request, item: StockItem) {
  return { ...actor(req), localStockItemId: item.id, item: stockItemFieldsOf(item) };
}

export function stockItemDeleteEvidence(req: Request, item: Pick<StockItem, "id" | "code">) {
  return { ...actor(req), stockItemId: item.id, code: item.code };
}
