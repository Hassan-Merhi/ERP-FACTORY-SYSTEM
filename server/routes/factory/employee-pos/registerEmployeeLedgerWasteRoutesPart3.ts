// Extracted from ./registerEmployeeLedgerWasteRoutesPart2.ts
import { searchAny } from "@shared/searchNormalization";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express } from "express";
import { db } from "../../../db";
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

export function registerEmployeeLedgerWasteRoutesPart3(app: Express) {
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
