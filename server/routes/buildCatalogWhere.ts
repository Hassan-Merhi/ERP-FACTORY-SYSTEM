// Extracted from ./retailCatalogRoutes.ts to keep that module under the source-size cap.
import { normalizeSearchText } from "@shared/searchNormalization";
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { companies } from "@shared/schema";
import { db } from "../db";

interface CatalogQuery {
  search: string;
  brandId?: number;
  noBrand: boolean;
  color: string;
  size: string;
  category: string;
  locationId?: number;
  archived: "exclude" | "include" | "only";
  stockStatus: "all" | "in" | "low" | "out";
  page: number;
  pageSize: number;
}

export interface CatalogProductRow {
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
  color: string | null;
  size: string | null;
  variant_image_urls: unknown;
  barcode: string | null;
  barcode_source: string | null;
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
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseCatalogQuery(req: Request): CatalogQuery {
  const page = positiveInteger(req.query.page) ?? 1;
  const pageSize = Math.min(positiveInteger(req.query.pageSize) ?? 60, 100);
  const stockStatusRaw = String(req.query.stockStatus ?? "all");
  const stockStatus = (["all", "in", "low", "out"] as const).includes(stockStatusRaw as CatalogQuery["stockStatus"])
    ? (stockStatusRaw as CatalogQuery["stockStatus"])
    : "all";

  return {
    search: normalize(req.query.search),
    brandId: positiveInteger(req.query.brandId),
    noBrand: req.query.brandId === "none",
    color: normalize(req.query.color),
    size: normalize(req.query.size),
    category: normalize(req.query.category),
    locationId: positiveInteger(req.query.locationId),
    archived: req.query.archived === "include" || req.query.archived === "only" ? req.query.archived : "exclude",
    stockStatus,
    page,
    pageSize,
  };
}

export async function requireRetailCompany(req: Request, res: Response): Promise<number | null> {
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

export function buildCatalogWhere(companyId: number, query: CatalogQuery) {
  const params: unknown[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const where: string[] = [`p.company_id = ${add(companyId)}`];
  // Archived styles keep their sales and movement history but are hidden from day-to-day browsing.
  if (query.archived === "exclude") where.push("p.active = true");
  if (query.archived === "only") {
    where.push(`(p.active = false OR EXISTS (
      SELECT 1 FROM retail_product_variants archived_variant
      WHERE archived_variant.company_id = p.company_id
        AND archived_variant.product_id = p.id
        AND archived_variant.active = false
    ))`);
  }

  if (query.search) {
    const token = add(`%${query.search}%`);
    const compactToken = add(`%${normalizeSearchText(query.search)}%`);
    where.push(`(
      LOWER(CONCAT_WS(' ', p.code, p.name, COALESCE(b.name, ''))) LIKE ${token}
      OR regexp_replace(
        lower(CONCAT_WS(' ', p.code, p.name, COALESCE(b.name, ''))),
        '[^[:alnum:]]+',
        '',
        'g'
      ) LIKE ${compactToken}
      OR EXISTS (
        SELECT 1
        FROM retail_product_variants search_variant
        WHERE search_variant.company_id = p.company_id
          AND search_variant.product_id = p.id
          AND search_variant.active = true
          AND (
            LOWER(CONCAT_WS(' ', search_variant.color, search_variant.size, search_variant.barcode, COALESCE(search_variant.sku, ''))) LIKE ${token}
            OR regexp_replace(
              lower(CONCAT_WS(' ', search_variant.color, search_variant.size, search_variant.barcode, COALESCE(search_variant.sku, ''))),
              '[^[:alnum:]]+',
              '',
              'g'
            ) LIKE ${compactToken}
          )
      )
    )`);
  }
  if (query.noBrand) where.push("p.brand_id IS NULL");
  else if (query.brandId) where.push(`p.brand_id = ${add(query.brandId)}`);
  if (query.category === "__uncategorized__") {
    where.push("NULLIF(BTRIM(p.category), '') IS NULL");
  } else if (query.category) {
    where.push(`LOWER(BTRIM(p.category)) = ${add(query.category)}`);
  }
  // Location, color, size and stock filters must refer to the SAME exact
  // variant. Independent EXISTS checks could show a size held in another
  // location and leave the selected location's item card empty.
  if (query.color || query.size || query.locationId || query.stockStatus !== "all") {
    const variantClauses: string[] = [
      "match_variant.company_id = p.company_id",
      "match_variant.product_id = p.id",
      "match_variant.active = true",
    ];
    if (query.color) variantClauses.push(`LOWER(match_variant.color) = ${add(query.color)}`);
    if (query.size) variantClauses.push(`LOWER(match_variant.size) = ${add(query.size)}`);
    if (query.locationId) {
      variantClauses.push(`EXISTS (
        SELECT 1 FROM retail_variant_inventory assigned_inventory
        WHERE assigned_inventory.company_id = match_variant.company_id
          AND assigned_inventory.variant_id = match_variant.id
          AND assigned_inventory.location_id = ${add(query.locationId)}
      )`);
    }
    if (query.stockStatus === "low") {
      const locationClause = query.locationId ? `AND low_inventory.location_id = ${add(query.locationId)}` : "";
      variantClauses.push(`EXISTS (
        SELECT 1 FROM retail_variant_inventory low_inventory
        WHERE low_inventory.company_id = match_variant.company_id
          AND low_inventory.variant_id = match_variant.id
          ${locationClause}
          AND low_inventory.quantity > 0
          AND low_inventory.quantity <= match_variant.low_stock_threshold
      )`);
    } else if (query.stockStatus === "in" || query.stockStatus === "out") {
      const locationClause = query.locationId ? `AND stock_inventory.location_id = ${add(query.locationId)}` : "";
      const comparator = query.stockStatus === "in" ? "> 0" : "<= 0";
      variantClauses.push(`COALESCE((
        SELECT SUM(stock_inventory.quantity)
        FROM retail_variant_inventory stock_inventory
        WHERE stock_inventory.company_id = match_variant.company_id
          AND stock_inventory.variant_id = match_variant.id
          ${locationClause}
      ), 0) ${comparator}`);
    }
    where.push(`EXISTS (
      SELECT 1 FROM retail_product_variants match_variant
      WHERE ${variantClauses.join(" AND ")}
    )`);
  }

  return { text: where.join(" AND "), params };
}
