/**
 * factoryStockAllocationV5Routes: V5StockAllocation endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db, pool } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerProformas, customerProformaLines, customers } from "@shared/schema";
import { eq, inArray, sql, and, gte, lte } from "drizzle-orm";
import { sqlArray } from "../../../lib/sqlArray";

import { ACTIVE_ORDER_STATUSES } from "./_helpers";
import { resultRows } from "../../../lib/queryResult";

export function registerV5StockAllocationRoutes(app: Express) {
  // ── GET /api/factory/v5/stock-allocation ────────────────────────────────
  app.get("/api/factory/v5/stock-allocation", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const {
        productFilter,
        customerFilter,
        proformaFilter,
        containerFilter,
        statusFilter,
        fromDate,
        toDate,
        hideZero,
        search,
        page: pageQ,
        limit: limitQ,
      } = req.query;

      // 0. Build set of excluded article codes — products whose category OR name is Wiper/Garbage/Rag
      // pool.query (not db.execute) — Drizzle's db.execute crashes on multi-join raw SQL.
      const excludedCodesRaw = await pool.query(
        `SELECT COALESCE(fbp.article_code, fbp.code) AS "articleCode"
         FROM factory_bale_products fbp
         LEFT JOIN factory_categories fc ON fc.id = fbp.category_id
         WHERE fbp.company_id = $1
           AND (
             LOWER(fc.name) LIKE '%wiper%'
             OR LOWER(fc.name) LIKE '%garbage%'
             OR LOWER(fc.name) LIKE '%rag%'
             OR LOWER(fbp.name) LIKE '%wiper%'
             OR LOWER(fbp.name) LIKE '%garbage%'
           )`,
        [companyId]
      );
      const excludedCodes = new Set<string>(
        resultRows<{ articleCode: string | null }>(excludedCodesRaw)
          .map((r) => r.articleCode)
          .filter((c): c is string => Boolean(c))
      );

      // 1. stockAvailable — IN_STOCK bales
      const inStockRaw = await db.execute(
        sql`SELECT article_code AS "articleCode", COUNT(*)::int AS count
            FROM factory_bales
            WHERE company_id = ${companyId} AND status = 'IN_STOCK'
            GROUP BY article_code`
      );
      const inStockMap = new Map<string, number>(
        resultRows<{ articleCode: string; count: number }>(inStockRaw).map((r) => [r.articleCode, Number(r.count)])
      );

      // 2. totalLoaded — bales physically scanned into LOADING orders ONLY.
      // Phase B change: Restricted to status='LOADING' so that PENDING_VERIFICATION/VERIFIED/FINALIZED
      // orders do not double-count bales that are already SOLD (post Phase C).
      // V5 guard: proformaIdUsed IS NOT NULL — only count V5 container orders.
      const inLoadingRaw = await db.execute(
        sql`SELECT fb.article_code AS "articleCode", COUNT(*)::int AS count
            FROM customer_order_bales cob
            JOIN factory_bales fb   ON fb.id  = cob.bale_id
            JOIN customer_orders co ON co.id  = cob.order_id
            WHERE co.company_id = ${companyId}
              AND co.status = 'LOADING'
              AND co.proforma_id_used IS NOT NULL
            GROUP BY fb.article_code`
      );
      const inLoadingMap = new Map<string, number>(
        resultRows<{ articleCode: string; count: number }>(inLoadingRaw).map((r) => [r.articleCode, Number(r.count)])
      );

      // 3. Active proformas + lines (with optional date range filter on createdAt)
      const proformaConditions = [eq(customerProformas.companyId, companyId), eq(customerProformas.isActive, true)];

      if (fromDate) {
        const from = new Date(String(fromDate));
        if (!isNaN(from.getTime())) {
          proformaConditions.push(gte(customerProformas.createdAt, from));
        }
      }
      if (toDate) {
        const to = new Date(String(toDate));
        if (!isNaN(to.getTime())) {
          to.setHours(23, 59, 59, 999);
          proformaConditions.push(lte(customerProformas.createdAt, to));
        }
      }

      const activeProformasRaw = await db
        .select({
          id: customerProformas.id,
          customerId: customerProformas.customerId,
          name: customerProformas.name,
          isActive: customerProformas.isActive,
          createdAt: customerProformas.createdAt,
        })
        .from(customerProformas)
        .where(and(...proformaConditions));

      const proformaIds = activeProformasRaw.map((p) => p.id);

      let allLines: { id: number; proformaId: number; articleCode: string; productName: string; quantity: number }[] =
        [];
      if (proformaIds.length > 0) {
        allLines = (
          await db
            .select({
              id: customerProformaLines.id,
              proformaId: customerProformaLines.proformaId,
              articleCode: customerProformaLines.articleCode,
              productName: customerProformaLines.productName,
              quantity: customerProformaLines.quantity,
            })
            .from(customerProformaLines)
            .where(inArray(customerProformaLines.proformaId, proformaIds))
        ).map((l) => ({ ...l, quantity: Number(l.quantity) }));
      }

      // 4. Active orders per proforma (ACTIVE_ORDER_STATUSES, excludes CANCELLED)
      type OrderRow = {
        id: number;
        proformaId: number;
        containerNumber: string | null;
        status: string;
        customerId: number;
      };
      let ordersByProforma: OrderRow[] = [];
      if (proformaIds.length > 0) {
        const ordersRaw = await db.execute(
          sql`SELECT id, proforma_id_used AS "proformaId", container_number AS "containerNumber",
                     status, customer_id AS "customerId"
              FROM customer_orders
              WHERE company_id = ${companyId}
                AND proforma_id_used = ANY(${sqlArray(proformaIds)})
                AND status = ANY(${sqlArray(ACTIVE_ORDER_STATUSES as unknown as string[])})
              ORDER BY id`
        );
        ordersByProforma = resultRows<OrderRow>(ordersRaw).map((r) => ({
          id: Number(r.id),
          proformaId: Number(r.proformaId),
          containerNumber: r.containerNumber ?? null,
          status: r.status,
          customerId: Number(r.customerId),
        }));
      }

      // 5. Loaded bales per order — for expandable container detail
      type BalesByOrder = { orderId: number; articleCode: string; count: number };
      let loadedBalesByOrder: BalesByOrder[] = [];
      const allOrderIds = ordersByProforma.map((o) => o.id);
      if (allOrderIds.length > 0) {
        const balesRaw = await db.execute(
          sql`SELECT cob.order_id AS "orderId", fb.article_code AS "articleCode", COUNT(*)::int AS count
              FROM customer_order_bales cob
              JOIN factory_bales fb ON fb.id = cob.bale_id
              WHERE cob.order_id = ANY(${sqlArray(allOrderIds)})
              GROUP BY cob.order_id, fb.article_code`
        );
        loadedBalesByOrder = resultRows<BalesByOrder>(balesRaw).map((r) => ({
          orderId: Number(r.orderId),
          articleCode: r.articleCode,
          count: Number(r.count),
        }));
      }

      // 5b. Backfill: Insert expected lines for any V5 DRAFT or LOADING containers that were
      //     created before Phase B or linked via the link-proforma endpoint.
      //     Idempotent — NOT EXISTS guard prevents duplicates.
      //     V5 guard: proformaIdUsed IS NOT NULL
      //
      //     IMPORTANT: Extending to LOADING does NOT change the expectedToLoad formula.
      //     expectedToLoad still counts DRAFT orders only (see step 9 below).
      //     LOADING expected lines are for container detail/progress display only.
      if (proformaIds.length > 0) {
        try {
          await db.execute(
            // NOT EXISTS is the fast path — avoids any write when rows already exist.
            // ON CONFLICT DO NOTHING is the race-condition safety net for concurrent GETs
            // that both reach the backfill simultaneously before the first one commits.
            // Together these make the backfill fully idempotent with no duplicates.
            sql`INSERT INTO customer_order_expected_lines
                  (company_id, order_id, proforma_id, proforma_line_id, article_code, product_name, expected_qty)
                SELECT co.company_id, co.id, co.proforma_id_used, cpl.id,
                       cpl.article_code, cpl.product_name, cpl.quantity
                FROM customer_orders co
                JOIN customer_proforma_lines cpl ON cpl.proforma_id = co.proforma_id_used
                WHERE co.company_id = ${companyId}
                  AND co.status IN ('DRAFT', 'LOADING')
                  AND co.proforma_id_used IS NOT NULL
                  AND co.proforma_id_used = ANY(${sqlArray(proformaIds)})
                  AND NOT EXISTS (
                    SELECT 1 FROM customer_order_expected_lines cel
                    WHERE cel.order_id = co.id AND cel.article_code = cpl.article_code
                  )
                ON CONFLICT (order_id, article_code) DO NOTHING`
          );
        } catch (_backfillErr) {
          // Non-fatal: backfill failure must never block the GET response
        }
      }

      // 5c. Per-container expected quantities from customer_order_expected_lines.
      //     Covers all active (non-cancelled) orders so the expandable detail always shows
      //     the locked-in expected qty per container.
      //     V5 guard: proformaIdUsed IS NOT NULL (all allOrderIds are already V5 orders)
      type ExpectedLine = { orderId: number; articleCode: string; expectedQty: number };
      let allExpectedLines: ExpectedLine[] = [];
      if (allOrderIds.length > 0) {
        const expRaw = await db.execute(
          sql`SELECT order_id AS "orderId", article_code AS "articleCode",
                     expected_qty AS "expectedQty"
              FROM customer_order_expected_lines
              WHERE order_id = ANY(${sqlArray(allOrderIds)})`
        );
        allExpectedLines = resultRows<ExpectedLine>(expRaw).map((r) => ({
          orderId: Number(r.orderId),
          articleCode: r.articleCode,
          expectedQty: Number(r.expectedQty),
        }));
      }

      // Key: `${orderId}__${articleCode}` → expectedQty for per-container expandable detail
      const perContainerExpectedMap = new Map<string, number>();
      allExpectedLines.forEach((el) => {
        perContainerExpectedMap.set(`${el.orderId}__${el.articleCode}`, el.expectedQty);
      });

      // 6. Customer names
      const customerIds = [
        ...new Set([
          ...activeProformasRaw.map((p) => p.customerId).filter((id): id is number => id != null),
          ...ordersByProforma.map((o) => o.customerId),
        ]),
      ];
      const customerMap = new Map<number, string>();
      if (customerIds.length > 0) {
        const rows = await db
          .select({ id: customers.id, legalName: customers.legalName })
          .from(customers)
          .where(inArray(customers.id, customerIds));
        rows.forEach((c) => customerMap.set(c.id, c.legalName));
      }

      // 7. ALL active factory_bale_products — so users can allocate to zero-stock items
      //    Using both code and article_code columns to build a full code→name map + weight map
      // pool.query (not db.execute) — Drizzle's db.execute crashes on multi-join raw SQL.
      const allProductsRaw = await pool.query(
        `SELECT fbp.code, COALESCE(fbp.article_code, fbp.code) AS "articleCode", fbp.name,
                fbp.weight_per_bale_kg AS "weightKg",
                COALESCE(fc.name, '') AS "categoryName"
         FROM factory_bale_products fbp
         LEFT JOIN factory_categories fc ON fc.id = fbp.category_id
         WHERE fbp.company_id = $1 AND fbp.active = true
         ORDER BY fbp.name`,
        [companyId]
      );
      const allProductsMap = new Map<string, string>();
      const weightMap = new Map<string, number>();
      const categoryMap = new Map<string, string>();
      resultRows<{
        articleCode: string | null;
        name: string | null;
        weightKg: string | null;
        categoryName: string | null;
      }>(allProductsRaw).forEach((r) => {
        if (r.name && r.articleCode) {
          // Use only the canonical articleCode (COALESCE(article_code, code)) as the map key.
          // Adding the raw `code` separately would create phantom zero-stock rows for products
          // where code != article_code (e.g. legacy codes vs HMD article codes).
          // Bales stored under the raw `code` still get names via step 9a bidirectional lookup.
          allProductsMap.set(r.articleCode, r.name);
        }
        const w = r.weightKg ? parseFloat(r.weightKg) : 0;
        if (w > 0 && r.articleCode) {
          weightMap.set(r.articleCode, w);
        }
        if (r.categoryName && r.articleCode) {
          categoryMap.set(r.articleCode, r.categoryName);
        }
      });

      // 8. Build allCodes union (stock bales + loading bales + proforma lines + all active products)
      const allCodes = new Set([
        ...inStockMap.keys(),
        ...inLoadingMap.keys(),
        ...allLines.map((l) => l.articleCode),
        ...allProductsMap.keys(),
      ]);

      // 9a. Bidirectional name lookup — same technique as V2 — for any code that appears in the data
      //     Matches factory_bale_products by BOTH code and article_code columns
      const productNamesMap: Record<string, string> = {};
      if (allCodes.size > 0) {
        const codeArrArr = Array.from(allCodes);
        const codeArr = sqlArray(codeArrArr);
        const prodRaw = await db.execute(
          sql`SELECT DISTINCT ON (matched_code) matched_code AS "articleCode", name FROM (
                SELECT name,
                  CASE WHEN code        = ANY(${codeArr}) THEN code
                       WHEN article_code = ANY(${codeArr}) THEN article_code
                  END AS matched_code
                FROM factory_bale_products
                WHERE company_id = ${companyId}
                  AND (code = ANY(${codeArr}) OR article_code = ANY(${codeArr}))
              ) sub
              WHERE matched_code IS NOT NULL
              ORDER BY matched_code`
        );
        resultRows<{ articleCode: string | null; name: string | null }>(prodRaw).forEach((r) => {
          if (r.name && r.articleCode) productNamesMap[r.articleCode] = r.name;
        });
      }

      // 9b. Fill remaining codes from proforma line names (last resort)
      allLines.forEach((l) => {
        if (!productNamesMap[l.articleCode]) productNamesMap[l.articleCode] = l.productName;
      });

      // 9c. Final fallback — look up product_name stored on factory_bales for any codes
      //     that are still unmapped after the products-table and proforma-line lookups.
      //     This catches bales whose article_code has no matching row in factory_bale_products
      //     (e.g. legacy codes, renamed products, or manually-entered codes).
      const unmappedCodes = Array.from(allCodes).filter((c) => !productNamesMap[c]);
      if (unmappedCodes.length > 0) {
        const unmappedArr = sqlArray(unmappedCodes);
        const baleNamesRaw = await db.execute(
          sql`SELECT DISTINCT ON (article_code) article_code AS "articleCode", product_name AS "productName"
              FROM factory_bales
              WHERE company_id = ${companyId}
                AND article_code = ANY(${unmappedArr})
                AND product_name IS NOT NULL
                AND product_name != ''
              ORDER BY article_code, created_at DESC`
        );
        resultRows<{ articleCode: string | null; productName: string | null }>(baleNamesRaw).forEach((r) => {
          if (r.articleCode && r.productName && !productNamesMap[r.articleCode]) {
            productNamesMap[r.articleCode] = r.productName;
          }
        });
      }

      // 9. Build per-article aggregates
      const orderCountByProforma = new Map<number, number>();
      const ordersByProformaId = new Map<number, OrderRow[]>();
      for (const o of ordersByProforma) {
        orderCountByProforma.set(o.proformaId, (orderCountByProforma.get(o.proformaId) ?? 0) + 1);
        if (!ordersByProformaId.has(o.proformaId)) ordersByProformaId.set(o.proformaId, []);
        ordersByProformaId.get(o.proformaId)!.push(o);
      }

      // expectedToLoad: remaining expected quantity for DRAFT + LOADING containers.
      //   DRAFT:   remaining = expected_qty          (loaded = 0 by definition)
      //   LOADING: remaining = max(expected_qty − loaded_qty, 0)
      //   PENDING_VERIFICATION / VERIFIED / FINALIZED: excluded — bales already SOLD
      //   CANCELLED: excluded
      //
      // Available Balance = stockAvailable − expectedToLoad − totalLoaded
      // This prevents showing free bales that are still needed to complete active containers.
      // V5 guard: proformaIdUsed IS NOT NULL (allExpectedLines already filtered to active V5 orders)
      const activeDraftLoadingIds = new Set(
        ordersByProforma.filter((o) => o.status === "DRAFT" || o.status === "LOADING").map((o) => o.id)
      );
      const expectedMap = new Map<string, number>();
      allExpectedLines.forEach((el) => {
        if (!activeDraftLoadingIds.has(el.orderId)) return;
        const loaded =
          loadedBalesByOrder.find((b) => b.orderId === el.orderId && b.articleCode === el.articleCode)?.count ?? 0;
        const remaining = Math.max(el.expectedQty - loaded, 0);
        expectedMap.set(el.articleCode, (expectedMap.get(el.articleCode) ?? 0) + remaining);
      });

      // 10. Build rows — union of all known codes (including zero-stock active products)
      const rows = Array.from(allCodes)
        .sort()
        .map((articleCode) => {
          const stockAvailable = inStockMap.get(articleCode) ?? 0;
          const totalLoaded = inLoadingMap.get(articleCode) ?? 0;
          const expectedToLoad = expectedMap.get(articleCode) ?? 0;
          const freeToPromise = stockAvailable - expectedToLoad - totalLoaded;

          // Per-proforma/per-container expandable detail
          const proformaDetails = activeProformasRaw
            .filter((p) => allLines.some((l) => l.proformaId === p.id && l.articleCode === articleCode))
            .map((p) => {
              const line = allLines.find((l) => l.proformaId === p.id && l.articleCode === articleCode);
              const lineQty = line?.quantity ?? 0;
              const linkedOrders = ordersByProformaId.get(p.id) ?? [];
              const containers = linkedOrders.map((o) => {
                const loadedBales =
                  loadedBalesByOrder.find((b) => b.orderId === o.id && b.articleCode === articleCode)?.count ?? 0;
                // Phase B: use locked-in per-container expected qty from customer_order_expected_lines.
                // Falls back to lineQty if no expected line exists (e.g. order pre-dates Phase B backfill).
                const containerExpectedQty = perContainerExpectedMap.get(`${o.id}__${articleCode}`) ?? lineQty;
                const remainingQty = Math.max(containerExpectedQty - loadedBales, 0);
                return {
                  orderId: o.id,
                  containerName: o.containerNumber || `Order #${o.id}`,
                  status: o.status,
                  expectedQty: containerExpectedQty,
                  loadedQty: loadedBales,
                  remainingQty,
                };
              });
              // totalExpected: sum of locked-in per-container expected qty for this article
              const totalExpected = linkedOrders.reduce(
                (sum, o) => sum + (perContainerExpectedMap.get(`${o.id}__${articleCode}`) ?? lineQty),
                0
              );
              return {
                proformaId: p.id,
                proformaName: p.name,
                customerId: p.customerId,
                customerName: customerMap.get(p.customerId!) ?? `Customer #${p.customerId}`,
                lineQty,
                containerCount: linkedOrders.length,
                totalExpected,
                containers,
              };
            });

          const productName = productNamesMap[articleCode] || articleCode;
          const weightKg = weightMap.get(articleCode) ?? 0;
          const totalKg = Math.round(stockAvailable * weightKg);
          const isGarbageOrWipers = excludedCodes.has(articleCode);
          const categoryName = categoryMap.get(articleCode) ?? "";
          return {
            articleCode,
            productName,
            categoryName,
            stockAvailable,
            totalLoaded,
            expectedToLoad,
            freeToPromise,
            totalKg,
            proformaDetails,
            isGarbageOrWipers,
          };
        });

      // 11. Apply frontend filters
      let filtered = rows;
      if (productFilter) {
        const q = String(productFilter).toLowerCase();
        filtered = filtered.filter(
          (r) => r.articleCode.toLowerCase().includes(q) || r.productName.toLowerCase().includes(q)
        );
      }
      if (customerFilter) {
        const q = String(customerFilter).toLowerCase();
        filtered = filtered.filter((r) => r.proformaDetails.some((d) => d.customerName.toLowerCase().includes(q)));
      }
      if (proformaFilter) {
        const q = String(proformaFilter).toLowerCase();
        filtered = filtered.filter((r) => r.proformaDetails.some((d) => d.proformaName.toLowerCase().includes(q)));
      }
      if (containerFilter) {
        const q = String(containerFilter).toLowerCase();
        filtered = filtered.filter((r) =>
          r.proformaDetails.some((d) => d.containers.some((c) => c.containerName.toLowerCase().includes(q)))
        );
      }
      if (statusFilter) {
        const q = String(statusFilter).toUpperCase();
        filtered = filtered.filter((r) => r.proformaDetails.some((d) => d.containers.some((c) => c.status === q)));
      }
      if (hideZero === "true") {
        // Keep rows that have non-zero counts OR that still have at least one non-cancelled
        // container in any linked proforma (e.g. a FINALIZED order whose bales are already SOLD
        // and therefore no longer contribute to stockAvailable / totalLoaded / expectedToLoad).
        filtered = filtered.filter(
          (r) =>
            r.expectedToLoad > 0 ||
            r.stockAvailable > 0 ||
            r.totalLoaded > 0 ||
            r.proformaDetails.some((d) => d.containers.some((c) => c.status !== "CANCELLED"))
        );
      }

      // Search param (frontend search box — unified alias alongside productFilter)
      if (search && !productFilter) {
        const q = String(search).toLowerCase();
        filtered = filtered.filter(
          (r) => r.articleCode.toLowerCase().includes(q) || r.productName.toLowerCase().includes(q)
        );
      }

      // Recompute totals over the final filtered set (search may have trimmed rows)
      const finalTotals = {
        stockAvailable: filtered.reduce((s, r) => s + r.stockAvailable, 0),
        totalLoaded: filtered.reduce((s, r) => s + r.totalLoaded, 0),
        expectedToLoad: filtered.reduce((s, r) => s + r.expectedToLoad, 0),
        freeToPromise: filtered.reduce((s, r) => s + r.freeToPromise, 0),
        totalKg: filtered.reduce((s, r) => s + r.totalKg, 0),
        shortageCount: filtered.filter((r) => r.freeToPromise < 0).length,
      };

      // In-memory pagination — only applied when ?page= is explicitly set.
      const rowLimit = Math.min(Number(limitQ) || 100, 250);
      const page = pageQ !== undefined ? Math.max(1, Number(pageQ) || 1) : null;
      const total = filtered.length;
      const totalPages = page !== null ? Math.max(1, Math.ceil(total / rowLimit)) : null;
      const pagedRows = page !== null ? filtered.slice((page - 1) * rowLimit, page * rowLimit) : filtered;

      res.set("Cache-Control", "private, max-age=60");
      if (page !== null) {
        res.json({
          rows: pagedRows,
          totals: finalTotals,
          productNames: productNamesMap,
          total,
          page,
          limit: rowLimit,
          totalPages,
        });
      } else {
        res.json({ rows: filtered, totals: finalTotals, productNames: productNamesMap });
      }
    } catch (err: unknown) {
      logger.error("[V5] stock-allocation error:", { error: err });
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── GET /api/factory/v5/stock-allocation/summary ─────────────────────────
  // Returns aggregate totals only — used for dashboard cards without loading the full list.
  app.get("/api/factory/v5/stock-allocation/summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [inStockRaw, inLoadingRaw, expectedRaw] = await Promise.all([
        db.execute(
          sql`SELECT COUNT(*)::int AS count FROM factory_bales
              WHERE company_id = ${companyId} AND status = 'IN_STOCK'`
        ),
        db.execute(
          sql`SELECT COUNT(*)::int AS count
              FROM customer_order_bales cob
              JOIN customer_orders co ON co.id = cob.order_id
              WHERE co.company_id = ${companyId} AND co.status = 'LOADING' AND co.proforma_id_used IS NOT NULL`
        ),
        db.execute(
          sql`SELECT COALESCE(SUM(cel.expected_qty),0)::int AS qty
              FROM customer_order_expected_lines cel
              JOIN customer_orders co ON co.id = cel.order_id
              WHERE co.company_id = ${companyId} AND co.status IN ('DRAFT','LOADING') AND co.proforma_id_used IS NOT NULL`
        ),
      ]);

      const stockAvailable = Number(resultRows(inStockRaw)[0]?.count ?? 0);
      const totalLoaded = Number(resultRows(inLoadingRaw)[0]?.count ?? 0);
      const expectedToLoad = Number(resultRows(expectedRaw)[0]?.qty ?? 0);
      const freeToPromise = stockAvailable - expectedToLoad - totalLoaded;

      res.set("Cache-Control", "private, max-age=60");
      res.json({ stockAvailable, totalLoaded, expectedToLoad, freeToPromise });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
