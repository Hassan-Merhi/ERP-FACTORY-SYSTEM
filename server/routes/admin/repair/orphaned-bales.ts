/**
 * adminRepairRoutes: AdminOrphanedBale endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { emptyBody, emptyQuery, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";
import {} from "@shared/schema";
import { sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";

/** This repair takes no input. */
const noInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerAdminOrphanedBaleRoutes(app: Express) {
  app.post(
    "/api/admin/fix-orphaned-bales",
    requireAuth,
    requireRole("Admin", "Owner"),
    validateRequest(noInput),
    async (_req, res) => {
      try {
        const companyId = _req.session.factoryCompanyId || _req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const result = await db.execute(sql`
        UPDATE factory_bales AS fb
           SET status = 'IN_STOCK', updated_at = NOW()
         WHERE fb.company_id = ${companyId}
           AND fb.status = 'RESERVED_FOR_ORDER'
           AND fb.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1
               FROM customer_order_bales cob
               JOIN customer_orders co ON co.id = cob.order_id
              WHERE cob.bale_id = fb.id
                AND co.company_id = fb.company_id
                AND co.deleted_at IS NULL
                AND co.status IN ('DRAFT', 'LOADING', 'PENDING_VERIFICATION',
                                  'VERIFIED', 'FINALIZED', 'DISPATCHED', 'SOLD')
           )
        RETURNING id
      `);
        const fixed = resultRows(result)?.length ?? 0;
        res.json({ fixed, message: fixed > 0 ? `Restored ${fixed} bale(s) to IN_STOCK` : "No orphaned bales found" });
      } catch (error: unknown) {
        logger.error("[BaleOrphanFix] Error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
