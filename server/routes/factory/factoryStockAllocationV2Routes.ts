import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { customerProformaLines, customers } from "@shared/schema";
import { inArray, sql } from "drizzle-orm";
import { sqlArray } from "../../lib/sqlArray";
import { resultRows } from "../../lib/queryResult";
import {
  registerFactoryStockAllocationV2RoutesPart1,
  type ArticleCountRow,
  type ProductNameRow,
} from "./registerFactoryStockAllocationV2RoutesPart1";

/** An active loading order row. */
type LoadingOrderRow = {
  id: number;
  customerId: number;
  containerNumber: string | null;
  status: string;
  proformaIdUsed: number | null;
};

// ─── Backend stock-truth helper ───────────────────────────────────────────────
// Phases 1–4: compute per-article inventory state entirely on the backend.
// The frontend must NEVER recompute availability from visible columns.
//
// State model:
//   IN_STOCK             = free bales, not committed to any order
//   RESERVED_FOR_ORDER   = bales physically in an active loading order
//   (SHIPPED / others)   = finalized — out of the pool
//
// Derived values:
//   onHand               = IN_STOCK + RESERVED_FOR_ORDER  (physical pool)
//   inLoading            = bales in LOADING / PENDING_VERIFICATION orders
//   proformaReserved     = sum of all ACTIVE proforma lines (backend truth)
//   reservedNotYetLoaded = max(0, proformaReserved − inLoading)
//   freeToPromise        = max(0, IN_STOCK − reservedNotYetLoaded)
//
// Loading does NOT create a second stock deduction — it transitions bales from
// the "free" pool (IN_STOCK) into the "committed" pool (RESERVED_FOR_ORDER),
// so onHand stays the same.  The final shipment is the definitive stock-out event.

// ─────────────────────────────────────────────────────────────────────────────

