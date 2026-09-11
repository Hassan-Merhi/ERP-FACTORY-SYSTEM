/**
 * factoryStockAllocationV5Routes: V5LocationSummary endpoints.
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
import { sqlArray } from "../../../lib/sqlArray";
import { resultRows } from "../../../lib/queryResult";

export function registerV5LocationSummaryRoutes(app: Express) {
  // ── GET /api/factory/v5/location-summary ──────────────────────────────────
  // Returns per-article V5 stock balance for a specific warehouse location:
  //   inStock          — factory_bales.status = IN_STOCK at this location
  //   reservedExpected — SUM(expected_qty) from DRAFT V5 orders on active proformas (company-wide)
  //   loading          — bales at this location in LOADING V5 containers
  //   availableBalance — inStock − reservedExpected − loading
  //
  // V5 guard: proforma_id_used IS NOT NULL (applied to both reservedExpected and loading queries)
  // Does NOT read proforma_stock_reservations or any V2/V3 table.
  app.get("/api/factory/v5/location-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const locationId = parseInt(String(req.query.locationId));
      if (!locationId || isNaN(locationId))
        return res.status(400).json({ message: "locationId query param is required" });

      // 1. inStock — IN_STOCK bales at this location, grouped by article
      const inStockRaw = await db.execute(
        sql`SELECT article_code AS "articleCode", COUNT(*)::int AS count
            FROM factory_bales
            WHERE company_id = ${companyId}
              AND erp_location_id = ${locationId}
              AND status = 'IN_STOCK'
            GROUP BY article_code`
      );
      const inStockMap = new Map<string, number>(
        resultRows<{ articleCode: string; count: number }>(inStockRaw).map((r) => [r.articleCode, Number(r.count)])
      );

      // 2. reservedExpected — SUM(expected_qty) for DRAFT V5 orders on active proformas (company-wide)
      //    V5 guard: proforma_id_used IS NOT NULL
      //    Does NOT filter by location: DRAFT containers are reservations not yet physically loaded.
      const reservedRaw = await db.execute(
        sql`SELECT cel.article_code AS "articleCode", SUM(cel.expected_qty)::int AS total
            FROM customer_order_expected_lines cel
            JOIN customer_orders co ON co.id = cel.order_id
            JOIN customer_proformas cp ON cp.id = co.proforma_id_used
            WHERE cel.company_id = ${companyId}
              AND co.status = 'DRAFT'
              AND co.proforma_id_used IS NOT NULL
              AND cp.is_active = true
            GROUP BY cel.article_code`
      );
      const reservedMap = new Map<string, number>(
        resultRows<{ articleCode: string; total: number }>(reservedRaw).map((r) => [r.articleCode, Number(r.total)])
      );

      // 3. loading — bales at this location that have been scanned into LOADING V5 containers
      //    V5 guard: proforma_id_used IS NOT NULL
      //    Location-filtered because bales are physically at the location when loaded.
      const loadingRaw = await db.execute(
        sql`SELECT fb.article_code AS "articleCode", COUNT(*)::int AS count
            FROM customer_order_bales cob
            JOIN factory_bales fb ON fb.id = cob.bale_id
            JOIN customer_orders co ON co.id = cob.order_id
            WHERE co.company_id = ${companyId}
              AND co.status = 'LOADING'
              AND co.proforma_id_used IS NOT NULL
              AND fb.erp_location_id = ${locationId}
            GROUP BY fb.article_code`
      );
      const loadingMap = new Map<string, number>(
        resultRows<{ articleCode: string; count: number }>(loadingRaw).map((r) => [r.articleCode, Number(r.count)])
      );

      // 4. Resolve product names + weight_per_bale_kg (bidirectional code/articleCode lookup)
      const allCodes = new Set([...inStockMap.keys(), ...reservedMap.keys(), ...loadingMap.keys()]);
      const productNameMap = new Map<string, string>();
      const weightMap = new Map<string, number>();
      if (allCodes.size > 0) {
        const codeArrArr = Array.from(allCodes);
        const codeArr2 = sqlArray(codeArrArr);
        const nameRaw = await db.execute(
          sql`SELECT DISTINCT ON (matched_code) matched_code AS "articleCode", name, weight_per_bale_kg AS "weightPerBaleKg" FROM (
                SELECT name, weight_per_bale_kg,
                  CASE WHEN code        = ANY(${codeArr2}) THEN code
                       WHEN article_code = ANY(${codeArr2}) THEN article_code
                  END AS matched_code
                FROM factory_bale_products
                WHERE company_id = ${companyId}
                  AND (code = ANY(${codeArr2}) OR article_code = ANY(${codeArr2}))
              ) sub
              WHERE matched_code IS NOT NULL
              ORDER BY matched_code`
        );
        resultRows<{ articleCode: string | null; name: string | null; weightPerBaleKg: string | null }>(
          nameRaw
        ).forEach((r) => {
          if (r.name && r.articleCode) productNameMap.set(r.articleCode, r.name);
          if (r.weightPerBaleKg != null && r.articleCode) weightMap.set(r.articleCode, parseFloat(r.weightPerBaleKg));
        });
      }

      // 5. Build per-article rows; exclude rows with all zeros
      const rows = Array.from(allCodes)
        .sort()
        .map((articleCode) => {
          const inStock = inStockMap.get(articleCode) ?? 0;
          const reservedExpected = reservedMap.get(articleCode) ?? 0;
          const loading = loadingMap.get(articleCode) ?? 0;
          const availableBalance = inStock - reservedExpected - loading;
          const weightPerBaleKg = weightMap.get(articleCode) ?? 0;
          return {
            articleCode,
            productName: productNameMap.get(articleCode) ?? articleCode,
            inStock,
            reservedExpected,
            loading,
            availableBalance,
            weightPerBaleKg,
          };
        })
        .filter((r) => r.inStock > 0 || r.reservedExpected > 0 || r.loading > 0);

      res.json({
        rows,
        shortageCount: rows.filter((r) => r.availableBalance < 0).length,
      });
    } catch (err: unknown) {
      logger.error("[V5] location-summary error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
