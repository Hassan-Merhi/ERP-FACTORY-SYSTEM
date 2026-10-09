import type { Express, Request, Response } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  companies,
  locations,
  retailBrands,
  retailImportRowSchema,
  RETAIL_DEFAULT_COLOR,
  RETAIL_NO_BRAND_NAME,
  retailProductVariants,
  retailProducts,
  retailProductWriteSchema,
  retailVariantInventory,
  type RetailProductWrite,
} from "@shared/schema";
import { retailStockMovements } from "@shared/schema/retailPos";
import { requireAuth, requireNonPOS } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { validateRetailVariantPayload } from "../services/retail/retailProductValidation";
import { allocateRetailBarcodes } from "../services/retail/retailBarcodeService";
import { getOrCreateBrand, type RetailQueryExecutor } from "../services/retail/retailBrands";
import {
  RetailStockConflictError,
  writeVariantInventoryWithMovement,
} from "../services/retail/retailProductStockWrites";
import { trackRetailStockValueTx } from "../services/retail/retailInventoryJournal";

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
const asNumber = (value: unknown) => Number(value ?? 0);

async function requireRetailCompany(req: Request, res: Response): Promise<number | null> {
  const companyId = req.session.currentCompanyId;
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return null;
  }

  const [company] = await db
    .select({ companyType: companies.companyType })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (!company || company.companyType !== "retail") {
    res.status(403).json({
      message: "Retail inventory is only available for Retail / Variant Inventory companies",
    });
    return null;
  }

  return companyId;
}

async function resolveBrand(executor: RetailQueryExecutor, companyId: number, input: RetailProductWrite) {
  if (input.brandId) {
    const [brand] = await executor
      .select()
      .from(retailBrands)
      .where(and(eq(retailBrands.id, input.brandId), eq(retailBrands.companyId, companyId)))
      .limit(1);

    if (!brand) throw new Error("Brand not found for this company");
    return brand;
  }

  return getOrCreateBrand(executor, companyId, input.brandName);
}

async function validateLocations(executor: RetailQueryExecutor, companyId: number, input: RetailProductWrite) {
  const ids = [...new Set(input.variants.flatMap((variant) => variant.stocks.map((stock) => stock.locationId)))];
  if (!ids.length) return;

  const valid = await executor
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.companyId, companyId), inArray(locations.id, ids)));
  const validIds = new Set(valid.map((row) => row.id));
  const invalid = ids.find((id) => !validIds.has(id));

  if (invalid) throw new Error(`Location ${invalid} does not belong to the selected company`);
}

async function assertUniqueBarcodes(
  executor: RetailQueryExecutor,
  companyId: number,
  variants: RetailProductWrite["variants"]
) {
  const barcodes = variants.map((variant) => variant.barcode.trim()).filter(Boolean);
  if (!barcodes.length) return;

  const existing = await executor
    .select({ id: retailProductVariants.id, barcode: retailProductVariants.barcode })
    .from(retailProductVariants)
    .where(and(eq(retailProductVariants.companyId, companyId), inArray(retailProductVariants.barcode, barcodes)));

  for (const row of existing) {
    const incoming = variants.find((variant) => variant.barcode.trim() === row.barcode);
    if (!incoming || incoming.id !== row.id) throw new Error(`Barcode already exists: ${row.barcode}`);
  }
}

