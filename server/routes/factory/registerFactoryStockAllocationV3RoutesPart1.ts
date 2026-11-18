// Extracted from ./factoryStockAllocationV3Routes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { factoryV3Loads } from "@shared/schema";
import { requireAuth } from "../../auth";

export function getCompanyId(req: Request): number | null {
  return req.session?.factoryCompanyId || req.session?.currentCompanyId || null;
}

export function getUserInfo(req: Request) {
  return {
    id: req.user?.id ?? null,
    name: req.user?.username ?? null,
  };
}

export function registerFactoryStockAllocationV3RoutesPart1(app: Express) {
  // ──────────────────────────────────────────────────────────────
  // GET /api/factory/v3/stock-overview
  // Per-article-code FTP: IN_STOCK - v3 expected_to_load - v3 loading
  // ──────────────────────────────────────────────────────────────
  app.get("/api/factory/v3/stock-overview", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const result = await db.execute(sql`
        WITH
        in_stock AS (
          SELECT article_code, product_name, COUNT(*)::int AS bale_count,
                 SUM(weight_kg)::numeric AS weight_kg
          FROM factory_bales
          WHERE company_id = ${companyId} AND status = 'IN_STOCK'
            AND article_code IS NOT NULL
          GROUP BY article_code, product_name
        ),
        v3_etl AS (
          SELECT lb.article_code, COUNT(*)::int AS bale_count,
                 SUM(lb.weight_kg)::numeric AS weight_kg
          FROM factory_v3_load_bales lb
          JOIN factory_v3_loads l ON l.id = lb.load_id
          WHERE l.company_id = ${companyId}
            AND l.status = 'expected_to_load'
            AND lb.removed_at IS NULL
            AND lb.article_code IS NOT NULL
          GROUP BY lb.article_code
        ),
        v3_loading AS (
          SELECT lb.article_code, COUNT(*)::int AS bale_count,
                 SUM(lb.weight_kg)::numeric AS weight_kg
          FROM factory_v3_load_bales lb
          JOIN factory_v3_loads l ON l.id = lb.load_id
          WHERE l.company_id = ${companyId}
            AND l.status = 'loading'
            AND lb.removed_at IS NULL
            AND lb.article_code IS NOT NULL
          GROUP BY lb.article_code
        ),
        all_codes AS (
          SELECT article_code FROM in_stock
          UNION
          SELECT article_code FROM v3_etl
          UNION
          SELECT article_code FROM v3_loading
        )
        SELECT
          a.article_code AS "articleCode",
          COALESCE(i.product_name, a.article_code) AS "productName",
          COALESCE(i.bale_count, 0) AS "inStockBales",
          ROUND(COALESCE(i.weight_kg, 0), 3)::text AS "inStockKg",
          COALESCE(etl.bale_count, 0) AS "expectedToLoadBales",
          ROUND(COALESCE(etl.weight_kg, 0), 3)::text AS "expectedToLoadKg",
          COALESCE(ld.bale_count, 0) AS "loadingBales",
          ROUND(COALESCE(ld.weight_kg, 0), 3)::text AS "loadingKg",
          (COALESCE(i.bale_count, 0) - COALESCE(etl.bale_count, 0) - COALESCE(ld.bale_count, 0)) AS "ftpBales",
          ROUND(COALESCE(i.weight_kg, 0) - COALESCE(etl.weight_kg, 0) - COALESCE(ld.weight_kg, 0), 3)::text AS "ftpKg"
        FROM all_codes a
        LEFT JOIN in_stock      i   ON i.article_code   = a.article_code
        LEFT JOIN v3_etl        etl ON etl.article_code = a.article_code
        LEFT JOIN v3_loading    ld  ON ld.article_code  = a.article_code
        ORDER BY a.article_code
      `);

      const rows = result.rows;
      res.json(rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // GET /api/factory/v3/loads
  // ──────────────────────────────────────────────────────────────
  app.get("/api/factory/v3/loads", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const statusFilter = req.query.status as string | undefined;

      const result = await db.execute(sql`
        SELECT
          l.id,
          l.proforma_id       AS "proformaId",
          p.name              AS "proformaName",
          cu.legal_name       AS "customerName",
          cu.id               AS "customerId",
          l.load_name         AS "loadName",
          l.expected_load_date AS "expectedLoadDate",
          l.notes,
          l.status,
          l.created_by_name   AS "createdByName",
          l.created_at        AS "createdAt",
          l.started_at        AS "startedAt",
          l.finalized_at      AS "finalizedAt",
          l.finalized_by_name AS "finalizedByName",
          l.cancelled_at      AS "cancelledAt",
          COUNT(lb.id) FILTER (WHERE lb.removed_at IS NULL)::int AS "totalBales",
          COUNT(lb.id) FILTER (WHERE lb.removed_at IS NULL AND lb.phase = 'scanned')::int AS "scannedBales",
          ROUND(COALESCE(SUM(lb.weight_kg) FILTER (WHERE lb.removed_at IS NULL), 0), 3)::text AS "totalWeightKg",
          ROUND(COALESCE(SUM(lb.weight_kg) FILTER (WHERE lb.removed_at IS NULL AND lb.phase = 'scanned'), 0), 3)::text AS "scannedWeightKg"
        FROM factory_v3_loads l
        LEFT JOIN customer_proformas p  ON p.id = l.proforma_id
        LEFT JOIN customers          cu ON cu.id = p.customer_id
        LEFT JOIN factory_v3_load_bales lb ON lb.load_id = l.id
        WHERE l.company_id = ${companyId}
          ${statusFilter ? sql`AND l.status = ${statusFilter}` : sql``}
        GROUP BY l.id, p.name, cu.legal_name, cu.id
        ORDER BY l.created_at DESC
      `);

      res.json(result.rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // GET /api/factory/v3/loads/:id
  // Single load with full bale list
  // ──────────────────────────────────────────────────────────────
  app.get("/api/factory/v3/loads/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      const loadResult = await db.execute(sql`
        SELECT
          l.id,
          l.proforma_id       AS "proformaId",
          p.name              AS "proformaName",
          cu.legal_name       AS "customerName",
          cu.id               AS "customerId",
          l.load_name         AS "loadName",
          l.expected_load_date AS "expectedLoadDate",
          l.notes,
          l.status,
          l.created_by_name   AS "createdByName",
          l.created_at        AS "createdAt",
          l.started_at        AS "startedAt",
          l.finalized_at      AS "finalizedAt",
          l.finalized_by_name AS "finalizedByName",
          l.cancelled_at      AS "cancelledAt"
        FROM factory_v3_loads l
        LEFT JOIN customer_proformas p  ON p.id = l.proforma_id
        LEFT JOIN customers          cu ON cu.id = p.customer_id
        WHERE l.id = ${id} AND l.company_id = ${companyId}
      `);

      const rows = loadResult.rows;
      if (!rows.length) return res.status(404).json({ message: "Load not found" });
      const load = rows[0];

      const baleRows = await db.execute(sql`
        SELECT
          lb.id,
          lb.bale_id       AS "baleId",
          lb.bale_reference AS "baleReference",
          lb.article_code  AS "articleCode",
          lb.product_name  AS "productName",
          lb.weight_kg     AS "weightKg",
          lb.phase,
          lb.added_by_name AS "addedByName",
          lb.added_at      AS "addedAt",
          lb.removed_by_name AS "removedByName",
          lb.removed_at    AS "removedAt",
          lb.notes,
          fb.status        AS "baleStatus"
        FROM factory_v3_load_bales lb
        LEFT JOIN factory_bales fb ON fb.id = lb.bale_id
        WHERE lb.load_id = ${id}
        ORDER BY lb.added_at DESC
      `);

      const bales = baleRows.rows;

      // Proforma lines for expected summary
      const lineRows = await db.execute(sql`
        SELECT pl.article_code AS "articleCode", pl.product_name AS "productName",
               pl.quantity
        FROM customer_proforma_lines pl
        WHERE pl.proforma_id = ${load.proformaId}
      `);
      const proformaLines = lineRows.rows;

      res.json({ ...load, bales, proformaLines });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // POST /api/factory/v3/loads  — create load from proforma
  // ──────────────────────────────────────────────────────────────
  app.post("/api/factory/v3/loads", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { proformaId, loadName, expectedLoadDate, notes } = req.body;
      if (!proformaId || !loadName || !expectedLoadDate)
        return res.status(400).json({ message: "proformaId, loadName, and expectedLoadDate are required" });

      const user = getUserInfo(req);
      const [load] = await db
        .insert(factoryV3Loads)
        .values({
          companyId,
          proformaId,
          loadName,
          expectedLoadDate,
          notes: notes || null,
          status: "expected_to_load",
          createdBy: user.id,
          createdByName: user.name,
        })
        .returning();

      res.status(201).json(load);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // PATCH /api/factory/v3/loads/:id/start — expected_to_load → loading
  // ──────────────────────────────────────────────────────────────
  app.patch("/api/factory/v3/loads/:id/start", requireAuth, async (req: Request, res: Response) => {
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
      if (load.status !== "expected_to_load")
        return res.status(400).json({ message: `Cannot start a load in status: ${load.status}` });

      const [updated] = await db
        .update(factoryV3Loads)
        .set({ status: "loading", startedAt: new Date() })
        .where(eq(factoryV3Loads.id, id))
        .returning();

      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
