// Extracted from ./locationInventoryRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  customerOrderBales,
  customerOrders,
  factoryBaleProducts,
  factoryBales,
  factoryCategories,
} from "@shared/schema";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";

/** A stored amount (or its fallback when empty) as an exact decimal. */
export const amount = (value: unknown, fallback = "0") => toMoney((value || fallback) as string);

/** a + b computed exactly; running totals stay numbers in these responses. */
export const plus = (a: number, b: Decimal | number) => toMoney(a).plus(b).toNumber();

/** Rounded half up to 2 decimals, as a number for the spreadsheet cell. */
export const cents = (value: Decimal) => value.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toNumber();

export function registerFactoryLocationInventoryRoutesPart1(app: Express) {
  app.get("/api/factory/location-inventory/:locationId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const locationId = parseId(req.params.locationId);

      if (locationId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });

      const bales = await db
        .select()
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            eq(factoryBales.erpLocationId, locationId),
            eq(factoryBales.status, "IN_STOCK"),
            // Exclude bales already assigned to active or completed outbound orders,
            // even when their stored DB status is still IN_STOCK.
            sql`NOT EXISTS (
              SELECT 1 FROM customer_order_bales cob
              INNER JOIN customer_orders co ON co.id = cob.order_id
              WHERE cob.bale_id = ${factoryBales.id}
                AND co.status IN ('LOADING','PENDING_VERIFICATION','VERIFIED','FINALIZED','DISPATCHED','SOLD')
                AND co.company_id = ${companyId}
                AND co.deleted_at IS NULL
            )`
          )
        );

      // Find which of these IN_STOCK bales are currently in an active order
      // (LOADING, PENDING_VERIFICATION, or VERIFIED). This matches the Bale Ledger's
      // "Pending Loading / Verified" definition so the two pages stay in sync.
      const baleIds = bales.map((b) => b.id);
      const loadingBaleIds = new Set<number>();
      if (baleIds.length > 0) {
        const loadingRows = await db
          .select({ baleId: customerOrderBales.baleId })
          .from(customerOrderBales)
          .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
          .where(
            and(
              or(
                eq(customerOrders.status, "LOADING"),
                eq(customerOrders.status, "PENDING_VERIFICATION"),
                eq(customerOrders.status, "VERIFIED")
              ),
              inArray(customerOrderBales.baleId, baleIds),
              isNull(customerOrders.deletedAt)
            )
          );
        for (const r of loadingRows) loadingBaleIds.add(r.baleId);
      }

      // Fetch ALL products for the company so we can also match by articleCode
      // (bales imported historically may have productId=null but articleCode set)
      const allProducts = await db
        .select()
        .from(factoryBaleProducts)
        .where(eq(factoryBaleProducts.companyId, companyId));

      const categoryIds = [...new Set(allProducts.map((p) => p.categoryId).filter((id): id is number => id != null))];
      const categories =
        categoryIds.length > 0
          ? await db
              .select()
              .from(factoryCategories)
              .where(and(eq(factoryCategories.companyId, companyId), inArray(factoryCategories.id, categoryIds)))
          : [];

      const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
      // Primary lookup: by product id
      const productById = new Map(allProducts.map((p) => [p.id, p]));
      // Fallback lookup: by articleCode (for bales where productId is null/0)
      const productByArticleCode = new Map(
        allProducts.filter((p) => p.articleCode).map((p) => [p.articleCode!.toLowerCase(), p])
      );

      const getProduct = (bale: (typeof bales)[number]) => {
        const byId = bale.productId ? productById.get(bale.productId) : undefined;
        if (byId) return byId;
        return bale.articleCode ? productByArticleCode.get(bale.articleCode.toLowerCase()) : undefined;
      };

      const grouped = new Map<
        string,
        {
          productId: number;
          articleCode: string;
          productName: string;
          productNameAr: string | null;
          category: string | null;
          categoryId: number | null;
          quantity: number;
          totalWeight: number;
          totalCost: number;
          baleCount: number;
          loadingCount: number;
          sellingPrice: string;
          productionPrice: number;
          referenceNumbers: string[];
        }
      >();

      for (const b of bales) {
        const product = getProduct(b);
        const groupKey = product ? `p:${product.id}` : `a:${b.articleCode || b.baleCode || "unknown"}`;
        const existing = grouped.get(groupKey);
        const qty = amount(b.quantity, "1").toNumber();
        const weight = amount(b.weightKg).toNumber();
        const productionPrice = amount(product?.productionPrice).toNumber();
        const sellingPrice = String(product?.sellingPrice || "0");
        const categoryName = product?.categoryId
          ? categoryMap.get(product.categoryId) || b.category || null
          : b.category || null;
        const categoryId = product?.categoryId || null;
        const refNum: string = b.referenceNumber || "";
        const isLoading = loadingBaleIds.has(b.id);
        if (existing) {
          existing.quantity = plus(existing.quantity, qty);
          existing.totalWeight = plus(existing.totalWeight, weight);
          existing.totalCost = plus(existing.totalCost, productionPrice);
          existing.baleCount += 1;
          if (isLoading) existing.loadingCount += 1;
          if (refNum) existing.referenceNumbers.push(refNum);
        } else {
          grouped.set(groupKey, {
            productId: product?.id || b.productId || 0,
            articleCode: product?.articleCode || b.articleCode || b.baleCode || "",
            productName: product?.name || b.productName || "Unknown",
            productNameAr: product?.nameAr || null,
            category: categoryName,
            categoryId,
            quantity: qty,
            totalWeight: weight,
            totalCost: productionPrice,
            baleCount: 1,
            loadingCount: isLoading ? 1 : 0,
            sellingPrice,
            productionPrice,
            referenceNumbers: refNum ? [refNum] : [],
          });
        }
      }

      const result = Array.from(grouped.values()).sort((a, b) => a.productName.localeCompare(b.productName));
      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching factory location inventory:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Returns inventory with pending proforma reservations subtracted
  app.get("/api/factory/location-inventory/:locationId/available", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const locationId = parseId(req.params.locationId);

      if (locationId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });

      // --- stock (same logic as base endpoint) ---
      const bales = await db
        .select()
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            eq(factoryBales.erpLocationId, locationId),
            eq(factoryBales.status, "IN_STOCK"),
            // Exclude bales already assigned to active or completed outbound orders
            sql`NOT EXISTS (
              SELECT 1 FROM customer_order_bales cob
              INNER JOIN customer_orders co ON co.id = cob.order_id
              WHERE cob.bale_id = ${factoryBales.id}
                AND co.status IN ('LOADING','PENDING_VERIFICATION','VERIFIED','FINALIZED','DISPATCHED','SOLD')
                AND co.company_id = ${companyId}
                AND co.deleted_at IS NULL
            )`
          )
        );

      const allProducts = await db
        .select()
        .from(factoryBaleProducts)
        .where(eq(factoryBaleProducts.companyId, companyId));
      const categoryIds = [...new Set(allProducts.map((p) => p.categoryId).filter((id): id is number => id != null))];
      const categories =
        categoryIds.length > 0
          ? await db
              .select()
              .from(factoryCategories)
              .where(and(eq(factoryCategories.companyId, companyId), inArray(factoryCategories.id, categoryIds)))
          : [];
      const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
      const productById = new Map(allProducts.map((p) => [p.id, p]));
      const productByArticleCode = new Map(
        allProducts.filter((p) => p.articleCode).map((p) => [p.articleCode!.toLowerCase(), p])
      );
      const getProduct = (bale: (typeof bales)[number]) => {
        const byId = bale.productId ? productById.get(bale.productId) : undefined;
        if (byId) return byId;
        return bale.articleCode ? productByArticleCode.get(bale.articleCode.toLowerCase()) : undefined;
      };

      const grouped = new Map<
        string,
        {
          productId: number;
          articleCode: string;
          productName: string;
          productNameAr: string | null;
          category: string | null;
          categoryId: number | null;
          quantity: number;
          totalWeight: number;
          totalCost: number;
          baleCount: number;
          sellingPrice: string;
          productionPrice: number;
        }
      >();

      for (const b of bales) {
        const product = getProduct(b);
        const groupKey = product ? `p:${product.id}` : `a:${b.articleCode || b.baleCode || "unknown"}`;
        const existing = grouped.get(groupKey);
        const qty = amount(b.quantity, "1").toNumber();
        const weight = amount(b.weightKg).toNumber();
        const productionPrice = amount(product?.productionPrice).toNumber();
        const sellingPrice = String(product?.sellingPrice || "0");
        const categoryName = product?.categoryId
          ? categoryMap.get(product.categoryId) || b.category || null
          : b.category || null;
        const categoryId = product?.categoryId || null;
        if (existing) {
          existing.quantity = plus(existing.quantity, qty);
          existing.totalWeight = plus(existing.totalWeight, weight);
          existing.totalCost = plus(existing.totalCost, productionPrice);
          existing.baleCount += 1;
        } else {
          grouped.set(groupKey, {
            productId: product?.id || b.productId || 0,
            articleCode: product?.articleCode || b.articleCode || b.baleCode || "",
            productName: product?.name || b.productName || "Unknown",
            productNameAr: product?.nameAr || null,
            category: categoryName,
            categoryId,
            quantity: qty,
            totalWeight: weight,
            totalCost: productionPrice,
            baleCount: 1,
            sellingPrice,
            productionPrice,
          });
        }
      }

      // Return stock as-is — no reservation subtraction
      const result = Array.from(grouped.values())
        .map((item) => {
          return { ...item, reservedQty: 0, availableQty: item.baleCount, reservations: [] };
        })
        .sort((a, b) => a.productName.localeCompare(b.productName));

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching available factory location inventory:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