async function loadProducts(companyId: number, productId?: number) {
  const whereClause = productId
    ? and(eq(retailProducts.companyId, companyId), eq(retailProducts.id, productId))
    : eq(retailProducts.companyId, companyId);

  const rows = await db
    .select({
      productId: retailProducts.id,
      code: retailProducts.code,
      name: retailProducts.name,
      category: retailProducts.category,
      description: retailProducts.description,
      imageUrls: retailProducts.imageUrls,
      active: retailProducts.active,
      brandId: retailBrands.id,
      brandName: retailBrands.name,
      variantId: retailProductVariants.id,
      color: retailProductVariants.color,
      size: retailProductVariants.size,
      variantImageUrls: retailProductVariants.imageUrls,
      barcode: retailProductVariants.barcode,
      barcodeSource: retailProductVariants.barcodeSource,
      sku: retailProductVariants.sku,
      cost: retailProductVariants.cost,
      sellingPrice: retailProductVariants.sellingPrice,
      lowStockThreshold: retailProductVariants.lowStockThreshold,
      variantActive: retailProductVariants.active,
      locationId: retailVariantInventory.locationId,
      locationName: locations.name,
      quantity: retailVariantInventory.quantity,
    })
    .from(retailProducts)
    .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
    .leftJoin(retailProductVariants, eq(retailProductVariants.productId, retailProducts.id))
    .leftJoin(retailVariantInventory, eq(retailVariantInventory.variantId, retailProductVariants.id))
    .leftJoin(locations, eq(locations.id, retailVariantInventory.locationId))
    .where(whereClause)
    .orderBy(
      asc(retailProducts.name),
      asc(retailProductVariants.color),
      asc(retailProductVariants.size),
      asc(locations.name)
    );

  type ProductResult = {
    id: number;
    code: string;
    name: string;
    category: string | null;
    description: string | null;
    imageUrls: string[];
    active: boolean;
    brand: { id: number | null; name: string };
    variants: Array<{
      id: number;
      color: string;
      size: string;
      imageUrls: string[];
      barcode: string;
      barcodeSource: string;
      sku: string | null;
      cost: number;
      sellingPrice: number;
      lowStockThreshold: number;
      active: boolean;
      quantity: number;
      stocks: Array<{ locationId: number; locationName: string; quantity: number }>;
    }>;
    availableColors: string[];
    availableSizes: string[];
    totalQuantity: number;
    minSellingPrice: number;
    maxSellingPrice: number;
  };

  const products = new Map<number, ProductResult>();
  const variantMaps = new Map<number, Map<number, ProductResult["variants"][number]>>();

  for (const row of rows) {
    let product = products.get(row.productId);
    if (!product) {
      product = {
        id: row.productId,
        code: row.code,
        name: row.name,
        category: row.category,
        description: row.description,
        imageUrls: Array.isArray(row.imageUrls) ? row.imageUrls : [],
        active: row.active,
        brand: { id: row.brandId ?? null, name: row.brandName ?? RETAIL_NO_BRAND_NAME },
        variants: [],
        availableColors: [],
        availableSizes: [],
        totalQuantity: 0,
        minSellingPrice: 0,
        maxSellingPrice: 0,
      };
      products.set(row.productId, product);
      variantMaps.set(row.productId, new Map());
    }

    if (!row.variantId) continue;

    const productVariantMap = variantMaps.get(row.productId)!;
    let variant = productVariantMap.get(row.variantId);
    if (!variant) {
      variant = {
        id: row.variantId,
        color: row.color ?? RETAIL_DEFAULT_COLOR,
        size: row.size ?? "",
        imageUrls: Array.isArray(row.variantImageUrls)
          ? row.variantImageUrls.filter((value): value is string => typeof value === "string")
          : [],
        barcode: row.barcode ?? "",
        barcodeSource: row.barcodeSource ?? "manual",
        sku: row.sku,
        cost: asNumber(row.cost),
        sellingPrice: asNumber(row.sellingPrice),
        lowStockThreshold: asNumber(row.lowStockThreshold),
        active: row.variantActive ?? true,
        quantity: 0,
        stocks: [],
      };
      productVariantMap.set(row.variantId, variant);
      product.variants.push(variant);
    }

    if (row.locationId) {
      const quantity = asNumber(row.quantity);
      variant.quantity += quantity;
      variant.stocks.push({
        locationId: row.locationId,
        locationName: row.locationName ?? "",
        quantity,
      });
    }
  }

  for (const product of products.values()) {
    const activeVariants = product.variants.filter((variant) => variant.active);
    product.availableColors = [...new Set(activeVariants.map((variant) => variant.color))];
    product.availableSizes = [...new Set(activeVariants.map((variant) => variant.size))];
    product.totalQuantity = activeVariants.reduce((sum, variant) => sum + variant.quantity, 0);
    const prices = activeVariants.map((variant) => variant.sellingPrice);
    product.minSellingPrice = prices.length ? Math.min(...prices) : 0;
    product.maxSellingPrice = prices.length ? Math.max(...prices) : 0;
  }

  return [...products.values()];
}

function filterProducts(products: Awaited<ReturnType<typeof loadProducts>>, query: Request["query"]) {
  const search = normalize(String(query.search ?? ""));
  const brandId = Number(query.brandId || 0);
  const color = normalize(String(query.color ?? ""));
  const size = normalize(String(query.size ?? ""));
  const category = normalize(String(query.category ?? ""));
  const locationId = Number(query.locationId || 0);
  const stockStatus = String(query.stockStatus ?? "all");

  return products.filter((product) => {
    if (
      search &&
      !normalize(
        `${product.code} ${product.name} ${product.brand.name} ${product.variants
          .map((variant) => `${variant.color} ${variant.size} ${variant.barcode} ${variant.sku ?? ""}`)
          .join(" ")}`
      ).includes(search)
    ) {
      return false;
    }
    if (brandId && product.brand.id !== brandId) return false;
    if (category && normalize(product.category ?? "") !== category) return false;
    if (color && !product.variants.some((variant) => normalize(variant.color) === color)) return false;
    if (size && !product.variants.some((variant) => normalize(variant.size) === size)) return false;
    if (
      locationId &&
      !product.variants.some((variant) => variant.stocks.some((stock) => stock.locationId === locationId))
    ) {
      return false;
    }
    if (stockStatus === "out" && product.totalQuantity !== 0) return false;
    if (
      stockStatus === "low" &&
      !product.variants.some((variant) => variant.quantity > 0 && variant.quantity <= variant.lowStockThreshold)
    ) {
      return false;
    }
    if (stockStatus === "in" && product.totalQuantity <= 0) return false;
    return true;
  });
}

export function registerRetailRoutes(app: Express) {
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

  app.post("/api/retail/brands", requireAuth, requireNonPOS, async (req, res) => {
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
  });

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

  app.post("/api/retail/products", requireAuth, requireNonPOS, async (req, res) => {
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
  });

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
