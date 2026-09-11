import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { customerProformas, customerProformaLines, customers } from "@shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { syncProformaReservations } from "./_stockReservationHelper";
import { sqlArray } from "../../lib/sqlArray";
import { resultRows } from "../../lib/queryResult";

/** `article_code` plus a count, as the stock aggregation queries return it. */
type ArticleCountRow = { articleCode: string; count: number };
/** Reserved-but-not-yet-loaded totals per article. */
type ArticleReservationRow = { articleCode: string; reservedNotYetLoaded: number };
/** A resolved product display name for an article code. */
type ProductNameRow = { articleCode: string; name: string | null };
/** A proforma line as this route reads it. */
type ProformaLineRow = {
  id: number;
  proformaId: number;
  articleCode: string;
  productName: string;
  quantity: number;
};
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

async function computeStockTruth(companyId: number) {
  // ── Bale statuses are physical reality ──────────────────────────────────────
  // IN_STOCK = free bales, not assigned to any order
  const inStockRaw = await db.execute(
    sql`SELECT article_code AS "articleCode", COUNT(*)::int AS count
        FROM factory_bales
        WHERE company_id = ${companyId} AND status = 'IN_STOCK'
        GROUP BY article_code`
  );
  const inStockMap = new Map<string, number>(
    resultRows<ArticleCountRow>(inStockRaw).map((r) => [r.articleCode, Number(r.count)])
  );

  // RESERVED_FOR_ORDER = bales physically picked into an active loading order
  const inLoadingRaw = await db.execute(
    sql`SELECT fb.article_code AS "articleCode", COUNT(*)::int AS count
        FROM customer_order_bales cob
        JOIN factory_bales fb   ON fb.id  = cob.bale_id
        JOIN customer_orders co ON co.id  = cob.order_id
        WHERE co.company_id = ${companyId}
          AND co.status IN ('LOADING', 'PENDING_VERIFICATION')
        GROUP BY fb.article_code`
  );
  const inLoadingMap = new Map<string, number>(
    resultRows<ArticleCountRow>(inLoadingRaw).map((r) => [r.articleCode, Number(r.count)])
  );

  // ── proformaStockReservations is the backend SOT for reservedNotYetLoaded ──
  // Maintained by syncProformaReservations() after every proforma/line/loading mutation.
  // reservedQty = max(0, proformaLineQty - alreadyLoadedInActiveOrders) per proforma+article.
  // We SUM across all proformas to get the per-article total.
  const reservedRaw = await db.execute(
    sql`SELECT article_code AS "articleCode", SUM(reserved_qty)::int AS "reservedNotYetLoaded"
        FROM proforma_stock_reservations
        WHERE company_id = ${companyId}
        GROUP BY article_code`
  );
  const reservedNotYetLoadedMap = new Map<string, number>(
    resultRows<ArticleReservationRow>(reservedRaw).map((r) => [r.articleCode, Number(r.reservedNotYetLoaded)])
  );

  // Union all known article codes from all three sources
  const allCodes = new Set([...inStockMap.keys(), ...inLoadingMap.keys(), ...reservedNotYetLoadedMap.keys()]);

  return Array.from(allCodes).map((code) => {
    const inStock = inStockMap.get(code) ?? 0;
    const inLoading = inLoadingMap.get(code) ?? 0;
    const onHand = inStock + inLoading;
    // reservedNotYetLoaded comes from the synced table (SOT)
    const reservedNotYetLoaded = reservedNotYetLoadedMap.get(code) ?? 0;
    // reservedNotYetLoaded is already net of every linked order contribution.
    // Do not subtract inLoading a second time; that made free stock look larger
    // than it really was whenever a loading was in progress.
    const proformaReserved = reservedNotYetLoaded + inLoading;
    const freeToPromise = Math.max(0, inStock - reservedNotYetLoaded);
    return { code, inStock, inLoading, onHand, proformaReserved, reservedNotYetLoaded, freeToPromise };
  });
}

// ─────────────────────────────────────────────────────────────────────────────

