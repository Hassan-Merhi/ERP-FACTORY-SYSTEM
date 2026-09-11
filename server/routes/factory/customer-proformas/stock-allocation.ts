/**
 * factoryCustomerProformaRoutes: FactoryStockAllocation endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { sqlArray } from "../../../lib/sqlArray";
import { resultRows } from "../../../lib/queryResult";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerProformas, customerProformaLines, customers, proformaStockReservations } from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";

export function registerFactoryStockAllocationRoutes(app: Express) {
  // ─── Stock Allocation endpoints ─────────────────────────────────────────────

  // GET /api/factory/stock-allocation — returns all article codes with IN_STOCK bale counts,
  // all proformas with their lines, existing reservations, and LOADING/PENDING_VERIFICATION/VERIFIED order quantities
  app.get("/api/factory/stock-allocation", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // 1. All proformas for this company
      const allProformas = await db
        .select({
          id: customerProformas.id,
          companyId: customerProformas.companyId,
          customerId: customerProformas.customerId,
          name: customerProformas.name,
          isActive: customerProformas.isActive,
          createdAt: customerProformas.createdAt,
        })
        .from(customerProformas)
        .where(eq(customerProformas.companyId, companyId))
        .orderBy(customerProformas.createdAt);

      const proformaIds = allProformas.map((p) => p.id);
      let allLines: any[] = [];
      if (proformaIds.length > 0) {
        allLines = await db
          .select({
            id: customerProformaLines.id,
            proformaId: customerProformaLines.proformaId,
            articleCode: customerProformaLines.articleCode,
            productName: customerProformaLines.productName,
            quantity: customerProformaLines.quantity,
            pricePerBale: customerProformaLines.pricePerBale,
          })
          .from(customerProformaLines)
          .where(inArray(customerProformaLines.proformaId, proformaIds));
      }

      // 2. IN_STOCK bale counts grouped by articleCode
      const inStockCountsRaw = await db.execute(
        sql`SELECT article_code as "articleCode", COUNT(*)::int as count FROM factory_bales WHERE company_id = ${companyId} AND status = 'IN_STOCK' GROUP BY article_code`
      );
      const inStockCounts = resultRows<{ articleCode: string; count: number }>(inStockCountsRaw).map((r) => ({
        articleCode: r.articleCode,
        count: Number(r.count),
      }));

      // 3. Existing reservations for this company
      const reservations = await db
        .select({
          id: proformaStockReservations.id,
          companyId: proformaStockReservations.companyId,
          proformaId: proformaStockReservations.proformaId,
          articleCode: proformaStockReservations.articleCode,
        })
        .from(proformaStockReservations)
        .where(eq(proformaStockReservations.companyId, companyId));

      // 4. Active orders (LOADING, PENDING_VERIFICATION, VERIFIED)
      const activeOrdersRaw = await db.execute(
        sql`SELECT id, proforma_id_used as "proformaIdUsed", status FROM customer_orders WHERE company_id = ${companyId} AND status IN ('LOADING','PENDING_VERIFICATION','VERIFIED')`
      );
      const activeOrders = resultRows<{ id: number; proformaIdUsed: number | null; status: string }>(
        activeOrdersRaw
      ).map((o) => ({
        id: o.id,
        proformaIdUsed: o.proformaIdUsed,
        status: o.status,
      }));

      // For active orders, get bale article code counts from customer_order_bales
      let activeOrderBales: { orderId: number; articleCode: string; count: number }[] = [];
      if (activeOrders.length > 0) {
        const orderIds = activeOrders.map((o) => o.id);
        const activeOrderBalesRaw = await db.execute(
          sql`SELECT order_id as "orderId", article_code as "articleCode", COUNT(*)::int as count FROM customer_order_bales WHERE order_id = ANY(${sqlArray(orderIds)}) GROUP BY order_id, article_code`
        );
        activeOrderBales = resultRows<{ orderId: number; articleCode: string; count: number }>(activeOrderBalesRaw).map(
          (b) => ({
            orderId: b.orderId,
            articleCode: b.articleCode,
            count: Number(b.count),
          })
        );
      }

      // 5. Customers lookup — use legalName (the customers table has no "name" column)
      const allCustomerIds = [...new Set(allProformas.map((p) => p.customerId))].filter(
        (id): id is number => id != null && !isNaN(Number(id))
      );
      let customerRows: any[] = [];
      if (allCustomerIds.length > 0) {
        customerRows = await db
          .select({ id: customers.id, legalName: customers.legalName })
          .from(customers)
          .where(inArray(customers.id, allCustomerIds));
      }
      const customerMap = new Map(customerRows.map((c) => [c.id, c.legalName]));

      // 6. Product names for all in-stock article codes (fills in names for codes not in any proforma)
      const allArticleCodes = [
        ...new Set([...inStockCounts.map((s) => s.articleCode), ...allLines.map((l) => l.articleCode)]),
      ];
      const productNamesMap: Record<string, string> = {};
      if (allArticleCodes.length > 0) {
        const prodRaw = await db.execute(
          sql`SELECT DISTINCT ON (article_code) article_code as "articleCode", name
              FROM factory_bale_products
              WHERE company_id = ${companyId}
                AND article_code = ANY(${sqlArray(allArticleCodes)})
              ORDER BY article_code`
        );
        resultRows<{ articleCode: string | null; name: string | null }>(prodRaw).forEach((r) => {
          if (r.name && r.articleCode) productNamesMap[r.articleCode] = r.name;
        });
      }

      res.json({
        proformas: allProformas.map((p) => ({
          id: p.id,
          companyId: p.companyId,
          customerId: p.customerId,
          name: p.name,
          isActive: p.isActive,
          createdAt: p.createdAt,
          customerName: customerMap.get(p.customerId) || `Customer #${p.customerId}`,
          lines: allLines.filter((l) => l.proformaId === p.id),
        })),
        inStockCounts,
        productNames: productNamesMap,
        reservations,
        activeOrders: activeOrders.map((o) => ({
          id: o.id,
          proformaIdUsed: o.proformaIdUsed,
          status: o.status,
          balesByArticle: activeOrderBales
            .filter((b) => b.orderId === o.id)
            .map((b) => ({ articleCode: b.articleCode, count: b.count })),
        })),
      });
    } catch (error: unknown) {
      logger.error("Error fetching stock allocation:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/stock-allocation/loading-mode — returns active loadings with per-article bale counts
  app.get("/api/factory/stock-allocation/loading-mode", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // 1. Free bale counts (truly available, not assigned to any order)
      const freeStockRaw = await db.execute(
        sql`SELECT article_code as "articleCode", COUNT(*)::int as count
            FROM factory_bales
            WHERE company_id = ${companyId} AND status = 'IN_STOCK'
            GROUP BY article_code`
      );
      const freeStockCounts: { articleCode: string; count: number }[] = resultRows<{
        articleCode: string;
        count: number;
      }>(freeStockRaw).map((r) => ({
        articleCode: r.articleCode,
        count: Number(r.count),
      }));
      const freeStockMap = new Map(freeStockCounts.map((s) => [s.articleCode, s.count]));

      // 2. Active loadings (LOADING + PENDING_VERIFICATION)
      const loadingsRaw = await db.execute(
        sql`SELECT id, customer_id as "customerId", container_number as "containerNumber", status,
                   proforma_id_used as "proformaIdUsed"
            FROM customer_orders
            WHERE company_id = ${companyId} AND status IN ('LOADING','PENDING_VERIFICATION')
            ORDER BY id`
      );
      const loadings: {
        id: number;
        customerId: number;
        containerNumber: string | null;
        status: string;
        proformaIdUsed: number | null;
      }[] = resultRows<{
        id: number;
        customerId: number;
        containerNumber: string | null;
        status: string;
        proformaIdUsed: number | null;
      }>(loadingsRaw).map((r) => ({
        id: r.id,
        customerId: r.customerId,
        containerNumber: r.containerNumber || null,
        status: r.status,
        proformaIdUsed: r.proformaIdUsed || null,
      }));

      // 3. Bale counts per loading per article code
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

      // 3b. Proforma target quantities for each loading (via proformaIdUsed)
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

      // 4. Customer names
      const customerIds = [...new Set(loadings.map((l) => l.customerId))].filter((id): id is number => id != null);
      const customerMap = new Map<number, string>();
      if (customerIds.length > 0) {
        const custRows = await db
          .select({ id: customers.id, legalName: customers.legalName })
          .from(customers)
          .where(inArray(customers.id, customerIds));
        custRows.forEach((c) => customerMap.set(c.id, c.legalName));
      }

      // 5. Build total stock counts = free IN_STOCK + reserved in active loadings per article
      const totalStockMap = new Map<string, number>(freeStockMap);
      for (const b of loadingBales) {
        totalStockMap.set(b.articleCode, (totalStockMap.get(b.articleCode) || 0) + b.count);
      }
      const totalStockCounts = Array.from(totalStockMap.entries()).map(([articleCode, count]) => ({
        articleCode,
        count,
      }));

      // 6. Product name lookup from factory_bale_products
      //    Include all article codes: free stock, scanned bales, AND proforma targets.
      //    Filter by company_id to prevent name bleed-in from other companies.
      const articleCodeSet = new Set<string>([
        ...freeStockCounts.map((s) => s.articleCode),
        ...loadingBales.map((b) => b.articleCode),
        ...proformaLines.map((pl) => pl.articleCode),
      ]);
      const productNameByCode = new Map<string, string>();
      if (articleCodeSet.size > 0) {
        const codes = Array.from(articleCodeSet);
        const prodRaw = await db.execute(
          sql`SELECT DISTINCT ON (fbp.article_code) fbp.article_code as "articleCode", fbp.name
              FROM factory_bale_products fbp
              WHERE fbp.company_id = ${companyId}
                AND fbp.article_code = ANY(${sqlArray(codes)})
              ORDER BY fbp.article_code`
        );
        resultRows<{ articleCode: string | null; name: string | null }>(prodRaw).forEach((r) => {
          if (r.name && r.articleCode) productNameByCode.set(r.articleCode, r.name);
        });
      }

      res.json({
        // totalStockCounts: free IN_STOCK + reserved-in-loading — shown in "In Stock" column
        inStockCounts: totalStockCounts,
        // freeStockCounts: truly free bales — used to compute Remaining on the frontend
        freeStockCounts: freeStockCounts,
        loadings: loadings.map((l) => ({
          id: l.id,
          customerId: l.customerId,
          customerName: customerMap.get(l.customerId) || `Customer #${l.customerId}`,
          containerNumber: l.containerNumber,
          status: l.status,
          // balesByArticle: actual bales already scanned into this order
          balesByArticle: loadingBales
            .filter((b) => b.orderId === l.id)
            .map((b) => ({ articleCode: b.articleCode, count: b.count })),
          // proformaTargets: proforma line quantities (the target to load)
          proformaTargets: l.proformaIdUsed
            ? proformaLines
                .filter((pl) => pl.proformaId === l.proformaIdUsed)
                .map((pl) => ({ articleCode: pl.articleCode, quantity: pl.quantity }))
            : [],
        })),
        productNames: Object.fromEntries(productNameByCode),
      });
    } catch (error: unknown) {
      logger.error("Error fetching loading-mode stock allocation:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/factory/stock-allocation/reservations/toggle — toggle a reservation on/off
  app.post("/api/factory/stock-allocation/reservations/toggle", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { proformaId, articleCode } = req.body;
      if (!proformaId || !articleCode) return res.status(400).json({ message: "proformaId and articleCode required" });

      // Check if reservation exists
      const [existing] = await db
        .select()
        .from(proformaStockReservations)
        .where(
          and(
            eq(proformaStockReservations.companyId, companyId),
            eq(proformaStockReservations.proformaId, proformaId),
            eq(proformaStockReservations.articleCode, articleCode)
          )
        )
        .limit(1);

      if (existing) {
        await db.delete(proformaStockReservations).where(eq(proformaStockReservations.id, existing.id));
        res.json({ reserved: false });
      } else {
        await db.insert(proformaStockReservations).values({ companyId, proformaId, articleCode });
        res.json({ reserved: true });
      }
    } catch (error: unknown) {
      logger.error("Error toggling reservation:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── End Stock Allocation ─────────────────────────────────────────────────────
}
