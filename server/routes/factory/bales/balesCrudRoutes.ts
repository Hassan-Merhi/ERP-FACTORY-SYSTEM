/**
 * factoryBalesRoutes: BalesCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";

import { baleWriteErrorResponse, deletePreStockBalesTx, lockPriorityScanQueueTx } from "./baleStatusWriteGuards";
import { registerBalesMaintenanceRoutes } from "./balesMaintenanceRoutes";
import { registerBalesCrudRoutesPart1 } from "./registerBalesCrudRoutesPart1";
import { registerBalesCrudRoutesPart2 } from "./registerBalesCrudRoutesPart2";
import { registerBalesCrudRoutesPart4 } from "./registerBalesCrudRoutesPart4";

export function registerBalesCrudRoutes(app: Express) {
  registerBalesCrudRoutesPart1(app);
  registerBalesCrudRoutesPart2(app);
  registerBalesCrudRoutesPart3(app);
}

function registerBalesCrudRoutesPart3(app: Express) {
  registerBalesCrudRoutesPart4(app);

  // Phase 19 C (F3): Admin/Owner; only a pre-stock bale (no value) is deleted
  // here; a valued or sold bale is removed or written off through Stock Removal
  // (409). The delete runs through the physical-deletion service (main #2134:
  // loading links, Priority Scan reversal, deletion record, daybook) and commits
  // with its audit row (the bale as it was).
  app.delete(
    "/api/factory/bales/:id",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        await db.transaction(async (tx) => {
          await lockPriorityScanQueueTx(tx, companyId);
          await deletePreStockBalesTx(tx, req, companyId, [id], "Bale removed from Factory Bale History");
        });

        res.json({ message: "Bale deleted" });
      } catch (error: unknown) {
        baleWriteErrorResponse(res, error);
      }
    }
  );

  registerBalesMaintenanceRoutes(app);
}
