import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { companies } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../auth";
import { db, pool } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";

interface CatalogQuery {
  search: string;
  brandId?: number;
  size: string;
  category: string;
  locationId?: number;
  stockStatus: "all" | "in" | "low" | "out";
  page: number;
  pageSize: number;
}

interface CatalogProductRow {
  product_id: number;
  code: string;
  name: string;
  category: string | null;
  description: string | null;
  image_urls: unknown;
  active: boolean;
  brand_id: number | null;
  brand_name: string | null;
  variant_id: number | null;
  size: string | null;
  barcode: string | null;
  sku: string | null;
  cost: string | number | null;
  selling_price: string | number | null;
  low_stock_threshold: string | number | null;
  variant_active: boolean | null;
  location_id: number | null;
  location_name: string | null;
  quantity: string | number | null;
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCatalogQuery(req: Request): CatalogQuery {
  const page = positiveInteger(req.query.page) ?? 1;
  const pageSize = Math.min(positiveInteger(req.query.pageSize) ?? 60, 100);
  const stockStatusRaw = String(req.query.stockStatus ?? "all");
  const stockStatus = (["all", "in", "low", "out"] as const).includes(
    stockStatusRaw as CatalogQuery["stockStatus"]
  )
    ? (stockStatusRaw as CatalogQuery["stockStatus"])
    : "all";

  return {
    search: normalize(req.query.search),
    brandId: positiveInteger(req.query.brandId),
    size: normalize(req.query.size),
    category: normalize(req.query.category),
    locationId: positiveInteger(req.query.locationId),
    stockStatus,
    page,
    pageSize,
  };
}

async function requireRetailCompany(req: Request, res: Response): Promise<number | null> {
  const companyId = Number(req.session.currentCompanyId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    res.status(400).json({ message: "No company selected" });
    return null;
  }

  const [company] = await db
    .select({ companyType: companies.companyType })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (!company || company.companyType !== "retail") {
    res.status(403).json({ message: "Retail catalog is only available for Retail / Variant Inventory companies" });
    return null;
  }

  return companyId;
}

function buildCatalogWhere(companyId: number, query: CatalogQuery) {
  const params: unknown[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const where: string[] = [`p.company_id = ${add(companyId)}`];

  if (query.search) {
    const token = add(`%${query.search}%`);
    where.push(
      `LOWER(CONCAT_WS(' ', p.code, p.name, COALESCE(b.name, ''))) LIKE ${token}`
    );
  }
  if (query.brandId) where.push(`p.brand_id = ${add(query.brandId)}`);
  if (query.category) where.push(`LOWER(COALESCE(p.category, '')) = ${add(query.category)}`);
  if (query.size) {
    where.push(`EXISTS (
      SELECT 1
      FROM retail_product_variants size_variant
      WHERE size_variant.company_id = p.company_id
        AND size_variant.product_id = p.id
        AND size_variant.active = true
        AND LOWER(size_variant.size) = ${add(query.size)}
    )`);
  }
  if (query.locationId) {
    where.push(`EXISTS (
      SELECT 1
      FROM retail_product_variants location_variant
      JOIN retail_variant_inventory location_inventory
        ON location_inventory.company_id = location_variant.company_id
       AND location_inventory.variant_id = location_variant.id
      WHERE location_variant.company_id = p.company_id
        AND location_variant.product_id = p.id
        AND location_variant.active = true
        AND location_inventory.location_id = ${add(query.locationId)}
    )`);
  }

  if (query.stockStatus === "low") {
    where.push(`EXISTS (
      SELECT 1
      FROM retail_product_variants low_variant
      JOIN retail_variant_inventory low_inventory
        ON low_inventory.company_id = low_variant.company_id
       AND low_inventory.variant_id = low_variant.id
      WHERE low_variant.company_id = p.company_id
        AND low_variant.product_id = p.id
        AND low_variant.active = true
        ${query.locationId ? `AND low_inventory.location_id = ${add(query.locationId)}` : ""}
        AND low_inventory.quantity > 0
        AND low_inventory.quantity <= low_variant.low_stock_threshold
    )`);
  } else if (query.stockStatus === "in" || query.stockStatus === "out") {
    const locationClause = query.locationId ? `AND stock_inventory.location_id = ${add(query.locationId)}` : "";
    const comparator = query.stockStatus === "in" ? "> 0" : "<= 0";
    where.push(`COALESCE((
      SELECT SUM(stock_inventory.quantity)
      FROM retail_product_variants stock_variant
      LEFT JOIN retail_variant_inventory stock_inventory
        ON stock_inventory.company_id = stock_variant.company_id
       AND stock_inventory.variant_id = stock_variant.id
       ${locationClause}
      WHERE stock_variant.company_id = p.company_id
        AND stock_variant.product_id = p.id
        AND stock_variant.active = true
    ), 0) ${comparator}`);
  }

  return { text: where.join(" AND "), params };
}

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
      size: string;
      barcode: string;
      sku: string | null;
      cost: number;
      sellingPrice: number;
      lowStockThreshold: number;
      active: boolean;
      quantity: number;
      stocks: Array<{ locationId: number; locationName: string; quantity: number }>;
    }>;
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
        imageUrls: Array.isArray(row.image_urls) ? row.image_urls.filter((value): value is string => typeof value === "string") : [],
        active: row.active,
        brand: { id: row.brand_id, name: row.brand_name ?? "Other / No Brand" },
        variants: [],
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
        size: row.size ?? "",
        barcode: row.barcode ?? "",
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
    product.availableSizes = activeVariants.map((variant) => variant.size);
    product.totalQuantity = activeVariants.reduce((sum, variant) => sum + variant.quantity, 0);
    const prices = activeVariants.map((variant) => variant.sellingPrice);
    product.minSellingPrice = prices.length ? Math.min(...prices) : 0;
    product.maxSellingPrice = prices.length ? Math.max(...prices) : 0;
  }

  return [...products.values()];
}

export function registerRetailCatalogRoutes(app: Express): void {
  app.get("/api/retail/catalog-facets", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;

      const [sizes, categories] = await Promise.all([
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
         ORDER BY LOWER(p.name), p.id
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
           v.size,
           v.barcode,
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
         ORDER BY ARRAY_POSITION($2::int[], p.id), v.size, l.name`,
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
