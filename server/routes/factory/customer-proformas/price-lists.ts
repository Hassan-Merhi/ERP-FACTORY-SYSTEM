/**
 * factoryCustomerProformaRoutes: FactoryCustomerPriceList endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { pool } from "../../../db";
import { requireAuth } from "../../../auth";

export function registerFactoryCustomerPriceListRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // CUSTOMER PRICE LISTS (agreed prices per customer)
  // ───────────────────────────────────────────────

  // GET  /api/factory/customer-price-lists/:customerId
  app.get("/api/factory/customer-price-lists/:customerId", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const customerId = parseInt(req.params.customerId, 10);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customerId" });
      const result = await pool.query(
        `SELECT cpl.article_code, cpl.price_per_bale, cpl.updated_at,
                COALESCE(fbp.name, '') AS item_name
         FROM customer_price_lists cpl
         LEFT JOIN factory_bale_products fbp
           ON fbp.company_id = $1 AND fbp.article_code = cpl.article_code AND fbp.deleted_at IS NULL
         WHERE cpl.company_id = $1 AND cpl.customer_id = $2
         ORDER BY cpl.article_code`,
        [companyId, customerId]
      );
      return res.json(result.rows);
    } catch (e: unknown) {
      return res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // POST /api/factory/customer-price-lists/:customerId/from-proforma/:proformaId
  // Copies all line prices from an existing proforma into the customer's agreed price list
  app.post(
    "/api/factory/customer-price-lists/:customerId/from-proforma/:proformaId",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const customerId = parseInt(req.params.customerId, 10);
        const proformaId = parseInt(req.params.proformaId, 10);
        if (isNaN(customerId) || isNaN(proformaId)) return res.status(400).json({ message: "Invalid parameters" });

        // Verify the proforma belongs to this company & customer
        const proformaCheck = await pool.query(
          `SELECT id FROM customer_proformas WHERE id = $1 AND company_id = $2 AND customer_id = $3`,
          [proformaId, companyId, customerId]
        );
        if (!proformaCheck.rowCount || proformaCheck.rowCount === 0) {
          return res.status(404).json({ message: "Proforma not found" });
        }

        // Fetch the proforma lines
        const linesRes = await pool.query(
          `SELECT article_code, price_per_bale FROM customer_proforma_lines WHERE proforma_id = $1 AND article_code IS NOT NULL AND price_per_bale IS NOT NULL`,
          [proformaId]
        );
        if (linesRes.rows.length === 0) return res.json({ saved: 0 });

        // Upsert each line into customer_price_lists
        let saved = 0;
        let backfilled = 0;
        for (const row of linesRes.rows) {
          const price = parseFloat(row.price_per_bale);
          if (isNaN(price) || price <= 0) continue;

          // 1. Save / update the agreed price list entry
          await pool.query(
            `INSERT INTO customer_price_lists (company_id, customer_id, article_code, price_per_bale, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (company_id, customer_id, article_code)
           DO UPDATE SET price_per_bale = EXCLUDED.price_per_bale, updated_at = now()`,
            [companyId, customerId, row.article_code, price]
          );
          saved++;

          // 2. Backfill ALL existing proforma lines for this customer + article_code
          //    (active and inactive, including the source proforma itself)
          const backfillRes = await pool.query(
            `UPDATE customer_proforma_lines cpl
           SET price_per_bale = $1
           FROM customer_proformas cp
           WHERE cpl.proforma_id = cp.id
             AND cp.company_id   = $2
             AND cp.customer_id  = $3
             AND cpl.article_code = $4`,
            [price, companyId, customerId, row.article_code]
          );
          backfilled += backfillRes.rowCount ?? 0;
        }
        return res.json({ saved, backfilled });
      } catch (e: unknown) {
        return res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // PUT /api/factory/customer-price-lists/:customerId
  // Bulk upsert — body: [{ articleCode, pricePerBale }]
  app.put("/api/factory/customer-price-lists/:customerId", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const customerId = parseInt(req.params.customerId, 10);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customerId" });
      const lines: { articleCode: string; pricePerBale: string | number }[] = req.body;
      if (!Array.isArray(lines)) return res.status(400).json({ message: "Body must be an array" });
      let saved = 0;
      for (const line of lines) {
        if (!line.articleCode) continue;
        const price = parseFloat(String(line.pricePerBale));
        if (isNaN(price) || price <= 0) continue;
        await pool.query(
          `INSERT INTO customer_price_lists (company_id, customer_id, article_code, price_per_bale, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (company_id, customer_id, article_code)
           DO UPDATE SET price_per_bale = EXCLUDED.price_per_bale, updated_at = now()`,
          [companyId, customerId, line.articleCode, price]
        );
        saved++;
      }
      return res.json({ saved });
    } catch (e: unknown) {
      return res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // DELETE /api/factory/customer-price-lists/:customerId/:articleCode
  app.delete("/api/factory/customer-price-lists/:customerId/:articleCode", requireAuth, async (req: import("express").Request, res: import("express").Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const customerId = parseInt(req.params.customerId, 10);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customerId" });
      const articleCode = req.params.articleCode;
      await pool.query(
        `DELETE FROM customer_price_lists WHERE company_id = $1 AND customer_id = $2 AND article_code = $3`,
        [companyId, customerId, articleCode]
      );
      return res.json({ deleted: true });
    } catch (e: unknown) {
      return res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ───────────────────────────────────────────────
  // CUSTOMER ORDERS CRUD + FINALIZE
  // ───────────────────────────────────────────────
}
