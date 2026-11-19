import type { Express } from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  locations,
  retailImportRowSchema,
  retailProductVariants,
  retailProducts,
  retailVariantInventory,
} from "@shared/schema";
import { retailStockMovements } from "@shared/schema/retailPos";
import { requireAuth, requireNonPOS } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { getOrCreateBrand } from "../services/retail/retailBrands";
import { trackRetailStockValueTx } from "../services/retail/retailInventoryJournal";
import { requireRetailCompany } from "./retailCompanyGuard";
import { asNumber, normalize } from "./retailRoutesLoadProducts";
import { registerRetailRoutesPart1 } from "./registerRetailRoutesPart1";

export function registerRetailRoutes(app: Express) {
  registerRetailRoutesPart1(app);
  registerRetailRoutesPart2(app);
}

function registerRetailRoutesPart2(app: Express) {
  app.post("/api/retail/import", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;

      const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const importBatchKey = String(
        req.body?.idempotencyKey || `retail-import-${Date.now()}-${req.user?.id ?? req.session.userId ?? "unknown"}`
      ).slice(0, 191);
      if (!rawRows.length) return res.status(400).json({ message: "No import rows supplied" });
      if (rawRows.length > 5000) {
        return res.status(400).json({ message: "Import is limited to 5,000 rows per file" });
      }

      const rows = rawRows.map((row: unknown) => retailImportRowSchema.parse(row));
      const uploadBarcodes = new Map<string, string>();
      const uploadVariantLocations = new Set<string>();

      for (const row of rows) {
        const barcodeKey = normalize(row.barcode);
        const variantKey = `${normalize(row.code)}|${normalize(row.color)}|${normalize(row.size)}`;
        const previousVariant = uploadBarcodes.get(barcodeKey);
        if (previousVariant && previousVariant !== variantKey) {
          throw new Error(`Barcode ${row.barcode} is assigned to more than one product/color/size in the file`);
        }
        uploadBarcodes.set(barcodeKey, variantKey);

        const stockKey = `${variantKey}|${normalize(row.location)}`;
        if (uploadVariantLocations.has(stockKey)) {
          throw new Error(
            `Duplicate product/color/size/location row: ${row.code} / ${row.color} / ${row.size} / ${row.location}`
          );
        }
        uploadVariantLocations.add(stockKey);
      }

      const result = await db.transaction(async (tx) => {
        const companyLocations = await tx
          .select({ id: locations.id, code: locations.code, name: locations.name })
          .from(locations)
          .where(and(eq(locations.companyId, companyId), eq(locations.active, true)));
        const locationMap = new Map<string, number>();
        for (const location of companyLocations) {
          locationMap.set(normalize(location.code), location.id);
          locationMap.set(normalize(location.name), location.id);
        }

        const existingBarcodeRows = await tx
          .select({
            id: retailProductVariants.id,
            barcode: retailProductVariants.barcode,
            productId: retailProductVariants.productId,
            color: retailProductVariants.color,
            size: retailProductVariants.size,
          })
          .from(retailProductVariants)
          .where(
            and(
              eq(retailProductVariants.companyId, companyId),
              inArray(
                retailProductVariants.barcode,
                rows.map((row: { barcode: string }) => row.barcode)
              )
            )
          );
        const existingByBarcode = new Map(
          existingBarcodeRows.map(
            (row: { id: number; barcode: string; productId: number; color: string; size: string }) => [
              normalize(row.barcode),
              row,
            ]
          )
        );

        const productCache = new Map<string, { id: number; name: string }>();
        const existingProducts = await tx
          .select({ id: retailProducts.id, code: retailProducts.code, name: retailProducts.name })
          .from(retailProducts)
          .where(eq(retailProducts.companyId, companyId));
        for (const product of existingProducts) productCache.set(normalize(product.code), product);

        const variantCache = new Map<string, { id: number; barcode: string }>();
        const allVariants = await tx
          .select({
            id: retailProductVariants.id,
            productId: retailProductVariants.productId,
            color: retailProductVariants.color,
            size: retailProductVariants.size,
            barcode: retailProductVariants.barcode,
          })
          .from(retailProductVariants)
          .where(eq(retailProductVariants.companyId, companyId));
        for (const variant of allVariants) {
          variantCache.set(`${variant.productId}|${normalize(variant.color)}|${normalize(variant.size)}`, {
            id: variant.id,
            barcode: variant.barcode,
          });
        }

        let productsCreated = 0;
        let variantsCreated = 0;
        let stockRowsWritten = 0;
        // Wave 17 (D): the import sets quantities and costs; once the Retail inventory
        // opening is applied the value it changed is journalled against
        // RETAIL-INVENTORY-ADJUSTMENT (one journal per import).
        const stockValue = await trackRetailStockValueTx(tx, companyId, []);

        for (const row of rows) {
          const locationId = locationMap.get(normalize(row.location));
          if (!locationId) throw new Error(`Unknown location for this company: ${row.location}`);

          const productKey = normalize(row.code);
          let product = productCache.get(productKey);
          const brand = await getOrCreateBrand(tx, companyId, row.brand);

          if (!product) {
            const [created] = await tx
              .insert(retailProducts)
              .values({
                companyId,
                code: row.code,
                name: row.name,
                brandId: brand.id,
                category: row.category || null,
                description: row.description || null,
                imageUrls: row.imageUrl ? [row.imageUrl] : [],
                active: true,
              })
              .returning({ id: retailProducts.id, name: retailProducts.name });
            product = created;
            productCache.set(productKey, product);
            productsCreated += 1;
          }

          const variantKey = `${product.id}|${normalize(row.color)}|${normalize(row.size)}`;
          let variant = variantCache.get(variantKey);
          const barcodeOwner = existingByBarcode.get(normalize(row.barcode));

          if (variant) {
            if (normalize(variant.barcode) !== normalize(row.barcode)) {
              throw new Error(`${row.color} / ${row.size} on ${row.code} already uses barcode ${variant.barcode}`);
            }
          } else {
            if (barcodeOwner) throw new Error(`Barcode already exists on another variant: ${row.barcode}`);

            const [createdVariant] = await tx
              .insert(retailProductVariants)
              .values({
                companyId,
                productId: product.id,
                color: row.color,
                size: row.size,
                barcode: row.barcode,
                barcodeSource: "import",
                imageUrls: row.variantImageUrl ? [row.variantImageUrl] : [],
                sku: `${row.code}-${row.color}-${row.size}`.slice(0, 191),
                cost: String(row.cost),
                sellingPrice: String(row.price),
                active: true,
              })
              .returning({ id: retailProductVariants.id, barcode: retailProductVariants.barcode });
            variant = createdVariant;
            variantCache.set(variantKey, variant);
            existingByBarcode.set(normalize(row.barcode), {
              id: createdVariant.id,
              barcode: createdVariant.barcode,
              productId: product.id,
              color: row.color,
              size: row.size,
            });
            variantsCreated += 1;
          }

          await stockValue.include([{ variantId: variant.id, locationId }]);
          const [previousInventory] = await tx
            .select({ quantity: retailVariantInventory.quantity })
            .from(retailVariantInventory)
            .where(
              and(
                eq(retailVariantInventory.companyId, companyId),
                eq(retailVariantInventory.variantId, variant.id),
                eq(retailVariantInventory.locationId, locationId)
              )
            )
            .limit(1);
          const quantityBefore = asNumber(previousInventory?.quantity);

          await tx
            .insert(retailVariantInventory)
            .values({
              companyId,
              variantId: variant.id,
              locationId,
              quantity: String(row.qty),
              averageCost: String(row.cost),
            })
            .onConflictDoUpdate({
              target: [retailVariantInventory.variantId, retailVariantInventory.locationId],
              set: {
                quantity: String(row.qty),
                averageCost: String(row.cost),
                updatedAt: new Date(),
              },
            });

          const importMovement: typeof retailStockMovements.$inferInsert = {
            companyId,
            variantId: variant.id,
            locationId,
            movementType: "import",
            quantityDelta: String(row.qty - quantityBefore),
            quantityBefore: String(quantityBefore),
            quantityAfter: String(row.qty),
            eventKey: `import:${importBatchKey}:${variant.id}:${locationId}`.slice(0, 255),
            referenceType: "retail_import",
            referenceId: importBatchKey,
            createdBy: req.user!.id,
            metadata: { productCode: row.code, color: row.color, size: row.size, barcode: row.barcode },
          };
          await tx
            .insert(retailStockMovements)
            .values(importMovement)
            .onConflictDoNothing({ target: [retailStockMovements.companyId, retailStockMovements.eventKey] });

          await tx
            .update(retailProductVariants)
            .set({
              cost: String(row.cost),
              sellingPrice: String(row.price),
              ...(row.variantImageUrl ? { imageUrls: [row.variantImageUrl] } : {}),
              updatedAt: new Date(),
            })
            .where(and(eq(retailProductVariants.id, variant.id), eq(retailProductVariants.companyId, companyId)));
          stockRowsWritten += 1;
        }

        await stockValue.post({
          kind: "import",
          sourceId: importBatchKey,
          description: `Retail stock import ${importBatchKey}`.slice(0, 255),
          actor: { userId: req.user!.id, username: req.user?.username ?? null },
        });
        return { rowsProcessed: rows.length, productsCreated, variantsCreated, stockRowsWritten };
      });

      res.json(result);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
