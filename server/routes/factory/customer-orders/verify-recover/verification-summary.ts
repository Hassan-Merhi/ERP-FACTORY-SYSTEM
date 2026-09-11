/**
 * orderVerifyRecoverRoutes: OrderVerificationSummary endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { parseId } from "../../../../lib/parseId";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import {} from "../../_helpers";
import { factoryBaleProducts } from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { resultRows } from "../../../../lib/queryResult";

// Raw-row contracts for the SELECT * queries in this route. The columns are
// snake_case because they come straight from PostgreSQL, and every field is
// optional-or-nullable because the query is deliberately schema-drift tolerant.
type RawOrderRow = {
  id: number;
  company_id: number;
  customer_id: number | null;
  invoice_number: string | null;
  order_date: string | null;
  proforma_id_used: number | null;
  status: string | null;
  subtotal_bales: string | null;
  freight_amount: string | null;
  other_charges_total: string | null;
  grand_total: string | null;
  total_qty_bales: number | null;
  container_number: string | null;
  shipping_company: string | null;
  container_notes: string | null;
  destination: string | null;
  verified_by_user_id: number | null;
  verified_at: Date | null;
  loading_started_at: Date | null;
  loading_finalized_at: Date | null;
  location_id: number | null;
  deleted_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
};

type RawOrderLineRow = {
  qty?: number | null;
  article_code?: string | null;
  articleCode?: string | null;
  total_weight?: string | number | null;
  totalWeight?: string | number | null;
  total_price?: string | number | null;
  totalPrice?: string | number | null;
  bale_name?: string | null;
  baleName?: string | null;
};

type RawProformaLineRow = {
  article_code?: string | null;
  articleCode?: string | null;
  pricing_mode?: string | null;
  pricingMode?: string | null;
  price_per_kg?: string | number | null;
  pricePerKg?: string | number | null;
  product_name?: string | null;
  productName?: string | null;
  quantity?: number | null;
  price_per_bale?: string | null;
  pricePerBale?: string | null;
};

type OrderComparisonRow = {
  articleCode: string;
  productName: string;
  loadedQty: number;
  expectedQty: number;
  diff: number;
  totalWeight: number;
  totalPrice: number;
  pricePerBale: string;
  inProforma: boolean;
  status: string;
  stockQty: number;
  stockTotalWeight: number;
};

export function registerOrderVerificationSummaryRoutes(app: Express) {
  app.get("/api/factory/customer-orders/:id/verification-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });

      // ── Use SELECT * for ALL queries in this route so that schema drift between
      // the Drizzle model and the live production table never causes a parse-time
      // "column does not exist" crash.  JS-side defaults are applied after each query.
      // (Drizzle's db.select() generates an explicit column list; if ANY column in
      //  shared/schema.ts hasn't been added to production yet the whole query fails
      //  before returning a single row — even COALESCE doesn't help because PostgreSQL
      //  rejects the SQL at parse time, not execution time.)

      const rawOrderResult = await db.execute(
        sql`SELECT * FROM customer_orders WHERE id = ${orderId} AND company_id = ${companyId} LIMIT 1`
      );
      const rawOrderRows = resultRows<RawOrderRow>(rawOrderResult);
      if (!rawOrderRows.length) return res.status(404).json({ message: "Order not found" });
      const orderRow = rawOrderRows[0];
      // Normalise the raw row into a typed object with JS-side defaults.
      const order = {
        id: orderRow.id,
        companyId: orderRow.company_id,
        customerId: orderRow.customer_id,
        invoiceNumber: orderRow.invoice_number ?? null,
        orderDate: orderRow.order_date,
        proformaIdUsed: orderRow.proforma_id_used ?? null,
        status: orderRow.status ?? "DRAFT",
        subtotalBales: orderRow.subtotal_bales ?? "0",
        freightAmount: orderRow.freight_amount ?? "0",
        otherChargesTotal: orderRow.other_charges_total ?? "0",
        grandTotal: orderRow.grand_total ?? "0",
        totalQtyBales: orderRow.total_qty_bales ?? 0,
        containerNumber: orderRow.container_number ?? null,
        shippingCompany: orderRow.shipping_company ?? null,
        containerNotes: orderRow.container_notes ?? null,
        destination: orderRow.destination ?? null,
        verifiedByUserId: orderRow.verified_by_user_id ?? null,
        verifiedAt: orderRow.verified_at ?? null,
        loadingStartedAt: orderRow.loading_started_at ?? null,
        loadingFinalizedAt: orderRow.loading_finalized_at ?? null,
        locationId: orderRow.location_id ?? null,
        deletedAt: orderRow.deleted_at ?? null,
        createdAt: orderRow.created_at,
        updatedAt: orderRow.updated_at ?? orderRow.created_at,
      };

      const rawBalesResult = await db.execute(sql`SELECT * FROM customer_order_bales WHERE order_id = ${orderId}`);
      const rawBaleRows = resultRows(rawBalesResult);
      const orderBales = rawBaleRows.map((r) => ({
        id: r.id,
        order_id: r.order_id,
        bale_id: r.bale_id,
        weight: String(r.weight ?? "0"),
        article_code: String(r.article_code ?? ""),
        bale_name: String(r.bale_name ?? ""),
        price_used: String(r.price_used ?? "0"),
        bale_reference: String(r.bale_reference ?? ""),
      }));

      logger.debug("Factory order verification summary loaded", {
        module: "factory-orders",
        action: "verify-summary",
        orderId,
        companyId,
        status: order.status,
        proformaIdUsed: order.proformaIdUsed,
        orderBaleCount: orderBales.length,
        totalQtyBales: order.totalQtyBales,
      });

      // ── Fallback: when customer_order_bales is empty but the order has a recorded
      // total (total_qty_bales > 0), reconstruct loadedByArticle from customer_order_lines.
      // customer_order_lines is rebuilt by recalculateOrderTotals every time a bale is
      // scanned, so it is the most reliable per-article aggregate when individual bale
      // rows are unavailable (e.g. after a partial bale-row migration or cleanup).
      let dataSource: "bale_rows" | "order_lines" = "bale_rows";
      const syntheticBalesFromLines: typeof orderBales = [];

      if (orderBales.length === 0 && order.totalQtyBales > 0) {
        const rawLinesResult = await db.execute(sql`SELECT * FROM customer_order_lines WHERE order_id = ${orderId}`);
        const linesRows = resultRows<RawOrderLineRow>(rawLinesResult);
        const hasLines = linesRows.some((r) => (r.qty ?? 0) > 0);

        if (hasLines) {
          dataSource = "order_lines";
          logger.warn("Factory order verification used order-line fallback", {
            module: "factory-orders",
            action: "verify-summary-fallback",
            orderId,
            companyId,
            orderLineCount: linesRows.length,
            totalQtyBales: order.totalQtyBales,
          });
          // Synthesise bale-like records from lines so the rest of the pipeline works unchanged
          for (const row of linesRows) {
            const qty = Number(row.qty ?? 0);
            if (qty <= 0) continue;
            const articleCode = String(row.article_code ?? row.articleCode ?? "UNKNOWN");
            const totalWeight = Number(row.total_weight ?? row.totalWeight ?? 0);
            const totalPrice = Number(row.total_price ?? row.totalPrice ?? 0);
            const weightPerBale = qty > 0 ? totalWeight / qty : 0;
            const pricePerBale = qty > 0 ? totalPrice / qty : 0;
            for (let i = 0; i < qty; i++) {
              syntheticBalesFromLines.push({
                id: 0,
                order_id: orderId,
                bale_id: 0,
                weight: String(weightPerBale),
                article_code: articleCode,
                bale_name: String(row.bale_name ?? row.baleName ?? articleCode),
                price_used: String(pricePerBale),
                bale_reference: "",
              });
            }
          }
        }
      }

      const effectiveBales = dataSource === "order_lines" ? syntheticBalesFromLines : orderBales;

      // Build preliminary article code set from loaded bales.
      const loadedByArticle: Record<
        string,
        {
          articleCode: string;
          productName: string;
          qty: number;
          totalWeight: number;
          totalPrice: number;
          pricingMode: string;
          pricePerKg: number;
        }
      > = {};
      for (const b of effectiveBales) {
        const articleCode = b.article_code;
        const baleName = b.bale_name;
        const priceUsed = b.price_used;
        const weight = b.weight;

        const code = articleCode || "UNKNOWN";
        if (!loadedByArticle[code]) {
          loadedByArticle[code] = {
            articleCode: code,
            productName: baleName || code,
            qty: 0,
            totalWeight: 0,
            totalPrice: 0,
            pricingMode: "per_bale",
            pricePerKg: 0,
          };
        }
        loadedByArticle[code].qty += 1;
        loadedByArticle[code].totalWeight += parseFloat(weight) || 0;
        loadedByArticle[code].totalPrice += parseFloat(priceUsed) || 0;
      }

      let proformaLines: RawProformaLineRow[] = [];
      const proformaByArticle: Record<
        string,
        {
          articleCode: string;
          productName: string;
          expectedQty: number;
          pricePerBale: string;
          pricingMode: string;
          pricePerKg: number;
        }
      > = {};

      if (order.proformaIdUsed) {
        // SELECT * to avoid explicit-column failures on production tables that may
        // be missing price_fixed or production_price_per_bale columns.
        const rawProformaResult = await db.execute(
          sql`SELECT * FROM customer_proforma_lines WHERE proforma_id = ${order.proformaIdUsed}`
        );
        proformaLines = resultRows<RawProformaLineRow>(rawProformaResult);

        for (const pl of proformaLines) {
          const articleCode = pl.article_code ?? pl.articleCode ?? "";
          if (!articleCode) continue;
          const pMode = pl.pricing_mode ?? pl.pricingMode ?? "per_bale";
          const pkgRate = parseFloat(String(pl.price_per_kg ?? pl.pricePerKg ?? "0")) || 0;
          proformaByArticle[articleCode] = {
            articleCode,
            productName: pl.product_name ?? pl.productName ?? articleCode,
            expectedQty: pl.quantity ?? 0,
            pricePerBale: pl.price_per_bale ?? pl.pricePerBale ?? "0",
            pricingMode: pMode,
            pricePerKg: pkgRate,
          };
          // Propagate pricing mode into loadedByArticle so the frontend can display correctly
          if (loadedByArticle[articleCode]) {
            loadedByArticle[articleCode].pricingMode = pMode;
            loadedByArticle[articleCode].pricePerKg = pkgRate;
          }
        }
      }

      // Look up authoritative product names from factoryBaleProducts.
      // Some stored names are stale or were saved as the article code itself —
      // use the catalogue name when available.
      const allCodes = [...new Set([...Object.keys(loadedByArticle), ...Object.keys(proformaByArticle)])].filter(
        (c) => c !== "UNKNOWN"
      );

      const productNameMap: Record<string, string> = {};
      if (allCodes.length > 0) {
        const rows = await db
          .select({ articleCode: factoryBaleProducts.articleCode, name: factoryBaleProducts.name })
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.companyId, companyId), inArray(factoryBaleProducts.articleCode, allCodes)));
        for (const r of rows) {
          if (r.articleCode && r.name) productNameMap[r.articleCode] = r.name;
        }
      }

      // Apply authoritative names — prefer catalogue name, fall back to stored name, last resort = code
      const resolveName = (code: string, storedName: string) =>
        productNameMap[code] || (storedName !== code ? storedName : null) || code;

      for (const [code, entry] of Object.entries(loadedByArticle)) {
        entry.productName = resolveName(code, entry.productName);
      }
      for (const [code, entry] of Object.entries(proformaByArticle)) {
        entry.productName = resolveName(code, entry.productName);
      }

      // Fetch IN_STOCK bale counts per article code for the relevant codes,
      // filtered by the order's locationId so the number matches what the
      // Location Inventory page shows for that location.
      const stockQtyMap: Record<string, number> = {};
      const stockWeightMap: Record<string, number> = {};
      if (allCodes.length > 0) {
        const codesList = sql.join(
          allCodes.map((c: string) => sql`${c}`),
          sql`,`
        );
        const locationFilter = order.locationId ? sql`AND fb.erp_location_id = ${order.locationId}` : sql``;
        const inStockRaw = await db.execute(
          sql`SELECT fb.article_code AS "articleCode",
                     SUM(COALESCE(fb.quantity, 1))::int AS count,
                     SUM(fb.weight_kg::numeric) AS total_weight
              FROM factory_bales fb
              WHERE fb.company_id = ${companyId}
                AND fb.status = 'IN_STOCK'
                AND fb.deleted_at IS NULL
                AND fb.article_code IN (${codesList})
                ${locationFilter}
              GROUP BY fb.article_code`
        );
        const inStockRows = resultRows<{
          articleCode: string | null;
          count: number | null;
          total_weight: string | null;
        }>(inStockRaw);
        for (const r of inStockRows) {
          if (r.articleCode) {
            stockQtyMap[r.articleCode] = Number(r.count);
            stockWeightMap[r.articleCode] = Number(r.total_weight ?? 0);
          }
        }

        // Subtract bales already scanned into any active LOADING order
        // (V5 bales stay IN_STOCK during loading, so we must deduct them manually)
        const loadingRaw = await db.execute(
          sql`SELECT fb.article_code AS "articleCode",
                     SUM(COALESCE(fb.quantity, 1))::int AS count,
                     SUM(fb.weight_kg::numeric) AS total_weight
              FROM factory_bales fb
              JOIN customer_order_bales cob ON cob.bale_id = fb.id
              JOIN customer_orders co ON co.id = cob.order_id
              WHERE fb.company_id = ${companyId}
                AND fb.status = 'IN_STOCK'
                AND fb.deleted_at IS NULL
                AND fb.article_code IN (${codesList})
                AND co.status = 'LOADING'
                ${locationFilter}
              GROUP BY fb.article_code`
        );
        const loadingRows = resultRows<{
          articleCode: string | null;
          count: number | null;
          total_weight: string | null;
        }>(loadingRaw);
        for (const r of loadingRows) {
          if (r.articleCode && stockQtyMap[r.articleCode] !== undefined) {
            stockQtyMap[r.articleCode] = Math.max(0, stockQtyMap[r.articleCode] - Number(r.count));
            stockWeightMap[r.articleCode] = Math.max(
              0,
              (stockWeightMap[r.articleCode] ?? 0) - Number(r.total_weight ?? 0)
            );
          }
        }
      }

      const allArticles = new Set([...Object.keys(loadedByArticle), ...Object.keys(proformaByArticle)]);
      const comparison: OrderComparisonRow[] = [];

      for (const code of allArticles) {
        const loaded = loadedByArticle[code] || null;
        const proforma = proformaByArticle[code] || null;
        const loadedQty = loaded?.qty || 0;
        const expectedQty = proforma?.expectedQty || 0;

        let status: string;
        if (!proforma && loadedQty > 0) {
          status = "LOADED_NOT_IN_PROFORMA";
        } else if (proforma && loadedQty === 0) {
          status = "MISSING_FROM_LOADED";
        } else if (expectedQty > 0 && loadedQty < expectedQty) {
          status = "UNDER_LOADED";
        } else if (expectedQty > 0 && loadedQty > expectedQty) {
          status = "OVER_LOADED";
        } else {
          status = "MATCH";
        }

        comparison.push({
          articleCode: code,
          productName: loaded?.productName || proforma?.productName || code,
          loadedQty,
          expectedQty,
          diff: loadedQty - expectedQty,
          totalWeight: loaded?.totalWeight || 0,
          totalPrice: loaded?.totalPrice || 0,
          pricePerBale: proforma?.pricePerBale || "0",
          inProforma: !!proforma,
          status,
          stockQty: stockQtyMap[code] ?? 0,
          stockTotalWeight: stockWeightMap[code] ?? 0,
        });
      }

      const proformaLinesWithStock = Object.values(proformaByArticle).map((pl) => ({
        ...pl,
        stockQty: stockQtyMap[pl.articleCode] ?? 0,
      }));

      const loadedItemsWithStock = Object.values(loadedByArticle).map((li) => ({
        ...li,
        stockQty: stockQtyMap[li.articleCode] ?? 0,
      }));

      res.json({
        order,
        loadedItems: loadedItemsWithStock,
        proformaLines: proformaLinesWithStock,
        comparison,
        totalLoadedBales: effectiveBales.length,
        totalLoadedWeight: Object.values(loadedByArticle).reduce((s, g) => s + g.totalWeight, 0),
        dataSource,
      });
    } catch (error: unknown) {
      logger.error("Error fetching verification summary:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
