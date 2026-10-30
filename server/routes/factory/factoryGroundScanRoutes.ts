import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { pool } from "../../db";
import { requireAuth } from "../../auth";

export function registerFactoryGroundScanRoutes(app: Express) {
  app.get("/api/factory/ground-scan-items", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const locationId = req.query.locationId as string | undefined;
      const locVal = locationId && locationId !== "all" ? parseInt(locationId, 10) : null;
      // Scan rows are permanent verification evidence, not the source of truth
      // for stock state. Resolve the current bale and its live outbound order
      // each read so loading, sale, return, dispatch and deletion show without rescanning.
      // Keep the snapshot only for legacy label-only scans with no factory_bales row.
      const query = `
        SELECT g.id, g.company_id, g.location_id, g.reference_number,
               COALESCE(NULLIF(bp.article_code, ''), NULLIF(fb.article_code, ''), g.article_code) AS article_code,
               COALESCE(NULLIF(fb.product_name, ''), NULLIF(g.product_name, ''), bp.name) AS product_name,
               COALESCE(fb.weight_kg, g.weight_kg) AS weight_kg,
               CASE
                 WHEN fb.deleted_at IS NOT NULL THEN 'DELETED'
                 WHEN fb.status IN ('DELETED', 'REMOVED') THEN fb.status
                 WHEN fb.status = 'IN_STOCK' AND active_order.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')
                   THEN 'SOLD'
                 WHEN fb.status IN ('IN_STOCK', 'RESERVED_FOR_ORDER') AND active_order.status = 'LOADING'
                   THEN 'LOADING'
                 WHEN fb.status = 'IN_STOCK' AND active_order.status IN ('PENDING_VERIFICATION', 'VERIFIED')
                   THEN 'RESERVED_FOR_ORDER'
                 ELSE COALESCE(fb.status, g.status)
               END AS status,
               (fb.id IS NOT NULL
                 AND fb.deleted_at IS NULL
                 AND fb.status IN ('IN_STOCK', 'RESERVED_FOR_ORDER')
                 AND active_order.status = 'LOADING') AS is_in_loading_order,
               g.scanned_at, g.scanned_by_user_id,
               fb.stock_entry_date::text AS date_bale_produced,
               fb.worker_name
          FROM factory_ground_scan_items g
          LEFT JOIN factory_bales fb
            ON fb.reference_number = g.reference_number
           AND fb.company_id = g.company_id::integer
          LEFT JOIN bale_products bp
            ON bp.id = fb.product_id
           AND bp.company_id = g.company_id::integer
          LEFT JOIN LATERAL (
            SELECT co.status
              FROM customer_order_bales cob
              JOIN customer_orders co ON co.id = cob.order_id
             WHERE cob.bale_id = fb.id
               AND co.company_id = fb.company_id
               AND co.deleted_at IS NULL
               AND co.status IN ('LOADING', 'PENDING_VERIFICATION', 'VERIFIED', 'FINALIZED', 'DISPATCHED', 'SOLD')
             ORDER BY CASE co.status
               WHEN 'FINALIZED' THEN 0
               WHEN 'SOLD' THEN 1
               WHEN 'DISPATCHED' THEN 2
               WHEN 'VERIFIED' THEN 3
               WHEN 'PENDING_VERIFICATION' THEN 4
               WHEN 'LOADING' THEN 5
               ELSE 9 END
             LIMIT 1
          ) active_order ON TRUE
         WHERE g.company_id = $1
           AND ${locVal === null ? "g.location_id IS NULL" : "g.location_id = $2"}
         ORDER BY g.scanned_at DESC
      `;
      const result = await pool.query(query, locVal === null ? [companyId] : [companyId, locVal]);
      return res.json(result.rows);
    } catch (e: unknown) {
      return res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.post("/api/factory/ground-scan-items", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const userId = req.session.userId;
      const { locationId, referenceNumber, articleCode, productName, weightKg, status, isInLoadingOrder } = req.body;
      if (!referenceNumber) return res.status(400).json({ message: "referenceNumber required" });
      const ref = String(referenceNumber).trim().toUpperCase();
      const excluded = await pool.query("SELECT 1 FROM factory_bales fb JOIN factory_settings fs ON fs.company_id=fb.company_id WHERE fb.company_id=$1 AND fb.reference_number=$2 AND COALESCE(fs.extra_settings->'nonBalePriorityProductIds','[]'::jsonb) @> jsonb_build_array(fb.product_id) LIMIT 1",[companyId,ref]);
      if(excluded.rowCount)return res.status(422).json({message:"Non-bale products are excluded from Ground Scan"});
      const locVal = locationId && locationId !== "all" ? parseInt(locationId, 10) : null;

      const check = await pool.query(
        locVal !== null
          ? `SELECT id FROM factory_ground_scan_items WHERE company_id=$1 AND location_id=$2 AND reference_number=$3`
          : `SELECT id FROM factory_ground_scan_items WHERE company_id=$1 AND location_id IS NULL AND reference_number=$2`,
        locVal !== null ? [companyId, locVal, ref] : [companyId, ref]
      );
      if (check.rowCount && check.rowCount > 0) {
        return res.status(409).json({ message: "Already scanned" });
      }

      const result = await pool.query(
        `INSERT INTO factory_ground_scan_items
           (company_id, location_id, reference_number, article_code, product_name,
            weight_kg, status, is_in_loading_order, scanned_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          companyId,
          locVal,
          ref,
          articleCode || null,
          productName || null,
          weightKg || null,
          status || null,
          isInLoadingOrder === true,
          userId,
        ]
      );
      return res.status(201).json(result.rows[0]);
    } catch (e: unknown) {
      return res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.post("/api/factory/ground-scan-items/bulk", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const userId = req.session.userId;
      const { locationId, items } = req.body;
      if (!Array.isArray(items) || items.length === 0) return res.json({ inserted: 0, skipped: 0 });
      const locVal = locationId && locationId !== "all" ? parseInt(locationId, 10) : null;

      let inserted = 0;
      let skipped = 0;
      for (const item of items) {
        const ref = String(item.refCode || item.reference_number || "")
          .trim()
          .toUpperCase();
        if (!ref) {
          skipped++;
          continue;
        }
        try {
          const excluded = await pool.query("SELECT 1 FROM factory_bales fb JOIN factory_settings fs ON fs.company_id=fb.company_id WHERE fb.company_id=$1 AND fb.reference_number=$2 AND COALESCE(fs.extra_settings->'nonBalePriorityProductIds','[]'::jsonb) @> jsonb_build_array(fb.product_id) LIMIT 1",[companyId,ref]);
          if(excluded.rowCount){skipped++;continue;}
          await pool.query(
            `INSERT INTO factory_ground_scan_items
               (company_id, location_id, reference_number, article_code, product_name,
                weight_kg, status, is_in_loading_order, scanned_at, scanned_by_user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (company_id, location_id, reference_number) DO NOTHING`,
            [
              companyId,
              locVal,
              ref,
              item.articleCode || item.article_code || null,
              item.productName || item.product_name || null,
              item.weightKg || item.weight_kg || null,
              item.status || null,
              item.isInLoadingOrder === true,
              item.scannedAt ? new Date(item.scannedAt) : new Date(),
              userId,
            ]
          );
          inserted++;
        } catch {
          skipped++;
        }
      }
      return res.json({ inserted, skipped });
    } catch (e: unknown) {
      return res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.delete("/api/factory/ground-scan-items/:id", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      await pool.query(`DELETE FROM factory_ground_scan_items WHERE id=$1 AND company_id=$2`, [id, companyId]);
      return res.json({ success: true });
    } catch (e: unknown) {
      return res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  app.delete("/api/factory/ground-scan-items", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const locationId = req.query.locationId as string | undefined;
      const locVal = locationId && locationId !== "all" ? parseInt(locationId, 10) : null;
      if (locVal !== null) {
        await pool.query(`DELETE FROM factory_ground_scan_items WHERE company_id=$1 AND location_id=$2`, [
          companyId,
          locVal,
        ]);
      } else {
        await pool.query(`DELETE FROM factory_ground_scan_items WHERE company_id=$1 AND location_id IS NULL`, [
          companyId,
        ]);
      }
      return res.json({ success: true });
    } catch (e: unknown) {
      return res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
