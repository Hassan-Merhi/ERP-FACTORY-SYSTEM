import type { Request } from "express";

import { InventoryRouteError } from "./inventoryErrors";
import { parseMoneyInput } from "../../lib/money";

export interface InventoryListFilters {
  page: number;
  pageSize: number;
  search?: string;
  locationId?: number;
  stockGroupId?: number;
  profile?: string;
}

export interface QuickAdjustmentInput {
  stockItemId: number;
  locationId: number;
  quantity: number;
  type: "add" | "subtract";
}

export interface InventoryAuditActor {
  userId: string;
  username: string;
}

export function getActiveInventoryCompanyId(req: Request): number {
  const companyId = Number(req.session?.currentCompanyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new InventoryRouteError(400, "No company selected");
  }
  return companyId;
}

export function parseInventoryListFilters(req: Request): InventoryListFilters {
  const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
  const pageSize = Math.min(250, Math.max(1, Number.parseInt(String(req.query.pageSize || "100"), 10) || 100));
  const search = typeof req.query.search === "string" && req.query.search.trim() ? req.query.search.trim() : undefined;
  const locationId = req.query.locationId ? Number.parseInt(String(req.query.locationId), 10) : undefined;
  const stockGroupId =
    req.query.stockGroupId && req.query.stockGroupId !== "all"
      ? Number.parseInt(String(req.query.stockGroupId), 10)
      : undefined;
  const profile = typeof req.query.profile === "string" ? req.query.profile : undefined;
  return { page, pageSize, search, locationId, stockGroupId, profile };
}

export function parseQuickAdjustmentInput(input: unknown): QuickAdjustmentInput {
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const { stockItemId, locationId, quantity, type } = body;
  if (!stockItemId || !locationId || !quantity || !type) {
    throw new InventoryRouteError(400, "Missing required fields: stockItemId, locationId, quantity, type");
  }

  const parsedStockItemId = Number(stockItemId);
  const parsedLocationId = Number(locationId);
  const parsedQuantity = parseMoneyInput(String(quantity))?.toNumber() ?? NaN;
  if (!Number.isInteger(parsedStockItemId) || parsedStockItemId <= 0) {
    throw new InventoryRouteError(400, "Invalid stock item ID");
  }
  if (!Number.isInteger(parsedLocationId) || parsedLocationId <= 0) {
    throw new InventoryRouteError(400, "Invalid location ID");
  }
  if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
    throw new InventoryRouteError(400, "Quantity must be a positive number");
  }
  if (type !== "add" && type !== "subtract") {
    throw new InventoryRouteError(400, "Type must be 'add' or 'subtract'");
  }

  return {
    stockItemId: parsedStockItemId,
    locationId: parsedLocationId,
    quantity: parsedQuantity,
    type,
  };
}

export function getInventoryAuditActor(req: Request): InventoryAuditActor {
  return {
    userId: req.session.userId!,
    username: req.session.username || "unknown",
  };
}
