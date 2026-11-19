/**
 * factoryCustomerProformaRoutes: FactoryCustomerProformaBulkPricing endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db, pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryBaleProducts, customerProformaLines } from "@shared/schema";
import { eq } from "drizzle-orm";
import { toMoney } from "../../../lib/money";
import { normalizeProformaDestination } from "./destination";
import { registerFactoryCustomerProformaBulkPricingRoutesPart1 } from "./registerFactoryCustomerProformaBulkPricingRoutesPart1";

export function registerFactoryCustomerProformaBulkPricingRoutes(app: Express) {
  registerFactoryCustomerProformaBulkPricingRoutesPart1(app);

  // Explicitly reapply this customer's saved price list for this destination only.
  // Unmatched or locked lines remain untouched, as do other proformas.
  app.post(
    "/api/factory/customer-proformas/:id/apply-agreed-prices",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        const proformaResult = await pool.query<{ customer_id: number; destination: string | null }>(
          `SELECT customer_id, destination FROM customer_proformas
           WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
          [id, companyId]
        );
        if (!proformaResult.rows.length) return res.status(404).json({ message: "Proforma not found" });

        const { customer_id: customerId } = proformaResult.rows[0];
        const storedDestination = proformaResult.rows[0].destination;
        const destination = normalizeProformaDestination(storedDestination);
        if (!destination) {
          return res.status(400).json({ message: "Assign a destination before applying saved agreed prices" });
        }

        // Count matches and apply the change atomically. A saved price is per
        // bale, so switch a matching per-kg line to per-bale pricing as well.
        const result = await pool.query<{
          updated: number;
          skipped: number;
          fixed: number;
          unchanged: number;
        }>(
          `WITH candidates AS MATERIALIZED (
             SELECT line.id, line.price_fixed,
                    (
                      SELECT agreed.price_per_bale
                      FROM customer_destination_price_lists agreed
                      WHERE agreed.company_id = $2
                        AND agreed.customer_id = $3
                        AND agreed.destination = $4
                        AND LOWER(BTRIM(agreed.article_code)) = LOWER(BTRIM(line.article_code))
                      ORDER BY agreed.updated_at DESC, agreed.article_code
                      LIMIT 1
                    ) AS saved_price
             FROM customer_proforma_lines line
             JOIN customer_proformas proforma ON proforma.id = line.proforma_id
             WHERE proforma.id = $1 AND proforma.company_id = $2
               AND proforma.customer_id = $3 AND proforma.destination = $5
               AND proforma.deleted_at IS NULL
           ),
           applied AS (
             UPDATE customer_proforma_lines AS line
             SET price_per_bale = candidates.saved_price,
                 pricing_mode = 'per_bale',
                 price_per_kg = NULL
             FROM candidates
             WHERE line.id = candidates.id
               AND candidates.price_fixed IS NOT TRUE
               AND candidates.saved_price > 0
               AND (
                 line.price_per_bale IS DISTINCT FROM candidates.saved_price
                 OR line.pricing_mode IS DISTINCT FROM 'per_bale'
                 OR line.price_per_kg IS NOT NULL
               )
             RETURNING line.id
           )
           SELECT (SELECT COUNT(*) FROM applied)::integer AS updated,
                  (SELECT COUNT(*) FROM candidates WHERE price_fixed)::integer AS fixed,
                  (SELECT COUNT(*) FROM candidates WHERE price_fixed IS NOT TRUE
                    AND (saved_price IS NULL OR saved_price <= 0))::integer AS skipped,
                  ((SELECT COUNT(*) FROM candidates WHERE price_fixed IS NOT TRUE
                    AND saved_price > 0) - (SELECT COUNT(*) FROM applied))::integer AS unchanged`,
          [id, companyId, customerId, destination, storedDestination]
        );

        res.json({ ...result.rows[0], destination });
      } catch (error: unknown) {
        logger.error("Error applying destination agreed prices:", { error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Apply production price from catalogue to all non-fixed lines
  app.post(
    "/api/factory/customer-proformas/:id/apply-production-prices",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        const lines = await db.select().from(customerProformaLines).where(eq(customerProformaLines.proformaId, id));
        if (!lines.length) return res.json({ updated: 0, skipped: 0 });

        const products = await db
          .select()
          .from(factoryBaleProducts)
          .where(eq(factoryBaleProducts.companyId, companyId));
        const priceByArticleCode = new Map<string, string>();
        for (const p of products) {
          if (p.articleCode && p.productionPrice && toMoney(p.productionPrice).toNumber() > 0) {
            priceByArticleCode.set(p.articleCode.toLowerCase(), String(p.productionPrice));
          }
        }

        let updated = 0;
        let skipped = 0;
        let fixed = 0;
        for (const line of lines) {
          if (line.priceFixed) {
            fixed++;
            continue;
          }
          const newPrice = priceByArticleCode.get((line.articleCode || "").toLowerCase());
          if (newPrice) {
            await db
              .update(customerProformaLines)
              .set({ pricePerBale: newPrice })
              .where(eq(customerProformaLines.id, line.id));
            updated++;
          } else {
            skipped++;
          }
        }

        res.json({ updated, skipped, fixed });
      } catch (error: unknown) {
        logger.error("Error applying production prices:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
