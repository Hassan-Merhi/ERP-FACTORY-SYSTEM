// Extracted from ./factoryBilingualCatalogRoutes.ts
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { factoryBaleProducts, factoryCategories } from "@shared/schema";
import {
  parseFactoryCatalogLanguage,
  resolveFactoryProductLanguage,
  type FactoryCatalogLanguage,
} from "@shared/factoryBilingualContract";

const LANGUAGE_COOKIE = "factory_catalog_language";

function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function getRequestLanguage(req: import("express").Request): FactoryCatalogLanguage {
  return parseFactoryCatalogLanguage(
    req.query?.lang ?? req.headers?.["x-factory-catalog-language"] ?? readCookie(req.headers?.cookie, LANGUAGE_COOKIE),
    "en"
  );
}

export async function sendProductDetail(
  req: import("express").Request,
  res: import("express").Response,
  companyId: number,
  id: number
) {
  const language = getRequestLanguage(req);
  const [row] = await db
    .select({
      product: factoryBaleProducts,
      categoryName: factoryCategories.name,
      categoryNameAr: factoryCategories.nameAr,
    })
    .from(factoryBaleProducts)
    .leftJoin(
      factoryCategories,
      and(
        eq(factoryCategories.id, factoryBaleProducts.categoryId),
        eq(factoryCategories.companyId, companyId),
        isNull(factoryCategories.deletedAt)
      )
    )
    .where(and(eq(factoryBaleProducts.id, id), eq(factoryBaleProducts.companyId, companyId)))
    .limit(1);

  if (!row) return res.status(404).json({ message: "Product not found" });
  const resolved = resolveFactoryProductLanguage(
    { ...row.product, categoryName: row.categoryName, categoryNameAr: row.categoryNameAr },
    language
  );
  return res.json({
    ...row.product,
    nameEn: row.product.name,
    nameAr: row.product.nameAr,
    descriptionEn: row.product.description,
    descriptionAr: row.product.descriptionAr,
    categoryName: row.categoryName,
    categoryNameAr: row.categoryNameAr,
    displayName: resolved.name,
    displayDescription: resolved.description,
    displayCategoryName: resolved.categoryName,
    language,
  });
}
