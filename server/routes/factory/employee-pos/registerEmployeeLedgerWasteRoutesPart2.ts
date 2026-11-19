// Extracted from ./employeeLedgerWasteRoutes.ts to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db, type RawQueryRow } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryBaleProducts,
  factoryBales,
  factoryBaleWasteDispatches,
  factoryCategories,
  locations,
} from "@shared/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import { toMoney } from "../../../lib/money";
import type { WasteLedgerBaleRow } from "./registerEmployeeLedgerWasteRoutesPart1";

export function registerEmployeeLedgerWasteRoutesPart2(app: Express) {
  // Lazy-loaded bale-level detail for a single section + product row of the Bale Ledger.
  // Keeps the main /api/factory/bale-ledger response small by not returning baleDetails there.
  app.get("/api/factory/bale-ledger/details", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const section = String(req.query.section || "");
      // A query parameter is only a string when it appears once; anything else
      // (repeated key, nested object) is not a product id.
      const productIdParam = typeof req.query.productId === "string" ? req.query.productId : undefined;
      const validSections = ["currentStock", "wasteStock", "sold", "wasteDispatched", "pendingLoading"];
      if (!validSections.includes(section)) {
        return res.status(400).json({ message: "Invalid section" });
      }

      const productId = productIdParam === "null" || productIdParam === undefined ? null : parseInt(productIdParam, 10);

      const [allBalesRaw, allProducts, allCategories, pendingOrderBaleIdsRaw, staleOrderBaleIdsRaw] = await Promise.all(
        [
          db.execute<RawQueryRow<WasteLedgerBaleRow>>(sql`
          SELECT
            fb.id,
            fb.product_id AS "productId",
            fb.article_code AS "articleCode",
            fb.status,
            fb.reference_number AS "referenceNumber",
            COALESCE(fb.weight_kg, 0)::float AS "weightKg",
            fb.waste_dispatch_id AS "wasteDispatchId"
          FROM factory_bales fb
          WHERE fb.company_id = ${companyId}
          AND fb.status IN ('IN_STOCK', 'FINALIZED', 'SOLD', 'DISPATCHED', 'RESERVED_FOR_ORDER')
          AND (${productId === null} AND fb.product_id IS NULL OR fb.product_id = ${productId})
        `),
          db
            .select({
              id: factoryBaleProducts.id,
              categoryId: factoryBaleProducts.categoryId,
              productionPrice: factoryBaleProducts.productionPrice,
            })
            .from(factoryBaleProducts)
            .where(eq(factoryBaleProducts.companyId, companyId)),
          db
            .select({ id: factoryCategories.id, name: factoryCategories.name })
            .from(factoryCategories)
            .where(eq(factoryCategories.companyId, companyId)),
          db.execute(sql`
          SELECT DISTINCT cob.bale_id AS "baleId"
          FROM customer_order_bales cob
          INNER JOIN customer_orders co ON co.id = cob.order_id
          WHERE co.company_id = ${companyId}
          AND co.status IN ('LOADING', 'PENDING_VERIFICATION', 'VERIFIED')
        `),
          db.execute(sql`
          SELECT DISTINCT cob.bale_id AS "baleId"
          FROM customer_order_bales cob
          INNER JOIN customer_orders co ON co.id = cob.order_id
          WHERE co.company_id = ${companyId}
          AND co.status IN ('FINALIZED', 'DISPATCHED', 'SOLD')
        `),
        ]
      );

      const allBales = Array.isArray(allBalesRaw) ? allBalesRaw : resultRows(allBalesRaw);
      const pendingOrderBaleIds = new Set<number>(
        (Array.isArray(pendingOrderBaleIdsRaw) ? pendingOrderBaleIdsRaw : resultRows(pendingOrderBaleIdsRaw)).map((r) =>
          Number(r.baleId)
        )
      );
      const staleOrderBaleIds = new Set<number>(
        (Array.isArray(staleOrderBaleIdsRaw) ? staleOrderBaleIdsRaw : resultRows(staleOrderBaleIdsRaw)).map((r) =>
          Number(r.baleId)
        )
      );

      const productMap = new Map(allProducts.map((p) => [p.id, p]));
      const wasteCategories = new Set<number>(
        allCategories
          .filter((c) => {
            const n = (c.name || "").toLowerCase();
            return n.includes("garbage") || n.includes("wiper");
          })
          .map((c) => c.id)
      );
      function isWasteProduct(pid: number | null, articleCode?: string | null): boolean {
        if (articleCode?.startsWith("HMD16")) return true;
        if (!pid) return false;
        const p = productMap.get(pid);
        if (!p) return false;
        return p.categoryId ? wasteCategories.has(p.categoryId) : false;
      }
      function getSellingPrice(bale: WasteLedgerBaleRow): number {
        const p = bale.productId ? productMap.get(bale.productId) : null;
        return toMoney(p?.productionPrice).toNumber();
      }

      function classify(bale: WasteLedgerBaleRow): string {
        if (bale.status === "SOLD") {
          return pendingOrderBaleIds.has(Number(bale.id)) ? "pendingLoading" : "sold";
        } else if (bale.status === "FINALIZED") {
          return "sold";
        } else if (bale.status === "DISPATCHED" && bale.wasteDispatchId) {
          return "wasteDispatched";
        } else if (bale.status === "RESERVED_FOR_ORDER") {
          return "pendingLoading";
        } else if (bale.status === "IN_STOCK") {
          if (pendingOrderBaleIds.has(Number(bale.id))) return "pendingLoading";
          if (staleOrderBaleIds.has(Number(bale.id))) return "sold";
          return isWasteProduct(bale.productId, bale.articleCode) ? "wasteStock" : "currentStock";
        }
        return "unknown";
      }

      const details = allBales
        .filter((bale) => classify(bale) === section)
        .map((bale) => ({
          id: bale.id,
          ref: bale.referenceNumber || "",
          weightKg: toMoney(bale.weightKg).toNumber(),
          totalCost: getSellingPrice(bale),
        }));

      res.json({ baleDetails: details });
    } catch (error: unknown) {
      logger.error("Error fetching bale ledger details:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ============================================================
  // WASTE DISPATCH ROUTES — factory bale waste disposal
  // ============================================================

  app.get(
    "/api/factory/waste-dispatch/bales",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const search = (req.query.search as string) || "";

        const allCategories = await db
          .select()
          .from(factoryCategories)
          .where(eq(factoryCategories.companyId, companyId));
        const wasteCategories = allCategories.filter((c) => {
          const name = (c.name || "").toLowerCase();
          return name.includes("garbage") || name.includes("wiper");
        });
        const wasteCategoryIds = new Set(wasteCategories.map((c) => c.id));

        const allProducts = await db
          .select()
          .from(factoryBaleProducts)
          .where(eq(factoryBaleProducts.companyId, companyId));
        const wasteProductIds = new Set(
          allProducts
            .filter((p) => {
              if (p.categoryId && wasteCategoryIds.has(p.categoryId)) return true;
              if (p.articleCode?.startsWith("HMD16")) return true;
              return false;
            })
            .map((p) => p.id)
        );

        if (wasteProductIds.size === 0) {
          return res.json({ bales: [], categories: wasteCategories });
        }

        const baleRows = await db
          .select()
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              eq(factoryBales.status, "IN_STOCK"),
              inArray(factoryBales.productId, Array.from(wasteProductIds) as number[]),
              // Exclude bales already sold through a container order
              // (mirrors the same guard used in location-inventory)
              sql`NOT EXISTS (
              SELECT 1 FROM customer_order_bales cob
              INNER JOIN customer_orders co ON co.id = cob.order_id
              WHERE cob.bale_id = ${factoryBales.id}
                AND co.status IN ('FINALIZED','DISPATCHED','SOLD')
                AND co.company_id = ${companyId}
            )`
            )
          )
          .orderBy(desc(factoryBales.id));

        const productMap = new Map(allProducts.map((p) => [p.id, p]));
        const categoryMap = new Map(allCategories.map((c) => [c.id, c]));

        const locationIds = [...new Set(baleRows.map((b) => b.erpLocationId).filter(Boolean))] as number[];
        const locationRows =
          locationIds.length > 0
            ? await db
                .select({ id: locations.id, name: locations.name })
                .from(locations)
                .where(inArray(locations.id, locationIds))
            : [];
        const locationMap = new Map(locationRows.map((l) => [l.id, l.name]));

        const enriched = baleRows.map((b) => {
          const product = productMap.get(b.productId as number);
          const cat = product?.categoryId ? categoryMap.get(product.categoryId) : null;
          return {
            id: b.id,
            referenceNumber: b.referenceNumber,
            productName: product?.name || product?.articleCode || b.productName || "Unknown",
            articleCode: b.articleCode || product?.articleCode,
            categoryName: cat?.name || b.category || "—",
            weightKg: toMoney(b.weightKg as string).toNumber(),
            costPerKg: toMoney(b.costPerKg as string).toNumber(),
            totalCost: toMoney(b.totalCost as string).toNumber(),
            status: b.status,
            locationName: b.erpLocationId ? locationMap.get(b.erpLocationId) || "Unknown" : "No Location",
            locationId: b.erpLocationId,
            finalizedAt: b.finalizedAt,
          };
        });

        const filtered = search
          ? enriched.filter((b) =>
              searchAny(search, b.referenceNumber, b.productName, b.articleCode, b.categoryName, b.locationName)
            )
          : enriched;

        res.json({ bales: filtered, categories: wasteCategories });
      } catch (error: unknown) {
        logger.error("Error fetching waste bales:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/factory/waste-dispatch/history",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const dispatches = await db
          .select()
          .from(factoryBaleWasteDispatches)
          .where(eq(factoryBaleWasteDispatches.companyId, companyId))
          .orderBy(desc(factoryBaleWasteDispatches.id));

        // Fetch all removed bales for this company that have a waste_dispatch_id set.
        // Using raw SQL to avoid Drizzle array serialization issues with ANY().
        const linkedBalesRaw = await db.execute(sql`
        SELECT
          id,
          reference_number       AS "referenceNumber",
          product_name           AS "productName",
          COALESCE(weight_kg, 0)::float   AS "weightKg",
          COALESCE(total_cost, 0)::float  AS "totalCost",
          waste_dispatch_id      AS "wasteDispatchId"
        FROM factory_bales
        WHERE company_id = ${companyId}
          AND waste_dispatch_id IS NOT NULL
        ORDER BY waste_dispatch_id, id
      `);
        const linkedBales = Array.isArray(linkedBalesRaw) ? linkedBalesRaw : resultRows(linkedBalesRaw);

        const balesByDispatch = new Map<number, unknown[]>();
        for (const bale of linkedBales) {
          const did = Number(bale.wasteDispatchId);
          if (!balesByDispatch.has(did)) balesByDispatch.set(did, []);
          balesByDispatch.get(did)!.push(bale);
        }

        res.json(
          dispatches.map((d) => ({
            ...d,
            bales: balesByDispatch.get(d.id) || [],
          }))
        );
      } catch (error: unknown) {
        logger.error("Error fetching waste dispatch history:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
