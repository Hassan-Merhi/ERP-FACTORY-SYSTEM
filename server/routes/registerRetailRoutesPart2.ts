// Extracted from ./registerRetailRoutesPart1.ts
import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { retailProducts, retailProductVariants, retailProductWriteSchema } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { validateRequest } from "../lib/validateRequest";
import { createRetailBrandInput, createRetailProductInput } from "./retailProductRouteSchemas";
import { validateRetailVariantPayload } from "../services/retail/retailProductValidation";
import { allocateRetailBarcodes } from "../services/retail/retailBarcodeService";
import { getOrCreateBrand } from "../services/retail/retailBrands";
import { writeVariantInventoryWithMovement } from "../services/retail/retailProductStockWrites";
import { requireRetailCompany } from "./retailCompanyGuard";
import { requireCreateOnlyVerifiedCreate } from "../services/security/createOnlyVerifiedCreates";
import {
  asNumber,
  assertUniqueBarcodes,
  filterProducts,
  loadProducts,
  resolveBrand,
  validateLocations,
} from "./retailRoutesLoadProducts";

export function registerRetailRoutesPart2(app: Express) {
  app.post(
    "/api/retail/brands",
    requireAuth,
    requireNonPOS,
    validateRequest(createRetailBrandInput),
    async (req, res) => {
      try {
        const companyId = await requireRetailCompany(req, res);
        if (!companyId) return;

        const name = String(req.body?.name ?? "").trim();
        if (!name) return res.status(400).json({ message: "Brand name is required" });

        const brand = await getOrCreateBrand(db, companyId, name);
        res.status(201).json(brand);
      } catch (error) {
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get("/api/retail/products", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;

      const products = await loadProducts(companyId);
      res.json(filterProducts(products, req.query));
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/products/:id", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;

      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ message: "Invalid product ID" });
      }

      const [product] = await loadProducts(companyId, id);
      if (!product) return res.status(404).json({ message: "Retail product not found" });
      res.json(product);
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/barcodes/:barcode", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;

      const barcode = String(req.params.barcode ?? "").trim();
      const [row] = await db
        .select({
          variantId: retailProductVariants.id,
          productId: retailProducts.id,
          code: retailProducts.code,
          name: retailProducts.name,
          color: retailProductVariants.color,
          size: retailProductVariants.size,
          imageUrls: retailProductVariants.imageUrls,
          barcode: retailProductVariants.barcode,
          sellingPrice: retailProductVariants.sellingPrice,
        })
        .from(retailProductVariants)
        .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
        .where(and(eq(retailProductVariants.companyId, companyId), eq(retailProductVariants.barcode, barcode)))
        .limit(1);

      if (!row) return res.status(404).json({ message: "Barcode not found" });
      res.json({ ...row, sellingPrice: asNumber(row.sellingPrice) });
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post(
    "/api/retail/products",
    requireAuth,
    requireNonPOS,
    requireCreateOnlyVerifiedCreate("retailProducts"),
    validateRequest(createRetailProductInput),
    async (req, res) => {
      try {
        const companyId = await requireRetailCompany(req, res);
        if (!companyId) return;

        const input = retailProductWriteSchema.parse(req.body);
        validateRetailVariantPayload(input);

        const productId = await db.transaction(async (tx) => {
          await validateLocations(tx, companyId, input);
          await assertUniqueBarcodes(tx, companyId, input.variants);

          const [duplicateCode] = await tx
            .select({ id: retailProducts.id })
            .from(retailProducts)
            .where(and(eq(retailProducts.companyId, companyId), eq(retailProducts.code, input.code)))
            .limit(1);
          if (duplicateCode) throw new Error(`Product code already exists: ${input.code}`);

          const brand = await resolveBrand(tx, companyId, input);
          const [product] = await tx
            .insert(retailProducts)
            .values({
              companyId,
              code: input.code,
              name: input.name,
              brandId: brand.id,
              category: input.category || null,
              description: input.description || null,
              imageUrls: input.imageUrls,
              active: input.active,
            })
            .returning({ id: retailProducts.id });

          const generatedBarcodes = await allocateRetailBarcodes(
            tx,
            companyId,
            input.variants.filter((variant) => !variant.barcode).length
          );
          for (const variantInput of input.variants) {
            const barcode = variantInput.barcode || generatedBarcodes.shift()!;
            const [variant] = await tx
              .insert(retailProductVariants)
              .values({
                companyId,
                productId: product.id,
                color: variantInput.color,
                size: variantInput.size,
                barcode,
                barcodeSource: variantInput.barcode ? "manual" : "generated",
                imageUrls: variantInput.imageUrls,
                sku: variantInput.sku || null,
                cost: String(variantInput.cost),
                sellingPrice: String(variantInput.sellingPrice),
                lowStockThreshold: String(variantInput.lowStockThreshold),
                active: variantInput.active,
              })
              .returning({ id: retailProductVariants.id });

            if (variantInput.stocks.length) {
              await writeVariantInventoryWithMovement(tx, {
                companyId,
                variantId: variant.id,
                cost: variantInput.cost,
                stocks: variantInput.stocks,
                createdBy: req.user!.id,
                referenceType: "retail_product_create",
                referenceId: String(product.id),
                eventPrefix: `product-create:${product.id}`,
              });
            }
          }

          return product.id;
        });

        const [product] = await loadProducts(companyId, productId);
        res.status(201).json(product);
      } catch (error) {
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );
}