export function registerFactoryStockAllocationV2Routes(app: Express) {
  registerFactoryStockAllocationV2RoutesPart1(app);

  // Loading-mode: same data structure as v1 but sourced cleanly from backend truth
  app.get("/api/factory/v2/stock-allocation/loading-mode", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const freeStockRaw = await db.execute(
        sql`SELECT article_code as "articleCode", COUNT(*)::int as count
            FROM factory_bales
            WHERE company_id = ${companyId} AND status = 'IN_STOCK'
            GROUP BY article_code`
      );
      const freeStockCounts: { articleCode: string; count: number }[] = resultRows<ArticleCountRow>(freeStockRaw).map(
        (r) => ({
          articleCode: r.articleCode,
          count: Number(r.count),
        })
      );
      const freeStockMap = new Map(freeStockCounts.map((s) => [s.articleCode, s.count]));

      const loadingsRaw = await db.execute(
        sql`SELECT id, customer_id as "customerId", container_number as "containerNumber",
                   status, proforma_id_used as "proformaIdUsed"
            FROM customer_orders
            WHERE company_id = ${companyId} AND status IN ('LOADING','PENDING_VERIFICATION')
            ORDER BY id`
      );
      const loadings: LoadingOrderRow[] = resultRows<LoadingOrderRow>(loadingsRaw).map((r) => ({
        id: r.id,
        customerId: r.customerId,
        containerNumber: r.containerNumber || null,
        status: r.status,
        proformaIdUsed: r.proformaIdUsed || null,
      }));

      let loadingBales: { orderId: number; articleCode: string; count: number }[] = [];
      if (loadings.length > 0) {
        const ids = loadings.map((l) => l.id);
        const balesRaw = await db.execute(
          sql`SELECT cob.order_id as "orderId", fb.article_code as "articleCode", COUNT(*)::int as count
              FROM customer_order_bales cob
              JOIN factory_bales fb ON fb.id = cob.bale_id
              WHERE cob.order_id = ANY(${sqlArray(ids)})
              GROUP BY cob.order_id, fb.article_code`
        );
        loadingBales = resultRows<{ orderId: number; articleCode: string; count: number }>(balesRaw).map((r) => ({
          orderId: r.orderId,
          articleCode: r.articleCode,
          count: Number(r.count),
        }));
      }

      const proformaIds = [...new Set(loadings.map((l) => l.proformaIdUsed))].filter((id): id is number => id != null);
      let proformaLines: { proformaId: number; articleCode: string; quantity: number }[] = [];
      if (proformaIds.length > 0) {
        const plRaw = await db
          .select({
            proformaId: customerProformaLines.proformaId,
            articleCode: customerProformaLines.articleCode,
            quantity: customerProformaLines.quantity,
          })
          .from(customerProformaLines)
          .where(inArray(customerProformaLines.proformaId, proformaIds));
        proformaLines = plRaw.map((r) => ({
          proformaId: r.proformaId,
          articleCode: r.articleCode,
          quantity: Number(r.quantity),
        }));
      }

      const customerIds = [...new Set(loadings.map((l) => l.customerId))].filter((id): id is number => id != null);
      const customerMap = new Map<number, string>();
      if (customerIds.length > 0) {
        const rows = await db
          .select({ id: customers.id, legalName: customers.legalName })
          .from(customers)
          .where(inArray(customers.id, customerIds));
        rows.forEach((c) => customerMap.set(c.id, c.legalName));
      }

      const totalStockMap = new Map(freeStockMap);
      for (const b of loadingBales) {
        totalStockMap.set(b.articleCode, (totalStockMap.get(b.articleCode) || 0) + b.count);
      }

      // Exclude inactive products (match by both code and article_code)
      const inactiveRaw2 = await db.execute(
        sql`SELECT code, article_code FROM factory_bale_products
            WHERE company_id = ${companyId} AND active = false`
      );
      const inactiveCodes2 = new Set<string>(
        inactiveRaw2.rows.flatMap((r) => {
          const vals: string[] = [];
          if (r.code) vals.push(r.code as string);
          if (r.article_code) vals.push(r.article_code as string);
          return vals;
        })
      );

      const articleCodeSet = new Set<string>([
        ...freeStockCounts.map((s) => s.articleCode).filter((c) => !inactiveCodes2.has(c)),
        ...loadingBales.map((b) => b.articleCode).filter((c) => !inactiveCodes2.has(c)),
        ...proformaLines.map((pl) => pl.articleCode).filter((c) => !inactiveCodes2.has(c)),
      ]);
      const productNameByCode = new Map<string, string>();
      if (articleCodeSet.size > 0) {
        const codes = Array.from(articleCodeSet);
        const prodRaw = await db.execute(
          sql`SELECT DISTINCT ON (matched_code) matched_code as "articleCode", name FROM (
                SELECT name,
                  CASE WHEN code = ANY(${sqlArray(codes)}) THEN code
                       WHEN article_code = ANY(${sqlArray(codes)}) THEN article_code
                  END as matched_code
                FROM factory_bale_products
                WHERE company_id = ${companyId}
                  AND (code = ANY(${sqlArray(codes)}) OR article_code = ANY(${sqlArray(codes)}))
              ) sub
              WHERE matched_code IS NOT NULL
              ORDER BY matched_code`
        );
        resultRows<ProductNameRow>(prodRaw).forEach((r) => {
          if (r.name) productNameByCode.set(r.articleCode, r.name);
        });
      }

      res.json({
        inStockCounts: Array.from(totalStockMap.entries()).map(([articleCode, count]) => ({ articleCode, count })),
        freeStockCounts,
        loadings: loadings.map((l) => ({
          id: l.id,
          customerId: l.customerId,
          customerName: customerMap.get(l.customerId) || `Customer #${l.customerId}`,
          containerNumber: l.containerNumber,
          status: l.status,
          balesByArticle: loadingBales
            .filter((b) => b.orderId === l.id)
            .map((b) => ({ articleCode: b.articleCode, count: b.count })),
          proformaTargets: l.proformaIdUsed
            ? proformaLines
                .filter((pl) => pl.proformaId === l.proformaIdUsed)
                .map((pl) => ({ articleCode: pl.articleCode, quantity: pl.quantity }))
            : [],
        })),
        productNames: Object.fromEntries(productNameByCode),
      });
    } catch (error: unknown) {
      logger.error("[V2] loading-mode error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
