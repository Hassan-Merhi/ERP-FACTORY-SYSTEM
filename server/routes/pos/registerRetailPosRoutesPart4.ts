// Extracted from ./registerRetailPosRoutesPart1.ts
import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import type { Express } from "express";
import { and, eq, or } from "drizzle-orm";
import { retailBrands, retailProducts, retailProductVariants, retailVariantInventory } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { ensureCompanyLocation, requireRetailCompany, toNumber } from "./retailPosContext";
import { roundRetailMoney } from "../../services/retail/retailPricing";
import { bestPromotionForLine, listActiveRetailPromotions } from "../../services/retail/retailPromotions";
import { resolveRetailItemImages } from "../../services/retail/retailSaleService";

export function registerRetailPosRoutesPart4(app: Express) {
  app.get("/api/pos/retail/items", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const locationId = Number(req.query.locationId);
      if (!Number.isInteger(locationId) || locationId <= 0)
        return res.status(400).json({ message: "Location is required" });
      await ensureCompanyLocation(companyId, locationId);
      const search = String(req.query.search ?? "").trim();
      const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);

      const rows = await db
        .select({
          variantId: retailProductVariants.id,
          productId: retailProducts.id,
          code: retailProducts.code,
          name: retailProducts.name,
          brand: retailBrands.name,
          brandId: retailProducts.brandId,
          color: retailProductVariants.color,
          variantImageUrls: retailProductVariants.imageUrls,
          productImageUrls: retailProducts.imageUrls,
          size: retailProductVariants.size,
          sku: retailProductVariants.sku,
          barcode: retailProductVariants.barcode,
          price: retailProductVariants.sellingPrice,
          quantity: retailVariantInventory.quantity,
        })
        .from(retailProductVariants)
        .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
        .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
        .leftJoin(
          retailVariantInventory,
          and(
            eq(retailVariantInventory.variantId, retailProductVariants.id),
            eq(retailVariantInventory.locationId, locationId),
            eq(retailVariantInventory.companyId, companyId)
          )
        )
        .where(
          and(
            eq(retailProductVariants.companyId, companyId),
            eq(retailProducts.companyId, companyId),
            eq(retailProductVariants.active, true),
            eq(retailProducts.active, true),
            search
              ? or(
                  punctuationInsensitiveSearch(retailProducts.name, search),
                  punctuationInsensitiveSearch(retailProducts.code, search),
                  punctuationInsensitiveSearch(retailProductVariants.sku, search),
                  punctuationInsensitiveSearch(retailProductVariants.barcode, search),
                  punctuationInsensitiveSearch(retailProductVariants.color, search),
                  punctuationInsensitiveSearch(retailProductVariants.size, search),
                  punctuationInsensitiveSearch(retailBrands.name, search)
                )
              : undefined
          )
        )
        .orderBy(retailProducts.name, retailProductVariants.color, retailProductVariants.size)
        .limit(limit);

      const promotions = await listActiveRetailPromotions(companyId);
      res.json(
        rows.map((row) => {
          const { variantImageUrls, productImageUrls, ...rest } = row;
          const price = toNumber(row.price);
          const promotion = promotions.length
            ? bestPromotionForLine(
                promotions,
                { variantId: row.variantId, productId: row.productId, brandId: row.brandId ?? null },
                price
              )
            : null;
          const promotionRow = promotion ? (promotions.find((entry) => entry.id === promotion.id) ?? null) : null;
          const promotionPrice = promotion
            ? promotion.discountType === "percent"
              ? roundRetailMoney(price * (1 - promotion.value / 100), 2)
              : Math.max(0, roundRetailMoney(price - promotion.value, 2))
            : null;
          return {
            ...rest,
            imageUrls: resolveRetailItemImages(variantImageUrls, productImageUrls),
            brand: row.brand ?? "Other / No Brand",
            price,
            quantity: toNumber(row.quantity),
            promotion:
              promotion && promotionPrice !== null
                ? {
                    id: promotion.id,
                    name: promotionRow?.name ?? "Promotion",
                    discountType: promotion.discountType,
                    value: promotion.value,
                    promotionPrice,
                  }
                : null,
          };
        })
      );
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