export function registerFactoryStockAllocationV2Routes(app: Express) {
  // Phase 4: single backend endpoint returns computed stock truth per article.
  // Phase 5: frontend renders these values directly — no availability math on client.
  app.get("/api/factory/v2/stock-allocation", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Bootstrap / reconcile: sync all active proformas so the reservations table is current.
      // This is lightweight when already in sync (one UPDATE per proforma at most).
      // Runs on every proforma-mode page load — safe because this view is not auto-refreshed.
      const activeProformaIds = await db.execute(
        sql`SELECT id FROM customer_proformas WHERE company_id = ${companyId} AND is_active = true`
      );
      const idsToSync: number[] = activeProformaIds.rows.map((r) => Number(r.id));
      for (const pid of idsToSync) {
        await syncProformaReservations(db, companyId, pid);
      }

      const stockTruth = await computeStockTruth(companyId);

      // Fetch inactive product article codes so we can exclude them from the view
      const inactiveProductsRaw = await db.execute(
        sql`SELECT code, article_code FROM factory_bale_products
            WHERE company_id = ${companyId} AND active = false`
      );
      const inactiveArticleCodes = new Set<string>(
        resultRows(inactiveProductsRaw).flatMap((r) => {
          const vals: string[] = [];
          if (r.code) vals.push(r.code as string);
          if (r.article_code) vals.push(r.article_code as string);
          return vals;
        })
      );
      // Keep ALL stock-truth entries so inactive products with remaining bales still appear.
      // We tag each entry with isActive so the frontend can apply display rules.
      const activeStockTruth = stockTruth;

      // All proformas with lines
      const allProformas = await db
        .select({
          id: customerProformas.id,
          customerId: customerProformas.customerId,
          name: customerProformas.name,
          isActive: customerProformas.isActive,
          createdAt: customerProformas.createdAt,
        })
        .from(customerProformas)
        .where(eq(customerProformas.companyId, companyId))
        .orderBy(customerProformas.createdAt);

      const proformaIds = allProformas.map((p) => p.id);
      let allLines: ProformaLineRow[] = [];
      if (proformaIds.length > 0) {
        allLines = await db
          .select({
            id: customerProformaLines.id,
            proformaId: customerProformaLines.proformaId,
            articleCode: customerProformaLines.articleCode,
            productName: customerProformaLines.productName,
            quantity: customerProformaLines.quantity,
          })
          .from(customerProformaLines)
          .where(inArray(customerProformaLines.proformaId, proformaIds));
      }

      // Phase 3: per-proforma loaded quantities from active orders
      // This shows how much of each proforma reservation has been consumed by loading.
      const loadedByProformaRaw = await db.execute(
        sql`SELECT co.proforma_id_used as "proformaId",
                   fb.article_code as "articleCode",
                   COUNT(*)::int as loaded
            FROM customer_order_bales cob
            JOIN factory_bales fb ON fb.id = cob.bale_id
            JOIN customer_orders co ON co.id = cob.order_id
            WHERE co.company_id = ${companyId}
              AND co.status IN ('LOADING', 'PENDING_VERIFICATION')
              AND co.proforma_id_used IS NOT NULL
            GROUP BY co.proforma_id_used, fb.article_code`
      );
      type LoadedEntry = { proformaId: number; articleCode: string; loaded: number };
      const loadedByProforma: LoadedEntry[] = resultRows<LoadedEntry>(loadedByProformaRaw).map((r) => ({
        proformaId: Number(r.proformaId),
        articleCode: r.articleCode,
        loaded: Number(r.loaded),
      }));

      // Customer names
      const customerIds = [...new Set(allProformas.map((p) => p.customerId))].filter((id): id is number => id != null);
      const customerMap = new Map<number, string>();
      if (customerIds.length > 0) {
        const rows = await db
          .select({ id: customers.id, legalName: customers.legalName })
          .from(customers)
          .where(inArray(customers.id, customerIds));
        rows.forEach((c) => customerMap.set(c.id, c.legalName));
      }

      // Filter proforma lines that reference inactive products
      const activeLines = allLines.filter((l) => !inactiveArticleCodes.has(l.articleCode));

      // Product names
      const allCodes = [...new Set([...activeStockTruth.map((t) => t.code), ...activeLines.map((l) => l.articleCode)])];
      const productNamesMap: Record<string, string> = {};
      if (allCodes.length > 0) {
        const prodRaw = await db.execute(
          sql`SELECT DISTINCT ON (matched_code) matched_code as "articleCode", name FROM (
                SELECT name,
                  CASE WHEN code = ANY(${sqlArray(allCodes)}) THEN code
                       WHEN article_code = ANY(${sqlArray(allCodes)}) THEN article_code
                  END as matched_code
                FROM factory_bale_products
                WHERE company_id = ${companyId}
                  AND (code = ANY(${sqlArray(allCodes)}) OR article_code = ANY(${sqlArray(allCodes)}))
              ) sub
              WHERE matched_code IS NOT NULL
              ORDER BY matched_code`
        );
        resultRows<ProductNameRow>(prodRaw).forEach((r) => {
          if (r.name) productNamesMap[r.articleCode] = r.name;
        });
      }

      res.json({
        // Backend-computed stock truth — one source of reality, never re-derived on frontend
        stockTruth: activeStockTruth.map((t) => ({
          articleCode: t.code,
          isActive: !inactiveArticleCodes.has(t.code),
          onHand: t.onHand,
          inStock: t.inStock,
          inLoading: t.inLoading,
          proformaReserved: t.proformaReserved,
          reservedNotYetLoaded: t.reservedNotYetLoaded,
          freeToPromise: t.freeToPromise,
        })),
        proformas: allProformas.map((p) => ({
          id: p.id,
          customerId: p.customerId,
          customerName: customerMap.get(p.customerId) || `Customer #${p.customerId}`,
          name: p.name,
          isActive: p.isActive,
          createdAt: p.createdAt,
          lines: activeLines
            .filter((l) => l.proformaId === p.id)
            .map((l) => {
              const loaded =
                loadedByProforma.find((lb) => lb.proformaId === p.id && lb.articleCode === l.articleCode)?.loaded || 0;
              return {
                id: l.id,
                articleCode: l.articleCode,
                productName: l.productName,
                quantity: Number(l.quantity),
                alreadyLoaded: loaded,
                remainingToLoad: Math.max(0, Number(l.quantity) - loaded),
              };
            }),
        })),
        productNames: productNamesMap,
      });
    } catch (error: unknown) {
      logger.error("[V2] stock-allocation error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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
