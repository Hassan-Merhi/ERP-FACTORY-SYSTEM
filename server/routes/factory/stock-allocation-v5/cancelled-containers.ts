/**
 * factoryStockAllocationV5Routes: V5CancelledContainer endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import { restoreCancelledContainerAtomically, RestoreCancelledContainerError } from "./restoreCancelledContainerAtomic";

export function registerV5CancelledContainerRoutes(app: Express) {
  // ── GET /api/factory/v5/recently-cancelled-containers ────────────────────
  // Returns V5 containers (proforma_id_used IS NOT NULL) that were cancelled
  // within the last 30 days. Used by the "Restore Cancelled Container" UI.
  // Read-only — does not modify any data.
  app.get("/api/factory/v5/recently-cancelled-containers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const raw = await db.execute(
        sql`SELECT
              co.id,
              co.container_number      AS "containerNumber",
              co.status,
              co.customer_id           AS "customerId",
              co.updated_at            AS "cancelledAt",
              co.loading_started_at    AS "loadingStartedAt",
              co.proforma_id_used      AS "proformaId",
              c.legal_name             AS "customerName",
              cp.name                  AS "proformaName"
            FROM customer_orders co
            LEFT JOIN customers c    ON c.id  = co.customer_id
            LEFT JOIN customer_proformas cp ON cp.id = co.proforma_id_used
            WHERE co.company_id          = ${companyId}
              AND co.status              = 'CANCELLED'
              AND co.proforma_id_used    IS NOT NULL
              AND co.updated_at          >= NOW() - INTERVAL '30 days'
            ORDER BY co.updated_at DESC
            LIMIT 50`
      );

      const orders = resultRows(raw).map((r) => ({
        id: Number(r.id),
        containerNumber: r.containerNumber ?? `Order #${r.id}`,
        status: r.status,
        customerId: r.customerId ? Number(r.customerId) : null,
        customerName: r.customerName ?? "Unknown",
        cancelledAt: r.cancelledAt,
        wasLoading: !!r.loadingStartedAt,
        proformaId: r.proformaId ? Number(r.proformaId) : null,
        proformaName: r.proformaName ?? null,
      }));

      res.json({ orders });
    } catch (err: unknown) {
      logger.error("[V5] recently-cancelled-containers error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // Restores status + archived bale links as one proforma-serialized transaction.
  app.post("/api/factory/v5/containers/:id/restore", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ message: "Invalid id" });

      const result = await restoreCancelledContainerAtomically({ companyId, orderId });
      res.json(result);
    } catch (err: unknown) {
      logger.error("[V5] restore-container error:", { error: err });
      if (err instanceof RestoreCancelledContainerError) {
        return res.status(err.status).json({ message: err.message, ...(err.details ?? {}) });
      }
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
