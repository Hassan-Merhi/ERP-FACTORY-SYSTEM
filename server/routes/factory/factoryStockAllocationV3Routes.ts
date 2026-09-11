import type { Express, Request, Response } from "express";
import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { and, eq, sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import { resultRows } from "../../lib/queryResult";
import { db } from "../../db";
import { factoryV3Loads, factoryV3LoadBales } from "@shared/schema";
import { requireAuth } from "../../auth";

function getCompanyId(req: Request): number | null {
  return req.session?.factoryCompanyId || req.session?.currentCompanyId || null;
}

function getUserInfo(req: Request) {
  return {
    id: req.user?.id ?? null,
    name: req.user?.username ?? null,
  };
}

export function registerFactoryStockAllocationV3Routes(app: Express) {
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
        LEFT JOIN factory_customers  cu ON cu.id = p.customer_id
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
        LEFT JOIN factory_customers  cu ON cu.id = p.customer_id
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

  // ──────────────────────────────────────────────────────────────
  // POST /api/factory/v3/loads/:id/bales — scan bale into load
  // Same matching logic as existing system: referenceNumber, baleCode, articleCode
  // ──────────────────────────────────────────────────────────────
  app.post("/api/factory/v3/loads/:id/bales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const loadId = parseId(req.params.id);
      if (loadId === null) return res.status(400).json({ message: "Invalid id" });
      const { scanCode, bypass } = req.body;
      if (!scanCode) return res.status(400).json({ message: "scanCode is required" });

      const [load] = await db
        .select()
        .from(factoryV3Loads)
        .where(and(eq(factoryV3Loads.id, loadId), eq(factoryV3Loads.companyId, companyId)));
      if (!load) return res.status(404).json({ message: "Load not found" });
      if (load.status !== "loading")
        return res.status(400).json({ message: "Can only scan bales into a load that is currently Loading" });

      const scanLower = scanCode.toLowerCase().trim();

      type ScannedBaleRow = {
        id: number;
        baleCode: string;
        referenceNumber: string;
        articleCode: string;
        productName: string;
        weightKg: string;
        status: string;
      };

      // Find the bale by referenceNumber, baleCode, articleCode (pick ONE bale — prefer IN_STOCK)
      const balesFound = await db.execute(sql`
        SELECT id, bale_code AS "baleCode", reference_number AS "referenceNumber",
               article_code AS "articleCode", product_name AS "productName",
               weight_kg AS "weightKg", status
        FROM factory_bales
        WHERE company_id = ${companyId}
          AND (
            LOWER(reference_number) = ${scanLower}
            OR LOWER(bale_code) = ${scanLower}
          )
        ORDER BY
          CASE status WHEN 'IN_STOCK' THEN 0 WHEN 'RESERVED_FOR_ORDER' THEN 1 ELSE 2 END
        LIMIT 1
      `);

      let bale = balesFound.rows[0] as ScannedBaleRow | undefined;

      // If not found by ref/baleCode, try articleCode (adds one IN_STOCK bale of that article)
      if (!bale) {
        const byArticle = await db.execute(sql`
          SELECT id, bale_code AS "baleCode", reference_number AS "referenceNumber",
                 article_code AS "articleCode", product_name AS "productName",
                 weight_kg AS "weightKg", status
          FROM factory_bales
          WHERE company_id = ${companyId}
            AND LOWER(article_code) = ${scanLower}
            AND status = 'IN_STOCK'
          ORDER BY id
          LIMIT 1
        `);
        bale = byArticle.rows[0] as ScannedBaleRow | undefined;
      }

      if (!bale) return res.status(404).json({ message: `No bale found for scan code: ${scanCode}` });

      // Block if already SOLD/SHIPPED
      if (bale.status === "SOLD" || bale.status === "SHIPPED") {
        return res
          .status(400)
          .json({ message: `Bale ${bale.referenceNumber} is already ${bale.status} and cannot be loaded` });
      }

      // Warn if already in this v3 load (not removed)
      const alreadyInLoad = await db.execute(sql`
        SELECT id FROM factory_v3_load_bales
        WHERE load_id = ${loadId} AND bale_id = ${bale.id} AND removed_at IS NULL
      `);
      if (alreadyInLoad.rows.length > 0) {
        return res.status(400).json({ message: `Bale ${bale.referenceNumber} is already in this load` });
      }

      // Warn if RESERVED_FOR_ORDER (old system) — allow bypass
      if (bale.status === "RESERVED_FOR_ORDER" && !bypass) {
        return res.status(409).json({
          code: "RESERVED_WARNING",
          message: `Bale ${bale.referenceNumber} is reserved for another loading order. Scan again to confirm.`,
          bale,
        });
      }

      // Warn if bale is already in another active v3 load (not removed)
      const inOtherV3 = await db.execute(sql`
        SELECT lb.id, l.load_name AS "loadName"
        FROM factory_v3_load_bales lb
        JOIN factory_v3_loads l ON l.id = lb.load_id
        WHERE lb.bale_id = ${bale.id}
          AND lb.removed_at IS NULL
          AND lb.load_id <> ${loadId}
          AND l.status IN ('expected_to_load', 'loading')
          AND l.company_id = ${companyId}
        LIMIT 1
      `);
      const otherV3 = inOtherV3.rows[0];
      if (otherV3 && !bypass) {
        return res.status(409).json({
          code: "OTHER_V3_LOAD_WARNING",
          message: `Bale ${bale.referenceNumber} is already assigned to v3 load "${otherV3.loadName}". Scan again to confirm.`,
          bale,
        });
      }

      const user = getUserInfo(req);
      const [added] = await db
        .insert(factoryV3LoadBales)
        .values({
          loadId,
          baleId: bale.id,
          baleReference: bale.referenceNumber || bale.baleCode,
          articleCode: bale.articleCode,
          productName: bale.productName,
          weightKg: bale.weightKg,
          phase: "scanned",
          addedBy: user.id,
          addedByName: user.name,
        })
        .returning();

      res.status(201).json({ ...added, baleStatus: bale.status });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // DELETE /api/factory/v3/loads/:id/bales/:baleId — soft-remove
  // ──────────────────────────────────────────────────────────────
  app.delete("/api/factory/v3/loads/:id/bales/:baleId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const loadId = parseId(req.params.id);
      if (loadId === null) return res.status(400).json({ message: "Invalid id" });
      const lbId = parseId(req.params.baleId);
      if (lbId === null) return res.status(400).json({ message: "Invalid id" });

      const [load] = await db
        .select()
        .from(factoryV3Loads)
        .where(and(eq(factoryV3Loads.id, loadId), eq(factoryV3Loads.companyId, companyId)));
      if (!load) return res.status(404).json({ message: "Load not found" });
      if (load.status === "finalized")
        return res.status(400).json({ message: "Cannot remove bales from a finalized load" });

      const user = getUserInfo(req);
      await db
        .update(factoryV3LoadBales)
        .set({ removedAt: new Date(), removedBy: user.id, removedByName: user.name })
        .where(and(eq(factoryV3LoadBales.id, lbId), eq(factoryV3LoadBales.loadId, loadId)));

      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // POST /api/factory/v3/loads/:id/finalize
  // Marks all non-removed scanned bales as SOLD in factory_bales
  // ──────────────────────────────────────────────────────────────
  app.post("/api/factory/v3/loads/:id/finalize", requireAuth, async (req: Request, res: Response) => {
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
      if (load.status !== "loading")
        return res.status(400).json({ message: "Can only finalize a load that is currently Loading" });

      // Get all non-removed bales in this load
      const baleRows = await db.execute(sql`
        SELECT bale_id FROM factory_v3_load_bales
        WHERE load_id = ${id} AND removed_at IS NULL
      `);
      const baleIds: number[] = resultRows<{ bale_id?: number; baleId?: number }>(baleRows).map(
        (r) => (r.bale_id ?? r.baleId) as number
      );

      // Mark each bale as SOLD in factory_bales (same end-state as existing finalization)
      if (baleIds.length > 0) {
        await db.execute(sql`
          UPDATE factory_bales
          SET status = 'SOLD'
          WHERE id = ANY(${sqlArray(baleIds)})
            AND company_id = ${companyId}
        `);
      }

      const user = getUserInfo(req);
      const [updated] = await db
        .update(factoryV3Loads)
        .set({ status: "finalized", finalizedAt: new Date(), finalizedBy: user.id, finalizedByName: user.name })
        .where(eq(factoryV3Loads.id, id))
        .returning();

      res.json(updated);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // PATCH /api/factory/v3/loads/:id/cancel
  // ──────────────────────────────────────────────────────────────
  app.patch("/api/factory/v3/loads/:id/cancel", requireAuth, async (req: Request, res: Response) => {
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
  });

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
        JOIN factory_customers cu ON cu.id = p.customer_id
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
