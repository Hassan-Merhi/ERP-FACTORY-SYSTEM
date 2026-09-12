/**
 * workerStatementRoutes: WorkerDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, sql } from "drizzle-orm";
import { factoryWorkers } from "@shared/schema";

import { getFactoryCompanyId } from "./_helpers";

export function registerWorkerDeleteRoutes(app: Express) {
  // DELETE /api/factory/workers/:id - Permanently delete a factory worker
  app.delete("/api/factory/workers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid worker ID" });

      // Check if the worker has any bale entries
      const baleCheck = await db.execute(
        sql`SELECT COUNT(*) as cnt FROM factory_bale_production_attributions a JOIN factory_bales b ON b.id = a.bale_id WHERE a.worker_id = ${id} AND b.company_id = ${companyId} AND b.status NOT IN ('REMOVED','DELETED')`
      );
      const baleCount = parseInt((baleCheck.rows[0] as { cnt: string })?.cnt || "0");
      if (baleCount > 0) {
        return res.status(400).json({
          message: `Cannot delete: this worker has ${baleCount} bale entries. Remove all bale entries first.`,
        });
      }

      // Check for payroll entries
      const payrollCheck = await db.execute(
        sql`SELECT COUNT(*) as cnt FROM factory_payrolls WHERE worker_id = ${id} AND company_id = ${companyId}`
      );
      const payrollCount = parseInt((payrollCheck.rows[0] as { cnt: string })?.cnt || "0");
      if (payrollCount > 0) {
        return res.status(400).json({ message: `Cannot delete: this worker has ${payrollCount} payroll record(s).` });
      }

      const [deleted] = await db
        .delete(factoryWorkers)
        .where(and(eq(factoryWorkers.id, id), eq(factoryWorkers.companyId, companyId)))
        .returning({ id: factoryWorkers.id });

      if (!deleted) return res.status(404).json({ message: "Worker not found" });
      res.json({ message: "Worker deleted successfully" });
    } catch (error: unknown) {
      logger.error("Error deleting factory worker:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
