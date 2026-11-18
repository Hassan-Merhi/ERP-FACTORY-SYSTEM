import type { Express } from "express";
import { and, eq } from "drizzle-orm";
import { storedFiles } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../auth";
import { db, pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import {
  buildCatalogWhere,
  numberValue,
  parseCatalogQuery,
  positiveInteger,
  requireRetailCompany,
  type CatalogProductRow,
} from "./buildCatalogWhere";

function assembleProducts(rows: CatalogProductRow[]) {
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
  const variants = new Map<number, Map<number, ProductResult["variants"][number]>>();

  for (const row of rows) {
    let product = products.get(row.product_id);
    if (!product) {
      product = {
        id: row.product_id,
        code: row.code,
        name: row.name,
        category: row.category,
        description: row.description,
        imageUrls: Array.isArray(row.image_urls)
          ? row.image_urls.filter((value): value is string => typeof value === "string")
          : [],
        active: row.active,
        brand: { id: row.brand_id, name: row.brand_name ?? "Other / No Brand" },
        variants: [],
        availableColors: [],
        availableSizes: [],
        totalQuantity: 0,
        minSellingPrice: 0,
        maxSellingPrice: 0,
      };
      products.set(row.product_id, product);
      variants.set(row.product_id, new Map());
    }

    if (!row.variant_id) continue;
    const productVariants = variants.get(row.product_id)!;
    let variant = productVariants.get(row.variant_id);
    if (!variant) {
      variant = {
        id: row.variant_id,
        color: row.color ?? "Default",
        size: row.size ?? "",
        imageUrls: Array.isArray(row.variant_image_urls)
          ? row.variant_image_urls.filter((value): value is string => typeof value === "string")
          : [],
        barcode: row.barcode ?? "",
        barcodeSource: row.barcode_source ?? "manual",
        sku: row.sku,
        cost: numberValue(row.cost),
        sellingPrice: numberValue(row.selling_price),
        lowStockThreshold: numberValue(row.low_stock_threshold),
        active: row.variant_active !== false,
        quantity: 0,
        stocks: [],
      };
      productVariants.set(row.variant_id, variant);
      product.variants.push(variant);
    }

    if (row.location_id) {
      const quantity = numberValue(row.quantity);
      variant.quantity += quantity;
      variant.stocks.push({
        locationId: row.location_id,
        locationName: row.location_name ?? "",
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

export function registerRetailCatalogRoutes(app: Express): void {
  // Product photos use the company file store, but retail users should not need
  // the generic files.download permission just to see catalog/POS imagery.
  // This endpoint is intentionally limited to image/* files in the selected
  // retail company and keeps legacy product-photo records working.
  app.get("/api/retail/media/:id", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;

      const fileId = positiveInteger(req.params.id);
      if (!fileId) return res.status(404).json({ message: "Image not found" });

      const [file] = await db
        .select({
          id: storedFiles.id,
          fileName: storedFiles.fileName,
          displayName: storedFiles.displayName,
          fileType: storedFiles.fileType,
          fileData: storedFiles.fileData,
        })
        .from(storedFiles)
        .where(and(eq(storedFiles.id, fileId), eq(storedFiles.companyId, companyId)))
        .limit(1);

      if (!file || !file.fileType?.startsWith("image/")) {
        return res.status(404).json({ message: "Image not found" });
      }

      const buffer = Buffer.from(file.fileData, "base64");
      res.setHeader("Content-Type", file.fileType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(file.displayName || file.fileName)}"`
      );
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(buffer);
      return;
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Location → category → brand browsing. Group the complete filtered catalog on the
  // server, not a paginated slice, so brands and categories never disappear on page 2.
  app.get("/api/retail/catalog-navigation", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const query = parseCatalogQuery(req);
      // Category and brand are drill-down selections; navigation must enumerate all
      // matches at the selected location under the other active search/stock filters.
      const where = buildCatalogWhere(companyId, { ...query, category: "", brandId: undefined, noBrand: false });
      const result = await pool.query<{
        category_key: string;
        category_name: string;
        brand_id: number | null;
        brand_name: string;
        product_count: string;
      }>(
        `SELECT
           COALESCE(LOWER(NULLIF(BTRIM(p.category), '')), '__uncategorized__') AS category_key,
           COALESCE(MIN(NULLIF(BTRIM(p.category), '')), 'Uncategorized') AS category_name,
           p.brand_id AS brand_id,
           COALESCE(b.name, 'Other / No Brand') AS brand_name,
           COUNT(*)::text AS product_count
         FROM retail_products p
         LEFT JOIN retail_brands b ON b.id = p.brand_id AND b.company_id = p.company_id
         WHERE ${where.text}
         GROUP BY COALESCE(LOWER(NULLIF(BTRIM(p.category), '')), '__uncategorized__'),
                  p.brand_id, b.name
         ORDER BY category_name, brand_name`,
        where.params
      );
      const categories = new Map<
        string,
        {
          key: string;
          name: string;
          productCount: number;
          brands: Array<{ key: string; id: number | null; name: string; productCount: number }>;
        }
      >();
      for (const row of result.rows) {
        let category = categories.get(row.category_key);
        if (!category) {
          category = { key: row.category_key, name: row.category_name, productCount: 0, brands: [] };
          categories.set(row.category_key, category);
        }
        const count = Number(row.product_count);
        category.productCount += count;
        category.brands.push({
          key: row.brand_id === null ? "none" : String(row.brand_id),
          id: row.brand_id,
          name: row.brand_name,
          productCount: count,
        });
      }
      res.json({ categories: [...categories.values()] });
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/catalog-facets", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;

      const [colors, sizes, categories] = await Promise.all([
        pool.query<{ color: string }>(
          `SELECT DISTINCT color
           FROM retail_product_variants
           WHERE company_id = $1 AND active = true AND NULLIF(BTRIM(color), '') IS NOT NULL
           ORDER BY color`,
          [companyId]
        ),
        pool.query<{ size: string }>(
          `SELECT DISTINCT size
           FROM retail_product_variants
           WHERE company_id = $1 AND active = true AND NULLIF(BTRIM(size), '') IS NOT NULL
           ORDER BY size`,
          [companyId]
        ),
        pool.query<{ category: string }>(
          `SELECT DISTINCT category
           FROM retail_products
           WHERE company_id = $1 AND active = true AND NULLIF(BTRIM(category), '') IS NOT NULL
           ORDER BY category`,
          [companyId]
        ),
      ]);

      res.json({
        colors: colors.rows.map((row) => row.color),
        sizes: sizes.rows.map((row) => row.size),
        categories: categories.rows.map((row) => row.category),
      });
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/retail/products-page", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const query = parseCatalogQuery(req);
      const where = buildCatalogWhere(companyId, query);

      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM retail_products p
         LEFT JOIN retail_brands b ON b.id = p.brand_id AND b.company_id = p.company_id
         WHERE ${where.text}`,
        where.params
      );
      const total = Number(countResult.rows[0]?.count ?? 0);
      const totalPages = total === 0 ? 0 : Math.ceil(total / query.pageSize);
      const safePage = totalPages === 0 ? 1 : Math.min(query.page, totalPages);
      const offset = (safePage - 1) * query.pageSize;
      const pageParams = [...where.params, query.pageSize, offset];
      const limitParam = `$${where.params.length + 1}`;
      const offsetParam = `$${where.params.length + 2}`;

      const idResult = await pool.query<{ id: number }>(
        `SELECT p.id
         FROM retail_products p
         LEFT JOIN retail_brands b ON b.id = p.brand_id AND b.company_id = p.company_id
         WHERE ${where.text}
         ORDER BY LOWER(COALESCE(b.name, '')), LOWER(p.name), p.id
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        pageParams
      );
      const productIds = idResult.rows.map((row) => row.id);
      if (!productIds.length) {
        return res.json({ items: [], total, page: safePage, pageSize: query.pageSize, totalPages });
      }

      const detailResult = await pool.query<CatalogProductRow>(
        `SELECT
           p.id AS product_id,
           p.code,
           p.name,
           p.category,
           p.description,
           p.image_urls,
           p.active,
           b.id AS brand_id,
           b.name AS brand_name,
           v.id AS variant_id,
           v.color,
           v.size,
           v.image_urls AS variant_image_urls,
           v.barcode,
           v.barcode_source,
           v.sku,
           v.cost,
           v.selling_price,
           v.low_stock_threshold,
           v.active AS variant_active,
           i.location_id,
           l.name AS location_name,
           i.quantity
         FROM retail_products p
         LEFT JOIN retail_brands b ON b.id = p.brand_id AND b.company_id = p.company_id
         LEFT JOIN retail_product_variants v ON v.product_id = p.id AND v.company_id = p.company_id
         LEFT JOIN retail_variant_inventory i ON i.variant_id = v.id AND i.company_id = p.company_id
         LEFT JOIN locations l ON l.id = i.location_id AND l.company_id = p.company_id
         WHERE p.company_id = $1 AND p.id = ANY($2::int[])
         ORDER BY ARRAY_POSITION($2::int[], p.id), v.color, v.size, l.name`,
        [companyId, productIds]
      );

      res.json({
        items: assembleProducts(detailResult.rows),
        total,
        page: safePage,
        pageSize: query.pageSize,
        totalPages,
      });
    } catch (error) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
