import type { Express, Request, Response } from "express";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { recalculateOrderTotals } from "../factory/_helpers";
import { customerOrders } from "@shared/schema";
import { inArray } from "drizzle-orm";
import { emptyBody, emptyQuery, validateRequest, type RequestSchemas } from "../../lib/validateRequest";

const recalculateFactoryOrderTotalsInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerFactoryOrderRepairRoutes(app: Express) {
  app.post(
    "/api/admin/recalculate-factory-order-totals",
    requireAuth,
    requireRole("Admin", "Developer"),
    validateRequest(recalculateFactoryOrderTotalsInput),
    async (req: Request, res: Response) => {
      try {
        const statuses = ["LOADING", "PENDING_VERIFICATION", "VERIFIED", "FINALIZED"];
        const orders = await db
          .select({ id: customerOrders.id, status: customerOrders.status })
          .from(customerOrders)
          .where(inArray(customerOrders.status, statuses));

        let done = 0;
        let errors = 0;
        const errorDetails: string[] = [];
        for (const order of orders) {
          try {
            await recalculateOrderTotals(db, order.id);
            done++;
          } catch (error: unknown) {
            errors++;
            errorDetails.push(`orderId=${order.id}: ${getErrorMessage(error)}`);
            logger.error(`[recalc-factory-totals] error on orderId=${order.id}:`, { error });
          }
        }

        res.json({ total: orders.length, done, errors, errorDetails });
      } catch (error: unknown) {
        logger.error("Recalculate factory order totals error:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
