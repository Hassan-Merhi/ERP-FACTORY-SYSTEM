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
import { parseMoneyInput } from "../../../lib/money";
import { normalizeProformaDestination } from "./destination";

export function registerFactoryCustomerPriceListRoutes(app: Express) {
  // Destinations with a proforma or an explicitly saved destination price list.
  // Legacy customer-wide prices are deliberately not assigned to any destination.
  app.get(
    "/api/factory/customer-price-lists/:customerId/destinations",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const customerId = parseInt(req.params.customerId, 10);
        if (!Number.isInteger(customerId) || customerId <= 0) {
          return res.status(400).json({ message: "Invalid customerId" });
        }
        const result = await pool.query<{ destination: string }>(
          `SELECT destination FROM customer_proformas
           WHERE company_id = $1 AND customer_id = $2
             AND deleted_at IS NULL AND destination IS NOT NULL
           UNION
           SELECT destination FROM customer_destination_price_lists
           WHERE company_id = $1 AND customer_id = $2`,
          [companyId, customerId]
        );
        const destinations = [...new Set(
          result.rows.map((row) => normalizeProformaDestination(row.destination)).filter((value): value is string => !!value)
        )].sort((a, b) => a.localeCompare(b));
        return res.json(destinations);
      } catch (e: unknown) {
        return res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ───────────────────────────────────────────────
  // CUSTOMER PRICE LISTS (agreed prices per customer)
  // ───────────────────────────────────────────────

  // GET  /api/factory/customer-price-lists/:customerId
  app.get(
    "/api/factory/customer-price-lists/:customerId",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const customerId = parseInt(req.params.customerId, 10);
        if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customerId" });
        // Existing customer-wide prices remain available to legacy price-list
        // screens, but destination-aware proformas only read their own destination.
        if (req.query.destination !== undefined) {
          const destination = normalizeProformaDestination(req.query.destination);
          if (!destination) return res.status(400).json({ message: "Valid destination is required" });
          const result = await pool.query(
            `SELECT cpl.article_code, cpl.price_per_bale, cpl.updated_at,
                    COALESCE(fbp.name, '') AS item_name
             FROM customer_destination_price_lists cpl
             LEFT JOIN factory_bale_products fbp
               ON fbp.company_id = $1 AND fbp.article_code = cpl.article_code AND fbp.deleted_at IS NULL
             WHERE cpl.company_id = $1 AND cpl.customer_id = $2 AND cpl.destination = $3
             ORDER BY cpl.article_code`,
            [companyId, customerId, destination]
          );
          return res.json(result.rows);
        }
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
    }
  );

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
          `SELECT id, destination FROM customer_proformas WHERE id = $1 AND company_id = $2 AND customer_id = $3 AND deleted_at IS NULL`,
          [proformaId, companyId, customerId]
        );
        if (!proformaCheck.rowCount || proformaCheck.rowCount === 0) {
          return res.status(404).json({ message: "Proforma not found" });
        }

        // An agreed price is owned by this proforma's customer + destination.
        // Older proformas must be linked explicitly before saving agreed prices.
        const destination = normalizeProformaDestination(proformaCheck.rows[0].destination);
        if (!destination) {
          return res.status(400).json({ message: "Assign a destination to this proforma before saving agreed prices" });
        }

        // Fetch the proforma lines
        const linesRes = await pool.query(
          `SELECT article_code, price_per_bale FROM customer_proforma_lines WHERE proforma_id = $1 AND article_code IS NOT NULL AND price_per_bale IS NOT NULL`,
          [proformaId]
        );
        if (linesRes.rows.length === 0) return res.json({ saved: 0, backfilled: 0 });

        // Upsert this destination's agreed prices only; do not alter any proforma lines.
        let saved = 0;
        for (const row of linesRes.rows) {
          const price = parseMoneyInput(row.price_per_bale)?.toNumber() ?? NaN;
          if (isNaN(price) || price <= 0) continue;

          await pool.query(
            `INSERT INTO customer_destination_price_lists
              (company_id, customer_id, destination, article_code, price_per_bale, updated_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (company_id, customer_id, destination, article_code)
             DO UPDATE SET price_per_bale = EXCLUDED.price_per_bale, updated_at = now()`,
            [companyId, customerId, destination, row.article_code, price]
          );
          saved++;
        }
        return res.json({ saved, backfilled: 0, destination });
      } catch (e: unknown) {
        return res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // PUT /api/factory/customer-price-lists/:customerId
  // Bulk upsert — body: [{ articleCode, pricePerBale }]
  app.put(
    "/api/factory/customer-price-lists/:customerId",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const customerId = parseInt(req.params.customerId, 10);
        if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customerId" });
        const lines: { articleCode: string; pricePerBale: string | number }[] = req.body;
        if (!Array.isArray(lines)) return res.status(400).json({ message: "Body must be an array" });
        // Optional destination enables explicit manual pricing for a route.
        // No destination keeps the legacy customer-wide price-list contract.
        const destination =
          req.query.destination === undefined ? null : normalizeProformaDestination(req.query.destination);
        if (req.query.destination !== undefined && !destination) {
          return res.status(400).json({ message: "Valid destination is required" });
        }
        let saved = 0;
        for (const line of lines) {
          if (!line.articleCode) continue;
          const price = parseMoneyInput(String(line.pricePerBale))?.toNumber() ?? NaN;
          if (isNaN(price) || price <= 0) continue;
          if (destination) {
            await pool.query(
              `INSERT INTO customer_destination_price_lists
                 (company_id, customer_id, destination, article_code, price_per_bale, updated_at)
               VALUES ($1, $2, $3, $4, $5, now())
               ON CONFLICT (company_id, customer_id, destination, article_code)
               DO UPDATE SET price_per_bale = EXCLUDED.price_per_bale, updated_at = now()`,
              [companyId, customerId, destination, line.articleCode, price]
            );
          } else {
            await pool.query(
              `INSERT INTO customer_price_lists (company_id, customer_id, article_code, price_per_bale, updated_at)
               VALUES ($1, $2, $3, $4, now())
               ON CONFLICT (company_id, customer_id, article_code)
               DO UPDATE SET price_per_bale = EXCLUDED.price_per_bale, updated_at = now()`,
              [companyId, customerId, line.articleCode, price]
            );
          }
          saved++;
        }
        return res.json({ saved, destination });
      } catch (e: unknown) {
        return res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // DELETE /api/factory/customer-price-lists/:customerId/:articleCode
  app.delete(
    "/api/factory/customer-price-lists/:customerId/:articleCode",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const customerId = parseInt(req.params.customerId, 10);
        if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customerId" });
        const articleCode = req.params.articleCode;
        const destination = req.query.destination === undefined
          ? null
          : normalizeProformaDestination(req.query.destination);
        if (req.query.destination !== undefined && !destination) {
          return res.status(400).json({ message: "Valid destination is required" });
        }
        if (destination) {
          await pool.query(
            `DELETE FROM customer_destination_price_lists
             WHERE company_id = $1 AND customer_id = $2 AND destination = $3 AND article_code = $4`,
            [companyId, customerId, destination, articleCode]
          );
        } else {
          // Legacy customer-wide entries remain separate from destination pricing.
          await pool.query(
            `DELETE FROM customer_price_lists WHERE company_id = $1 AND customer_id = $2 AND article_code = $3`,
            [companyId, customerId, articleCode]
          );
        }
        return res.json({ deleted: true, destination });
      } catch (e: unknown) {
        return res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ───────────────────────────────────────────────
  // CUSTOMER ORDERS CRUD + FINALIZE
  // ───────────────────────────────────────────────
}
