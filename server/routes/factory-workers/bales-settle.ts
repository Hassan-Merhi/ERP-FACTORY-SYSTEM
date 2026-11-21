/**
 * factoryWorkerRoutes: FactoryWorkerBaleSettle endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Database } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { parseId, parseOptionalId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, desc, sql } from "drizzle-orm";
import { factoryBales } from "@shared/schema";

import { getFactoryCompanyId } from "./_helpers";
import { registerFactoryWorkerBaleSettleRoutesPart1 } from "./registerFactoryWorkerBaleSettleRoutesPart1";

export function registerFactoryWorkerBaleSettleRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  // GET /api/factory/workers/:id/bales - Get bales associated with worker
  app.get("/api/factory/workers/:id/bales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.query.companyId ? parseOptionalId(req.query.companyId) : getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { startDate, endDate } = req.query;

      const conditions = [eq(factoryBales.finalizedBy, id), eq(factoryBales.companyId, companyId)];

      if (startDate) {
        conditions.push(sql`${factoryBales.finalizedAt} >= ${startDate}::timestamp`);
      }
      if (endDate) {
        conditions.push(sql`${factoryBales.finalizedAt} <= ${endDate}::timestamp + interval '1 day'`);
      }

      const bales = await db
        .select()
        .from(factoryBales)
        .where(and(...conditions))
        .orderBy(desc(factoryBales.finalizedAt));

      res.json(bales);
    } catch (error: unknown) {
      logger.error("Error fetching worker bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerFactoryWorkerBaleSettleRoutesPart1(app, requireAuth, db);

  // (payroll routes already registered above, before /:id)
}
