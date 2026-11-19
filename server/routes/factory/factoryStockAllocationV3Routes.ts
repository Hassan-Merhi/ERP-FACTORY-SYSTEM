import type { Express, Request, Response } from "express";
import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { factoryV3Loads } from "@shared/schema";
import { requireAuth } from "../../auth";
import { getClientDate } from "../../lib/dateUtils";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { FactoryInvoiceRateRefusalError } from "../../services/accounting/perpetualInventory/factoryInvoice";
import { V3LoadFinalizeRefusalError, finalizeV3LoadTx } from "../../services/factory/v3LoadInvoice";
import {
  getCompanyId,
  getUserInfo,
  registerFactoryStockAllocationV3RoutesPart1,
  v3LoadActionInput,
} from "./registerFactoryStockAllocationV3RoutesPart1";
import { validateRequest } from "../../lib/validateRequest";
import { registerFactoryStockAllocationV3RoutesPart3 } from "./registerFactoryStockAllocationV3RoutesPart3";

export function registerFactoryStockAllocationV3Routes(app: Express) {
  registerFactoryStockAllocationV3RoutesPart1(app);
  registerFactoryStockAllocationV3RoutesPart2(app);
}

function registerFactoryStockAllocationV3RoutesPart2(app: Express) {
  registerFactoryStockAllocationV3RoutesPart3(app);

  // ──────────────────────────────────────────────────────────────
  // POST /api/factory/v3/loads/:id/finalize
  // Invoices the load and marks its live bales SOLD, in one transaction
  // (wave 17 B, services/factory/v3LoadInvoice.ts). Re-finalize is idempotent.
  // ──────────────────────────────────────────────────────────────
  app.post(
    "/api/factory/v3/loads/:id/finalize",
    requireAuth,
    requireFactoryTabAccess("factory/invoicing", "hide_invoicing_invoices_tab"),
    validateRequest(v3LoadActionInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        const result = await db.transaction((tx) =>
          finalizeV3LoadTx(tx, {
            companyId,
            loadId: id,
            user: getUserInfo(req),
            statementDate: getClientDate(req),
          })
        );
        res.json({ ...result.load, invoice: result.invoice, alreadyFinalized: result.alreadyFinalized });
      } catch (e: unknown) {
        if (e instanceof V3LoadFinalizeRefusalError) return res.status(e.statusCode).json(e.body);
        if (e instanceof FactoryInvoiceRateRefusalError) return res.status(409).json(e.body);
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // PATCH /api/factory/v3/loads/:id/cancel
  // ──────────────────────────────────────────────────────────────
  app.patch(
    "/api/factory/v3/loads/:id/cancel",
    requireAuth,
    validateRequest(v3LoadActionInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        const [load] = await db
          .select()
          .from(factoryV3Loads)
          .where(and(eq(factoryV3Loads.id, id), eq(factoryV3Loads.companyId, companyId)));
        if (!load) return res.status(404).json({ message: "Load not found" });
        if (load.status === "finalized") return res.status(400).json({ message: "Cannot cancel a finalized load" });

        const [updated] = await db
          .update(factoryV3Loads)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(eq(factoryV3Loads.id, id))
          .returning();

        res.json(updated);
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // GET /api/factory/v3/proformas
  // Active proformas with line counts + linked v3 load summary
  // ──────────────────────────────────────────────────────────────
  app.get("/api/factory/v3/proformas", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const result = await db.execute(sql`
        SELECT
          p.id,
          p.name,
          p.is_active       AS "isActive",
          p.created_at      AS "createdAt",
          cu.id             AS "customerId",
          cu.legal_name     AS "customerName",
          COALESCE(pl.line_count, 0) AS "lineCount",
          COALESCE(pl.total_qty, 0)  AS "totalQty",
          COALESCE(vl.load_count, 0) AS "v3LoadCount",
          COALESCE(vl.active_count, 0) AS "v3ActiveCount"
        FROM customer_proformas p
        JOIN customers cu ON cu.id = p.customer_id
        LEFT JOIN (
          SELECT proforma_id,
                 COUNT(*)::int AS line_count,
                 SUM(quantity)::int AS total_qty
          FROM customer_proforma_lines
          GROUP BY proforma_id
        ) pl ON pl.proforma_id = p.id
        LEFT JOIN (
          SELECT proforma_id,
                 COUNT(*)::int AS load_count,
                 COUNT(*) FILTER (WHERE status IN ('expected_to_load','loading'))::int AS active_count
          FROM factory_v3_loads
          WHERE company_id = ${companyId}
          GROUP BY proforma_id
        ) vl ON vl.proforma_id = p.id
        WHERE p.company_id = ${companyId}
          AND p.is_active = true
        ORDER BY p.created_at DESC
      `);

      res.json(result.rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // GET /api/factory/v3/proformas/:id/loads
  // All v3 loads linked to a specific proforma
  // ──────────────────────────────────────────────────────────────
  app.get("/api/factory/v3/proformas/:id/loads", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const proformaId = parseId(req.params.id);
      if (proformaId === null) return res.status(400).json({ message: "Invalid id" });

      const result = await db.execute(sql`
        SELECT l.id, l.load_name AS "loadName", l.status,
               l.expected_load_date AS "expectedLoadDate",
               l.created_at AS "createdAt",
               l.finalized_at AS "finalizedAt",
               COUNT(lb.id) FILTER (WHERE lb.removed_at IS NULL)::int AS "baleCount"
        FROM factory_v3_loads l
        LEFT JOIN factory_v3_load_bales lb ON lb.load_id = l.id
        WHERE l.company_id = ${companyId} AND l.proforma_id = ${proformaId}
        GROUP BY l.id
        ORDER BY l.created_at DESC
      `);

      res.json(result.rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
