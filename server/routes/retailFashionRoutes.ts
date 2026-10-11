import type { Express } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  RETAIL_DEFAULT_COLOR,
  RETAIL_LABEL_LAYOUTS,
  RETAIL_NO_BRAND_NAME,
  retailImageUrlSchema,
  retailBrands,
  retailLabelPrintEvents,
  retailProductVariants,
  retailProducts,
  retailStockOperations,
  users,
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

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const toNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export class RetailQuickAddConflictError extends Error {
  readonly status = 409;
  constructor(
    message: string,
    readonly details: Record<string, unknown>
  ) {
    super(message);
  }
}

const quickAddVariantSchema = z.object({
  color: z.string().trim().min(1).max(100).optional().default(RETAIL_DEFAULT_COLOR),
  size: z.string().trim().min(1).max(100),
  quantity: z.coerce.number().finite().nonnegative().max(100000).optional().default(1),
  cost: z.coerce.number().finite().nonnegative().optional().default(0),
  sellingPrice: z.coerce.number().finite().nonnegative(),
  sku: z.string().trim().max(191).nullable().optional(),
  barcode: z.string().trim().max(191).optional().default(""),
  lowStockThreshold: z.coerce.number().finite().nonnegative().optional().default(0),
  imageUrls: z.array(retailImageUrlSchema).max(4).optional().default([]),
});

export const retailQuickAddSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(191),
  brandId: z.coerce.number().int().positive().nullable().optional(),
  brandName: z.string().trim().max(120).optional(),
  name: z.string().trim().min(1).max(240),
  category: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  locationId: z.coerce.number().int().positive(),
  variants: z.array(quickAddVariantSchema).min(1).max(100),
});

export type RetailQuickAddInput = z.infer<typeof retailQuickAddSchema>;

/** Rejects repeated color/size and repeated typed barcodes inside one quick-add submission. */
export function validateQuickAddVariants(input: RetailQuickAddInput): void {
  const keys = new Set<string>();
  const barcodes = new Set<string>();
  for (const variant of input.variants) {
    const key = `${normalize(variant.color)}|${normalize(variant.size)}`;
    if (keys.has(key)) throw new Error(`Duplicate color/size in this item: ${variant.color} / ${variant.size}`);
    keys.add(key);
    if (variant.barcode) {
      const barcode = variant.barcode.trim();
      if (barcodes.has(barcode)) throw new Error(`Duplicate barcode in this item: ${variant.barcode}`);
      barcodes.add(barcode);
    }
  }
}

function productCodeFor(brandName: string, name: string, suffix = "") {
  const identity = `${brandName}-${name}`
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `RTL-${identity || "item"}`.slice(0, 100 - suffix.length) + suffix;
}

const labelRequestSchema = z.object({
  layout: z.enum(RETAIL_LABEL_LAYOUTS),
  items: z
    .array(
      z.object({
        variantId: z.coerce.number().int().positive(),
        copies: z.coerce.number().int().min(1).max(500).optional().default(1),
      })
    )
    .min(1)
    .max(500),
});

async function loadLabelRows(companyId: number, variantIds: number[]) {
  return db
    .select({
      variantId: retailProductVariants.id,
      productId: retailProducts.id,
      name: retailProducts.name,
      brand: retailBrands.name,
      color: retailProductVariants.color,
      size: retailProductVariants.size,
      barcode: retailProductVariants.barcode,
      barcodeSource: retailProductVariants.barcodeSource,
      sku: retailProductVariants.sku,
      sellingPrice: retailProductVariants.sellingPrice,
      active: retailProductVariants.active,
    })
    .from(retailProductVariants)
    .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
    .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
    .where(and(eq(retailProductVariants.companyId, companyId), inArray(retailProductVariants.id, variantIds)));
}

