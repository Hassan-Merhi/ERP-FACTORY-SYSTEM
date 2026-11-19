// Extracted from ./retailRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { and, asc, eq } from "drizzle-orm";
import { retailBrands, retailProducts, retailProductVariants, retailProductWriteSchema } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { validateRetailVariantPayload } from "../services/retail/retailProductValidation";
import { allocateRetailBarcodes } from "../services/retail/retailBarcodeService";
import {
  RetailStockConflictError,
  writeVariantInventoryWithMovement,
} from "../services/retail/retailProductStockWrites";
import { requireRetailCompany } from "./retailCompanyGuard";
import { registerRetailSupplierImportRoutes } from "./retailSupplierImportRoutes";
import { assertUniqueBarcodes, loadProducts, resolveBrand, validateLocations } from "./retailRoutesLoadProducts";
import { registerRetailRoutesPart2 } from "./registerRetailRoutesPart2";

export function registerRetailRoutesPart1(app: Express) {
  registerRetailSupplierImportRoutes(app);

  app.get("/api/retail/brands", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;

      const brands = await db
        .select()
        .from(retailBrands)
        .where(eq(retailBrands.companyId, companyId))
        .orderBy(asc(retailBrands.isNoBrand), asc(retailBrands.name));
      res.json(brands);
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerRetailRoutesPart2(app);

  app.patch("/api/retail/products/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;

      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ message: "Invalid product ID" });
      }

      const input = retailProductWriteSchema.parse(req.body);
      validateRetailVariantPayload(input);

      const productEditKey = `product-edit:${productId}:${Date.now()}:${req.user!.id}`;

      await db.transaction(async (tx) => {
        const [existingProduct] = await tx
          .select({ id: retailProducts.id })
          .from(retailProducts)
          .where(and(eq(retailProducts.id, productId), eq(retailProducts.companyId, companyId)))
          .limit(1);
        if (!existingProduct) throw new Error("Retail product not found");

        await validateLocations(tx, companyId, input);
        await assertUniqueBarcodes(tx, companyId, input.variants);

        const [duplicateCode] = await tx
          .select({ id: retailProducts.id })
          .from(retailProducts)
          .where(and(eq(retailProducts.companyId, companyId), eq(retailProducts.code, input.code)))
          .limit(1);
        if (duplicateCode && duplicateCode.id !== productId) {
          throw new Error(`Product code already exists: ${input.code}`);
        }

        const brand = await resolveBrand(tx, companyId, input);
        await tx
          .update(retailProducts)
          .set({
            code: input.code,
            name: input.name,
            brandId: brand.id,
            category: input.category || null,
            description: input.description || null,
            imageUrls: input.imageUrls,
            active: input.active,
            updatedAt: new Date(),
          })
          .where(and(eq(retailProducts.id, productId), eq(retailProducts.companyId, companyId)));

        const existingVariants = await tx
          .select({ id: retailProductVariants.id, barcode: retailProductVariants.barcode })
          .from(retailProductVariants)
          .where(and(eq(retailProductVariants.productId, productId), eq(retailProductVariants.companyId, companyId)));
        const submittedIds = new Set<number>();
        const generatedBarcodes = await allocateRetailBarcodes(
          tx,
          companyId,
          input.variants.filter((variant) => !variant.id && !variant.barcode).length
        );

        for (const variantInput of input.variants) {
          let variantId = variantInput.id;

          if (variantId) {
            const existingVariant = existingVariants.find((variant) => variant.id === variantId);
            if (!existingVariant) {
              throw new Error("Variant does not belong to this product");
            }
            submittedIds.add(variantId);
            // A blank barcode on an existing variant keeps its current identity; it is never regenerated.
            const barcodeChanged = Boolean(variantInput.barcode) && variantInput.barcode !== existingVariant.barcode;
            await tx
              .update(retailProductVariants)
              .set({
                color: variantInput.color,
                size: variantInput.size,
                ...(barcodeChanged ? { barcode: variantInput.barcode, barcodeSource: "manual" } : {}),
                imageUrls: variantInput.imageUrls,
                sku: variantInput.sku || null,
                cost: String(variantInput.cost),
                sellingPrice: String(variantInput.sellingPrice),
                lowStockThreshold: String(variantInput.lowStockThreshold),
                active: variantInput.active,
                updatedAt: new Date(),
              })
              .where(and(eq(retailProductVariants.id, variantId), eq(retailProductVariants.companyId, companyId)));
          } else {
            const [createdVariant] = await tx
              .insert(retailProductVariants)
              .values({
                companyId,
                productId,
                color: variantInput.color,
                size: variantInput.size,
                barcode: variantInput.barcode || generatedBarcodes.shift()!,
                barcodeSource: variantInput.barcode ? "manual" : "generated",
                imageUrls: variantInput.imageUrls,
                sku: variantInput.sku || null,
                cost: String(variantInput.cost),
                sellingPrice: String(variantInput.sellingPrice),
                lowStockThreshold: String(variantInput.lowStockThreshold),
                active: variantInput.active,
              })
              .returning({ id: retailProductVariants.id });
            variantId = createdVariant.id;
            submittedIds.add(variantId);
          }

          await writeVariantInventoryWithMovement(tx, {
            companyId,
            variantId,
            cost: variantInput.cost,
            stocks: variantInput.stocks,
            createdBy: req.user!.id,
            referenceType: "retail_product_edit",
            referenceId: String(productId),
            eventPrefix: productEditKey,
          });
        }

        const omitted = existingVariants.filter((variant) => !submittedIds.has(variant.id));
        for (const variant of omitted) {
          await tx
            .update(retailProductVariants)
            .set({ active: false, updatedAt: new Date() })
            .where(and(eq(retailProductVariants.id, variant.id), eq(retailProductVariants.companyId, companyId)));
        }
      });

      const [product] = await loadProducts(companyId, productId);
      res.json(product);
    } catch (error) {
      res.status(error instanceof RetailStockConflictError ? 409 : 400).json({ message: getErrorMessage(error) });
    }
  });
}
