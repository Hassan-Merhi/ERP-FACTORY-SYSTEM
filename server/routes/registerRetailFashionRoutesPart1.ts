// Extracted from ./registerRetailFashionRoutes.ts
import type { Express } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  RETAIL_NO_BRAND_NAME,
  retailBrands,
  retailProducts,
  retailProductVariants,
  retailStockOperations,
} from "@shared/schema";
import { requireAuth, requireNonPOS } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { currentUserId, ensureCompanyLocation, requireRetailCompany } from "./pos/retailPosContext";
import { allocateRetailBarcodes } from "../services/retail/retailBarcodeService";
import { getOrCreateBrand } from "../services/retail/retailBrands";
import { addMovement, lockInventoryRow, setInventoryQuantity } from "../services/retail/retailStockLedger";
import { RETAIL_GRNI_ACCOUNT, trackRetailStockValueTx } from "../services/retail/retailInventoryJournal";
import { lineAmount } from "../lib/money";
import {
  RetailQuickAddConflictError,
  loadLabelRows,
  normalize,
  productCodeFor,
  retailQuickAddSchema,
  toNumber,
  validateQuickAddVariants,
} from "./validateQuickAddVariants";

export function registerRetailFashionRoutesPart1(app: Express) {
  /**
   * Camera-first intake: one style (brand + name) with one or more exact color/size
   * variants received into one location. An existing style with the same brand and
   * name is extended instead of duplicated.
   */
  app.post("/api/retail/quick-add", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const userId = currentUserId(req);
      const input = retailQuickAddSchema.parse(req.body);
      validateQuickAddVariants(input);
      await ensureCompanyLocation(companyId, input.locationId);

      const result = await db.transaction(async (tx) => {
        const [operation] = await tx
          .insert(retailStockOperations)
          .values({
            companyId,
            operationType: "quick_add",
            idempotencyKey: input.idempotencyKey,
            createdBy: userId,
            metadata: { locationId: input.locationId },
          })
          .onConflictDoNothing({ target: [retailStockOperations.companyId, retailStockOperations.idempotencyKey] })
          .returning({ id: retailStockOperations.id });
        if (!operation) {
          const [previous] = await tx
            .select({ referenceId: retailStockOperations.referenceId, metadata: retailStockOperations.metadata })
            .from(retailStockOperations)
            .where(
              and(
                eq(retailStockOperations.companyId, companyId),
                eq(retailStockOperations.idempotencyKey, input.idempotencyKey)
              )
            )
            .limit(1);
          const variantIds = Array.isArray(previous?.metadata?.variantIds)
            ? (previous.metadata.variantIds as number[])
            : [];
          return { replayed: true, productId: Number(previous?.referenceId ?? 0), variantIds, createdProduct: false };
        }

        let brand;
        if (input.brandId) {
          [brand] = await tx
            .select()
            .from(retailBrands)
            .where(and(eq(retailBrands.id, input.brandId), eq(retailBrands.companyId, companyId)))
            .limit(1);
          if (!brand) throw new Error("Brand not found for this company");
        } else {
          brand = await getOrCreateBrand(tx, companyId, input.brandName || RETAIL_NO_BRAND_NAME);
        }

        // Serialize intake for the same company style so two phones cannot create twin styles.
        const styleLockKey = "retail-style:" + companyId + ":" + brand.id;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${styleLockKey}))`);
        const [existingProduct] = await tx
          .select({ id: retailProducts.id, code: retailProducts.code, active: retailProducts.active })
          .from(retailProducts)
          .where(
            and(
              eq(retailProducts.companyId, companyId),
              eq(retailProducts.brandId, brand.id),
              sql`lower(regexp_replace(btrim(${retailProducts.name}), '\\s+', ' ', 'g')) = ${normalize(input.name)}`
            )
          )
          .limit(1);

        let productId: number;
        let createdProduct = false;
        if (existingProduct) {
          productId = existingProduct.id;
          if (!existingProduct.active) {
            await tx
              .update(retailProducts)
              .set({ active: true, updatedAt: new Date() })
              .where(eq(retailProducts.id, productId));
          }
        } else {
          let code = productCodeFor(brand.name, input.name);
          for (let attempt = 2; attempt < 50; attempt += 1) {
            const [clash] = await tx
              .select({ id: retailProducts.id })
              .from(retailProducts)
              .where(and(eq(retailProducts.companyId, companyId), eq(retailProducts.code, code)))
              .limit(1);
            if (!clash) break;
            code = productCodeFor(brand.name, input.name, `-${attempt}`);
          }
          const [created] = await tx
            .insert(retailProducts)
            .values({
              companyId,
              code,
              name: input.name,
              brandId: brand.id,
              category: input.category || null,
              description: input.description || null,
              imageUrls: [],
              active: true,
            })
            .returning({ id: retailProducts.id });
          productId = created.id;
          createdProduct = true;
        }

        const existingVariants = await tx
          .select({
            id: retailProductVariants.id,
            color: retailProductVariants.color,
            size: retailProductVariants.size,
            barcode: retailProductVariants.barcode,
            active: retailProductVariants.active,
          })
          .from(retailProductVariants)
          .where(and(eq(retailProductVariants.companyId, companyId), eq(retailProductVariants.productId, productId)));
        for (const variant of input.variants) {
          const clash = existingVariants.find(
            (row) =>
              normalize(row.color) === normalize(variant.color) && normalize(row.size) === normalize(variant.size)
          );
          if (clash) {
            throw new RetailQuickAddConflictError(
              `${variant.color} / ${variant.size} already exists for this style (barcode ${clash.barcode}). Use Receive stock to add quantity.`,
              { code: "VARIANT_EXISTS", variantId: clash.id, barcode: clash.barcode, productId }
            );
          }
        }

        const typedBarcodes = input.variants.map((variant) => variant.barcode).filter(Boolean);
        if (typedBarcodes.length) {
          const owners = await tx
            .select({ id: retailProductVariants.id, barcode: retailProductVariants.barcode })
            .from(retailProductVariants)
            .where(
              and(eq(retailProductVariants.companyId, companyId), inArray(retailProductVariants.barcode, typedBarcodes))
            );
          if (owners.length) {
            throw new RetailQuickAddConflictError(`Barcode already exists: ${owners[0].barcode}`, {
              code: "BARCODE_EXISTS",
              variantId: owners[0].id,
              barcode: owners[0].barcode,
            });
          }
        }

        const generated = await allocateRetailBarcodes(
          tx,
          companyId,
          input.variants.filter((variant) => !variant.barcode).length,
          new Set(typedBarcodes)
        );
        const variantIds: number[] = [];
        for (const variant of input.variants) {
          const barcode = variant.barcode || generated.shift()!;
          const [created] = await tx
            .insert(retailProductVariants)
            .values({
              companyId,
              productId,
              color: variant.color,
              size: variant.size,
              barcode,
              barcodeSource: variant.barcode ? "manual" : "generated",
              imageUrls: variant.imageUrls,
              sku: variant.sku || null,
              cost: String(variant.cost),
              sellingPrice: String(variant.sellingPrice),
              lowStockThreshold: String(variant.lowStockThreshold),
              active: true,
            })
            .returning({ id: retailProductVariants.id });
          variantIds.push(created.id);

          const stock = await lockInventoryRow(tx, companyId, created.id, input.locationId);
          // Wave 17 (D): the intake is journalled (Dr Retail inventory / Cr RETAIL-GRNI) once the opening is applied.
          const stockValue = await trackRetailStockValueTx(tx, companyId, [
            { variantId: created.id, locationId: input.locationId },
          ]);
          const after = stock.quantity + variant.quantity;
          await setInventoryQuantity(tx, companyId, created.id, input.locationId, after, variant.cost);
          if (variant.quantity > 0) {
            await addMovement(tx, {
              companyId,
              variantId: created.id,
              locationId: input.locationId,
              movementType: "receive",
              quantityDelta: variant.quantity,
              before: stock.quantity,
              after,
              eventKey: `quick-add:${operation.id}:${created.id}`,
              referenceType: "retail_quick_add",
              referenceId: operation.id,
              createdBy: userId,
              metadata: { reason: "New item intake", productId, barcode },
            });
          }
          await stockValue.post({
            kind: "intake",
            sourceId: `${operation.id}-${created.id}`,
            description: `Retail new item intake #${operation.id} · variant ${created.id}`,
            actor: { userId, username: req.user?.username ?? null },
            contra: [
              {
                accountCode: RETAIL_GRNI_ACCOUNT,
                amount: lineAmount(variant.quantity, variant.cost).negated(),
                narration: `Retail new item intake #${operation.id} · received not invoiced`,
              },
            ],
          });
        }

        await tx
          .update(retailStockOperations)
          .set({ referenceId: String(productId), metadata: { locationId: input.locationId, productId, variantIds } })
          .where(eq(retailStockOperations.id, operation.id));
        return { replayed: false, productId, variantIds, createdProduct };
      });

      const variants = result.variantIds.length ? await loadLabelRows(companyId, result.variantIds) : [];
      res.status(result.replayed ? 200 : 201).json({
        ...result,
        variants: variants.map((variant) => ({
          ...variant,
          sellingPrice: toNumber(variant.sellingPrice),
          // Units received in this intake, so the label dialog can print one tag per unit.
          receivedQuantity:
            input.variants.find(
              (entry) =>
                normalize(entry.color) === normalize(variant.color) && normalize(entry.size) === normalize(variant.size)
            )?.quantity ?? 0,
        })),
      });
    } catch (error) {
      if (error instanceof RetailQuickAddConflictError) {
        return res.status(409).json({ message: error.message, ...error.details });
      }
      const message = getErrorMessage(error);
      res.status(/duplicate key|unique/i.test(message) ? 409 : 400).json({ message });
    }
  });
}
