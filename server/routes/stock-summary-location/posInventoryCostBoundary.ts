import type { NextFunction, Request, Response } from "express";

import { checkPOSLocation, requireAuth } from "../../auth";
import { db } from "../../db";
import { hydrateSessionNamedPermissions } from "../../services/security/namedPermissionService";

const POS_INVENTORY_COST_PERMISSION = "inventory.cost.view";

const INVENTORY_COST_KEYS = new Set([
  "averageRate",
  "totalValue",
  "costPrice",
  "totalCost",
  "inventoryCost",
  "rate",
  "value",
  "openingRate",
  "openingValue",
  "inwardRate",
  "inwardValue",
  "outwardRate",
  "outwardValue",
  "closingRate",
  "closingValue",
]);

function redactInventoryCost(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactInventoryCost);
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = INVENTORY_COST_KEYS.has(key) ? 0 : redactInventoryCost(child);
  }
  return output;
}

async function enforcePosInventoryCostBoundary(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "POS") return next();

  let canViewCost = false;
  try {
    const permissions = await hydrateSessionNamedPermissions(db, req.session);
    canViewCost = permissions.includes(POS_INVENTORY_COST_PERMISSION);
  } catch {
    // Sensitive values fail closed if the permission store cannot be read:
    // canViewCost is still false here, because the only assignment to it is the
    // last statement in the try block.
  }

  if (canViewCost) return next();

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => originalJson(redactInventoryCost(body))) as Response["json"];
  return next();
}

/**
 * Shared boundary for every location-scoped stock-item history endpoint.
 * Authentication is intentionally repeated by the concrete routes: this layer
 * exists to guarantee POS location scope and cost redaction before any handler
 * can return stock-history data.
 */
export const posInventoryHistoryGuards = [requireAuth, checkPOSLocation, enforcePosInventoryCostBoundary] as const;