export function registerRetailFashionRoutes(app: Express): void {
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

  /** Existing styles for a brand, so quick add can extend a style instead of re-creating it. */
  app.get("/api/retail/styles", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const brandId = Number(req.query.brandId);
      const rows = await db
        .select({ id: retailProducts.id, name: retailProducts.name, category: retailProducts.category })
        .from(retailProducts)
        .where(
          and(
            eq(retailProducts.companyId, companyId),
            Number.isInteger(brandId) && brandId > 0 ? eq(retailProducts.brandId, brandId) : undefined
          )
        )
        .orderBy(retailProducts.name)
        .limit(500);
      res.json(rows);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /**
   * Returns printable label data and records an audit row per variant. The
   * barcode printed is always the variant's stored barcode; printing never
   * issues or changes a barcode, so reprints keep the same identity.
   */
  app.post("/api/retail/labels", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const userId = currentUserId(req);
      const body = labelRequestSchema.parse(req.body);
      const copiesByVariant = new Map<number, number>();
      for (const item of body.items) {
        copiesByVariant.set(item.variantId, (copiesByVariant.get(item.variantId) ?? 0) + item.copies);
      }
      const variantIds = [...copiesByVariant.keys()];
      const rows = await loadLabelRows(companyId, variantIds);
      if (rows.length !== variantIds.length) return res.status(404).json({ message: "Retail variant not found" });

      const printed = await db
        .select({ variantId: retailLabelPrintEvents.variantId })
        .from(retailLabelPrintEvents)
        .where(
          and(eq(retailLabelPrintEvents.companyId, companyId), inArray(retailLabelPrintEvents.variantId, variantIds))
        )
        .groupBy(retailLabelPrintEvents.variantId);
      const printedBefore = new Set(printed.map((row) => row.variantId));

      await db.insert(retailLabelPrintEvents).values(
        rows.map((row) => ({
          companyId,
          variantId: row.variantId,
          barcode: row.barcode,
          copies: copiesByVariant.get(row.variantId) ?? 1,
          layout: body.layout,
          isReprint: printedBefore.has(row.variantId),
          createdBy: userId,
        }))
      );

      const order = new Map(variantIds.map((id, index) => [id, index]));
      res.status(201).json({
        layout: body.layout,
        labels: rows
          .sort((a, b) => (order.get(a.variantId) ?? 0) - (order.get(b.variantId) ?? 0))
          .map((row) => ({
            ...row,
            brand: row.brand ?? RETAIL_NO_BRAND_NAME,
            sellingPrice: toNumber(row.sellingPrice),
            copies: copiesByVariant.get(row.variantId) ?? 1,
            isReprint: printedBefore.has(row.variantId),
          })),
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/variants/:id/labels", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const variantId = Number(req.params.id);
      if (!Number.isInteger(variantId) || variantId <= 0) return res.status(400).json({ message: "Invalid variant" });
      const rows = await db
        .select({
          id: retailLabelPrintEvents.id,
          barcode: retailLabelPrintEvents.barcode,
          copies: retailLabelPrintEvents.copies,
          layout: retailLabelPrintEvents.layout,
          isReprint: retailLabelPrintEvents.isReprint,
          createdAt: retailLabelPrintEvents.createdAt,
          createdBy: users.username,
        })
        .from(retailLabelPrintEvents)
        .leftJoin(users, eq(users.id, retailLabelPrintEvents.createdBy))
        .where(and(eq(retailLabelPrintEvents.companyId, companyId), eq(retailLabelPrintEvents.variantId, variantId)))
        .orderBy(desc(retailLabelPrintEvents.createdAt))
        .limit(200);
      res.json(rows);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /**
   * Archive / restore. Archiving only hides an item from selling and browsing; it never
   * deletes the variant, its barcode, sales lines, returns or stock movements.
   */
  const activeSchema = z.object({ active: z.boolean() });

  app.patch("/api/retail/variants/:id/active", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const variantId = Number(req.params.id);
      if (!Number.isInteger(variantId) || variantId <= 0) return res.status(400).json({ message: "Invalid variant" });
      const { active } = activeSchema.parse(req.body);
      const [updated] = await db
        .update(retailProductVariants)
        .set({ active, updatedAt: new Date() })
        .where(and(eq(retailProductVariants.id, variantId), eq(retailProductVariants.companyId, companyId)))
        .returning({ id: retailProductVariants.id, productId: retailProductVariants.productId });
      if (!updated) return res.status(404).json({ message: "Retail variant not found" });
      if (active) {
        // Restoring a variant makes its style sellable again.
        await db
          .update(retailProducts)
          .set({ active: true, updatedAt: new Date() })
          .where(and(eq(retailProducts.id, updated.productId), eq(retailProducts.companyId, companyId)));
      }
      res.json({ id: updated.id, active });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/retail/products/:id/active", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ message: "Invalid product ID" });
      }
      const { active } = activeSchema.parse(req.body);
      const [updated] = await db
        .update(retailProducts)
        .set({ active, updatedAt: new Date() })
        .where(and(eq(retailProducts.id, productId), eq(retailProducts.companyId, companyId)))
        .returning({ id: retailProducts.id });
      if (!updated) return res.status(404).json({ message: "Retail product not found" });
      res.json({ id: updated.id, active });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
