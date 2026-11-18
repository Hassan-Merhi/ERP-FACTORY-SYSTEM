// Extracted from ./employeeLedgerWasteRoutes.ts to keep that module under the source-size cap.
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express } from "express";
import { db, type RawQueryRow } from "../../../db";
import { requireAuth } from "../../../auth";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { factoryBaleProducts, factoryCategories } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import { toMoney } from "../../../lib/money";

/**
 * A bale row from the waste-ledger projections.
 *
 * The aliases are quoted in SQL so the columns arrive camelCased, and the two
 * weight/cost columns are cast to `::float` in the query, so they really are
 * numbers here rather than the decimal strings a raw `numeric` would give.
 * `totalCost` is only selected by the ledger query, not the dispatch one.
 */
export interface WasteLedgerBaleRow {
  id: number;
  productId: number | null;
  productName?: string | null;
  articleCode: string | null;
  status: string;
  referenceNumber: string | null;
  weightKg: number;
  totalCost?: number;
  wasteDispatchId: number | null;
}

export const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerEmployeeLedgerWasteRoutesPart1(app: Express) {
  app.get(
    "/api/factory/bale-ledger",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        // Load all relevant data
        const [allBalesRaw, allProducts, allCategories, pendingOrderBaleIdsRaw, staleOrderBaleIdsRaw] =
          await Promise.all([
            db.execute<RawQueryRow<WasteLedgerBaleRow>>(sql`
          SELECT
            fb.id,
            fb.product_id AS "productId",
            fb.product_name AS "productName",
            fb.article_code AS "articleCode",
            fb.status,
            fb.reference_number AS "referenceNumber",
            COALESCE(fb.weight_kg, 0)::float AS "weightKg",
            COALESCE(fb.total_cost, 0)::float AS "totalCost",
            fb.waste_dispatch_id AS "wasteDispatchId"
          FROM factory_bales fb
          WHERE fb.company_id = ${companyId}
          AND fb.status IN ('IN_STOCK', 'FINALIZED', 'SOLD', 'DISPATCHED', 'RESERVED_FOR_ORDER')
          AND (
            -- Always include current/active bales regardless of age.
            fb.status IN ('IN_STOCK', 'RESERVED_FOR_ORDER')
            -- Limit historical (sold/dispatched) rows to the last 90 days to avoid
            -- scanning years of data (root cause of the 220-second query / pool crash).
            OR fb.created_at >= NOW() - INTERVAL '90 days'
          )
        `),
            db
              .select({
                id: factoryBaleProducts.id,
                name: factoryBaleProducts.name,
                articleCode: factoryBaleProducts.articleCode,
                categoryId: factoryBaleProducts.categoryId,
                productionPrice: factoryBaleProducts.productionPrice,
              })
              .from(factoryBaleProducts)
              .where(eq(factoryBaleProducts.companyId, companyId)),
            db
              .select({ id: factoryCategories.id, name: factoryCategories.name })
              .from(factoryCategories)
              .where(eq(factoryCategories.companyId, companyId)),
            // Bale IDs linked to orders currently in LOADING / PENDING_VERIFICATION / VERIFIED
            db.execute(sql`
          SELECT DISTINCT cob.bale_id AS "baleId"
          FROM customer_order_bales cob
          INNER JOIN customer_orders co ON co.id = cob.order_id
          WHERE co.company_id = ${companyId}
          AND co.status IN ('LOADING', 'PENDING_VERIFICATION', 'VERIFIED')
        `),
            // Stale bale IDs: bale DB status was never updated after the order completed.
            // These are physically gone — exclude from in-stock, matching Location Inventory logic.
            db.execute(sql`
          SELECT DISTINCT cob.bale_id AS "baleId"
          FROM customer_order_bales cob
          INNER JOIN customer_orders co ON co.id = cob.order_id
          WHERE co.company_id = ${companyId}
          AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')
        `),
          ]);

        const allBales = Array.isArray(allBalesRaw) ? allBalesRaw : resultRows(allBalesRaw);
        const pendingOrderBaleIds = new Set<number>(
          (Array.isArray(pendingOrderBaleIdsRaw) ? pendingOrderBaleIdsRaw : resultRows(pendingOrderBaleIdsRaw)).map(
            (r) => Number(r.baleId)
          )
        );
        // Bales physically gone but DB status not yet updated to SOLD/DISPATCHED
        const staleOrderBaleIds = new Set<number>(
          (Array.isArray(staleOrderBaleIdsRaw) ? staleOrderBaleIdsRaw : resultRows(staleOrderBaleIdsRaw)).map((r) =>
            Number(r.baleId)
          )
        );

        // Identify waste categories (garbage or wiper)
        const wasteCategories = new Set<number>(
          allCategories
            .filter((c) => {
              const n = (c.name || "").toLowerCase();
              return n.includes("garbage") || n.includes("wiper");
            })
            .map((c) => c.id)
        );

        const productMap = new Map(allProducts.map((p) => [p.id, p]));
        const categoryMap = new Map(allCategories.map((c) => [c.id, c]));

        function isWasteProduct(productId: number | null, articleCode?: string | null): boolean {
          if (articleCode?.startsWith("HMD16")) return true;
          if (!productId) return false;
          const p = productMap.get(productId);
          if (!p) return false;
          return p.categoryId ? wasteCategories.has(p.categoryId) : false;
        }

        function getProductLabel(bale: WasteLedgerBaleRow): {
          productName: string;
          articleCode: string;
          categoryName: string;
          productId: number | null;
        } {
          const p = bale.productId ? productMap.get(bale.productId) : null;
          const cat = p?.categoryId ? categoryMap.get(p.categoryId) : null;
          return {
            productName: p?.name || bale.productName || bale.articleCode || "Unknown",
            articleCode: p?.articleCode || bale.articleCode || "—",
            categoryName: cat?.name || "—",
            productId: bale.productId || null,
          };
        }

        // Use production (cost) price per bale from product
        function getSellingPrice(bale: WasteLedgerBaleRow): number {
          const p = bale.productId ? productMap.get(bale.productId) : null;
          return toMoney(p?.productionPrice).toNumber();
        }

        // Group bales into buckets
        type BaleDetail = { id: number; ref: string; weightKg: number; totalCost: number };
        type BucketRow = {
          productId: number | null;
          productName: string;
          articleCode: string;
          categoryName: string;
          baleCount: number;
          totalWeightKg: number;
          totalCost: number;
          baleDetails: BaleDetail[];
        };
        const buckets: {
          currentStock: Map<string, BucketRow>;
          wasteStock: Map<string, BucketRow>;
          sold: Map<string, BucketRow>;
          wasteDispatched: Map<string, BucketRow>;
          pendingLoading: Map<string, BucketRow>;
        } = {
          currentStock: new Map(),
          wasteStock: new Map(),
          sold: new Map(),
          wasteDispatched: new Map(),
          pendingLoading: new Map(),
        };

        function addToBucket(
          bucket: Map<string, BucketRow>,
          key: string,
          label: ReturnType<typeof getProductLabel>,
          bale: WasteLedgerBaleRow
        ) {
          const existing = bucket.get(key);
          // weightKg is cast to ::float in the query, so it is already a number.
          const w = Number.isFinite(bale.weightKg) ? bale.weightKg : 0;
          const c = getSellingPrice(bale); // selling price replaces cost
          const ref: string = bale.referenceNumber || "";
          const detail: BaleDetail = { id: bale.id, ref, weightKg: w, totalCost: c };
          if (existing) {
            existing.baleCount++;
            existing.totalWeightKg += w;
            existing.totalCost += c;
            existing.baleDetails.push(detail);
          } else {
            bucket.set(key, { ...label, baleCount: 1, totalWeightKg: w, totalCost: c, baleDetails: [detail] });
          }
        }

        for (const bale of allBales) {
          const label = getProductLabel(bale);
          const key = `${bale.productId ?? "null"}-${label.productName}`;
          const waste = isWasteProduct(bale.productId, bale.articleCode);

          if (bale.status === "SOLD") {
            if (pendingOrderBaleIds.has(Number(bale.id))) {
              // SOLD but still linked to a PENDING_VERIFICATION or VERIFIED order (not yet shipped/finalized)
              addToBucket(buckets.pendingLoading, key, label, bale);
            } else {
              addToBucket(buckets.sold, key, label, bale);
            }
          } else if (bale.status === "FINALIZED") {
            // FINALIZED means the customer order was completed — bale is sold/shipped.
            // Never count as in-stock; always goes to the sold bucket.
            addToBucket(buckets.sold, key, label, bale);
          } else if (bale.status === "DISPATCHED" && bale.wasteDispatchId) {
            addToBucket(buckets.wasteDispatched, key, label, bale);
          } else if (bale.status === "RESERVED_FOR_ORDER") {
            // Bale is physically reserved/scanned into a loading order
            addToBucket(buckets.pendingLoading, key, label, bale);
          } else if (bale.status === "IN_STOCK") {
            if (pendingOrderBaleIds.has(Number(bale.id))) {
              // Bale is linked to a LOADING/PENDING_VERIFICATION/VERIFIED order but not yet reserved
              addToBucket(buckets.pendingLoading, key, label, bale);
            } else if (staleOrderBaleIds.has(Number(bale.id))) {
              // Stale: still IN_STOCK in DB but the order was FINALIZED/DISPATCHED/SOLD.
              // The bale is physically gone — count it as sold, matching Location Inventory.
              addToBucket(buckets.sold, key, label, bale);
            } else if (waste) {
              addToBucket(buckets.wasteStock, key, label, bale);
            } else {
              addToBucket(buckets.currentStock, key, label, bale);
            }
          }
        }

        function bucketToArray(m: Map<string, BucketRow>) {
          return Array.from(m.values())
            .sort((a, b) => {
              const catCmp = a.categoryName.localeCompare(b.categoryName);
              if (catCmp !== 0) return catCmp;
              return a.productName.localeCompare(b.productName);
            })
            .map((r) => {
              // Strip baleDetails from the summary response — this is the main bandwidth cost.
              // Full detail is available on demand via /api/factory/bale-ledger/details.
              const { baleDetails, ...rest } = r;
              return rest;
            });
        }

        function sumBucket(rows: Omit<BucketRow, "baleDetails">[]) {
          return rows.reduce(
            (acc, r) => ({
              baleCount: acc.baleCount + r.baleCount,
              totalWeightKg: acc.totalWeightKg + r.totalWeightKg,
              totalCost: acc.totalCost + r.totalCost,
            }),
            { baleCount: 0, totalWeightKg: 0, totalCost: 0 }
          );
        }

        const currentStock = bucketToArray(buckets.currentStock);
        const wasteStock = bucketToArray(buckets.wasteStock);
        const sold = bucketToArray(buckets.sold);
        const wasteDispatched = bucketToArray(buckets.wasteDispatched);
        const pendingLoading = bucketToArray(buckets.pendingLoading);

        res.set("Cache-Control", "private, max-age=120");
        res.json({
          currentStock,
          wasteStock,
          sold,
          wasteDispatched,
          pendingLoading,
          totals: {
            currentStock: sumBucket(currentStock),
            wasteStock: sumBucket(wasteStock),
            sold: sumBucket(sold),
            wasteDispatched: sumBucket(wasteDispatched),
            pendingLoading: sumBucket(pendingLoading),
            grand: sumBucket([...currentStock, ...wasteStock, ...sold, ...wasteDispatched, ...pendingLoading]),
          },
        });
      } catch (error: unknown) {
        logger.error("Error fetching bale ledger:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
