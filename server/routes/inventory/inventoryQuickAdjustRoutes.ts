import type { Express } from "express";
import { z } from "zod";

import { requireAuth } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { inventoryErrorStatus } from "./inventoryErrors";
import { quickAdjustInventory } from "./inventoryQuickAdjustService";
import {
  getActiveInventoryCompanyId,
  getInventoryAuditActor,
  parseQuickAdjustmentInput,
} from "./inventoryRequestContext";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../lib/validateRequest";

/** parseQuickAdjustmentInput reads ids with Number(), quantity with String(), and checks type. */
const numberOrString = z.union([z.number(), z.string()]);
const quickAdjustInput = {
  query: emptyQuery,
  body: z.strictObject({
    stockItemId: numberOrString.nullable().optional(),
    locationId: numberOrString.nullable().optional(),
    quantity: numberOrString.nullable().optional(),
    type: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;

export function registerInventoryQuickAdjustRoutes(app: Express) {
  app.post("/api/inventory/quick-adjust", requireAuth, validateRequest(quickAdjustInput), async (req, res) => {
    try {
      const companyId = getActiveInventoryCompanyId(req);
      const input = parseQuickAdjustmentInput(req.body);
      const result = await quickAdjustInventory(companyId, input, getInventoryAuditActor(req));
      return res.json(result);
    } catch (error: unknown) {
      logger.error("Quick adjust error:", { error });
      return res.status(inventoryErrorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
