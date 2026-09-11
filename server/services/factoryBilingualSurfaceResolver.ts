import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  normalizeFactoryArticleCode,
  resolveFactoryCategoryName,
  resolveFactoryProductLanguage,
  resolveFactorySnapshotProductName,
  type FactoryCatalogLanguage,
} from "@shared/factoryBilingualContract";

type CatalogRecord = {
  id: number;
  articleCode: string | null;
  name: string | null;
  nameAr: string | null;
  nameFr: string | null;
  description: string | null;
  descriptionAr: string | null;
  descriptionFr: string | null;
  categoryName: string | null;
  categoryNameAr: string | null;
  categoryNameFr: string | null;
};

type ResolveOptions = { mutateLegacyDisplayFields: boolean };

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result || null;
}
function numericId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function objectProductId(value: Record<string, unknown>): number | null {
  return numericId(value.productId ?? value.product_id ?? value.baleProductId ?? value.bale_product_id);
}
function objectArticleCode(value: Record<string, unknown>): string {
  return normalizeFactoryArticleCode(
    value.articleCode ?? value.article_code ?? value.productArticleCode ?? value.product_article_code
  );
}
function hasProductText(record: Record<string, unknown>): boolean {
  return [
    "productName",
    "productNameEn",
    "productNameAr",
    "productNameFr",
    "baleName",
    "baleNameEn",
    "baleNameAr",
    "baleNameFr",
    "product_name",
    "product_name_ar",
    "product_name_fr",
    "bale_name",
    "bale_name_ar",
    "bale_name_fr",
  ].some((key) => key in record);
}
function isCatalogProduct(record: Record<string, unknown>): boolean {
  return (
    Boolean(objectArticleCode(record)) &&
    ("name" in record ||
      "nameAr" in record ||
      "nameFr" in record ||
      "description" in record ||
      "descriptionAr" in record ||
      "descriptionFr" in record)
  );
}
function isCategoryRecord(record: Record<string, unknown>): boolean {
  return (
    !objectProductId(record) &&
    !objectArticleCode(record) &&
    "id" in record &&
    "name" in record &&
    ("nameAr" in record || "nameFr" in record || "nameEn" in record)
  );
}
function isResolvableRecord(record: Record<string, unknown>): boolean {
  return (
    (Boolean(objectProductId(record) || objectArticleCode(record)) &&
      (hasProductText(record) || isCatalogProduct(record))) ||
    isCategoryRecord(record)
  );
}
function visit(value: unknown, callback: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) return value.forEach((item) => visit(item, callback));
  if (!value || typeof value !== "object" || value instanceof Date || Buffer.isBuffer(value)) return;
  const record = value as Record<string, unknown>;
  if (isResolvableRecord(record)) callback(record);
  Object.values(record).forEach((child) => visit(child, callback));
}
function rowsFromResult(result: unknown): CatalogRecord[] {
  if (Array.isArray(result)) return result as CatalogRecord[];
  const candidate = result as { rows?: unknown } | null;
  return Array.isArray(candidate?.rows) ? (candidate.rows as CatalogRecord[]) : [];
}
async function loadCatalog(companyId: number, productIds: number[], articleCodes: string[]) {
  if (!productIds.length && !articleCodes.length)
    return { byId: new Map<number, CatalogRecord>(), byArticleCode: new Map<string, CatalogRecord>() };
  const productCondition = productIds.length
    ? sql`p.id IN (${sql.join(
        productIds.map((id) => sql`${id}`),
        sql`, `
      )})`
    : sql`FALSE`;
  const articleCondition = articleCodes.length
    ? sql`UPPER(BTRIM(COALESCE(p.article_code, ''))) IN (${sql.join(
        articleCodes.map((code) => sql`${code}`),
        sql`, `
      )})`
    : sql`FALSE`;
  const result = await db.execute(sql`
    SELECT p.id, p.article_code AS "articleCode", p.name, p.name_ar AS "nameAr", p.name_fr AS "nameFr",
      p.description, p.description_ar AS "descriptionAr", p.description_fr AS "descriptionFr",
      c.name AS "categoryName", c.name_ar AS "categoryNameAr", c.name_fr AS "categoryNameFr"
    FROM factory_bale_products p
    LEFT JOIN factory_categories c ON c.id = p.category_id AND c.company_id = p.company_id AND c.deleted_at IS NULL
    WHERE p.company_id = ${companyId} AND p.deleted_at IS NULL AND (${productCondition} OR ${articleCondition})
  `);
  const byId = new Map<number, CatalogRecord>();
  const byArticleCode = new Map<string, CatalogRecord>();
  for (const row of rowsFromResult(result)) {
    byId.set(Number(row.id), row);
    const normalized = normalizeFactoryArticleCode(row.articleCode);
    if (normalized && !byArticleCode.has(normalized)) byArticleCode.set(normalized, row);
  }
  return { byId, byArticleCode };
}
function firstText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const result = clean(record[key]);
    if (result) return result;
  }
  return null;
}
function setIfPresent(record: Record<string, unknown>, key: string, value: string): void {
  if (Object.prototype.hasOwnProperty.call(record, key)) record[key] = value;
}
function localizeCategory(record: Record<string, unknown>, language: FactoryCatalogLanguage): void {
  const english = clean(record.nameEn) ?? clean(record.name);
  const arabic = clean(record.nameAr);
  const french = clean(record.nameFr);
  const display = resolveFactoryCategoryName({ name: english, nameAr: arabic, nameFr: french }, language);
  record.language = language;
  record.direction = language === "ar" ? "rtl" : "ltr";
  record.displayName = display;
  record.displayCategoryName = display;
  if (!record.nameEn && english) record.nameEn = english;
}
function localizeRecord(
  record: Record<string, unknown>,
  catalog: CatalogRecord | null,
  language: FactoryCatalogLanguage,
  options: ResolveOptions
): void {
  if (isCategoryRecord(record)) return localizeCategory(record, language);
  const articleCode = objectArticleCode(record) || normalizeFactoryArticleCode(catalog?.articleCode);
  const englishSnapshot = firstText(record, [
    "productNameEn",
    "baleNameEn",
    "product_name_en",
    "bale_name_en",
    "productName",
    "baleName",
    "product_name",
    "bale_name",
  ]);
  const arabicSnapshot = firstText(record, ["productNameAr", "baleNameAr", "product_name_ar", "bale_name_ar"]);
  const frenchSnapshot = firstText(record, ["productNameFr", "baleNameFr", "product_name_fr", "bale_name_fr"]);
  let displayName = "";
  if (englishSnapshot || arabicSnapshot || frenchSnapshot) {
    displayName = resolveFactorySnapshotProductName({
      language,
      snapshot: {
        articleCode,
        productNameEn: englishSnapshot,
        productNameAr: arabicSnapshot,
        productNameFr: frenchSnapshot,
      },
      catalog: catalog
        ? { articleCode: catalog.articleCode, name: catalog.name, nameAr: catalog.nameAr, nameFr: catalog.nameFr }
        : null,
    });
  } else {
    const resolved = resolveFactoryProductLanguage(
      {
        articleCode,
        name: clean(record.name) ?? catalog?.name,
        nameAr: clean(record.nameAr) ?? catalog?.nameAr,
        nameFr: clean(record.nameFr) ?? catalog?.nameFr,
        description: clean(record.description) ?? catalog?.description,
        descriptionAr: clean(record.descriptionAr) ?? catalog?.descriptionAr,
        descriptionFr: clean(record.descriptionFr) ?? catalog?.descriptionFr,
        categoryName: firstText(record, ["categoryName", "category", "category_name"]) ?? catalog?.categoryName,
        categoryNameAr:
          firstText(record, ["categoryNameAr", "categoryAr", "category_name_ar"]) ?? catalog?.categoryNameAr,
        categoryNameFr:
          firstText(record, ["categoryNameFr", "categoryFr", "category_name_fr"]) ?? catalog?.categoryNameFr,
      },
      language
    );
    displayName = resolved.name;
    record.displayDescription = resolved.description;
    record.displayCategoryName = resolved.categoryName;
  }
  const displayCategory = resolveFactoryCategoryName(
    {
      name: firstText(record, ["categoryName", "category", "category_name"]) ?? catalog?.categoryName,
      nameAr: firstText(record, ["categoryNameAr", "categoryAr", "category_name_ar"]) ?? catalog?.categoryNameAr,
      nameFr: firstText(record, ["categoryNameFr", "categoryFr", "category_name_fr"]) ?? catalog?.categoryNameFr,
    },
    language,
    articleCode
  );
  record.language = language;
  record.direction = language === "ar" ? "rtl" : "ltr";
  if (articleCode && !clean(record.normalizedArticleCode)) record.normalizedArticleCode = articleCode;
  if (displayName) {
    record.displayName = displayName;
    record.displayProductName = displayName;
  }
  if (displayCategory) {
    record.displayCategory = displayCategory;
    record.displayCategoryName = displayCategory;
  }
  if (!options.mutateLegacyDisplayFields || !displayName) return;
  if (englishSnapshot && !record.productNameEn) record.productNameEn = englishSnapshot;
  if (arabicSnapshot && !record.productNameAr) record.productNameAr = arabicSnapshot;
  if (frenchSnapshot && !record.productNameFr) record.productNameFr = frenchSnapshot;
  ["productName", "baleName", "product_name", "bale_name"].forEach((key) => setIfPresent(record, key, displayName));
  if (isCatalogProduct(record)) {
    if (!record.nameEn) record.nameEn = clean(record.name) ?? catalog?.name ?? null;
    record.name = displayName;
  }
  if (displayCategory)
    ["category", "categoryName", "category_name"].forEach((key) => setIfPresent(record, key, displayCategory));
}
export async function resolveFactoryBilingualSurfacePayload(
  companyId: number,
  payload: unknown,
  language: FactoryCatalogLanguage,
  options: ResolveOptions
): Promise<unknown> {
  const productIds = new Set<number>();
  const articleCodes = new Set<string>();
  visit(payload, (record) => {
    const productId = objectProductId(record);
    const articleCode = objectArticleCode(record);
    if (productId) productIds.add(productId);
    if (articleCode) articleCodes.add(articleCode);
  });
  const catalog = await loadCatalog(companyId, [...productIds], [...articleCodes]);
  visit(payload, (record) => {
    const productId = objectProductId(record);
    const articleCode = objectArticleCode(record);
    const product =
      (productId ? catalog.byId.get(productId) : null) ??
      (articleCode ? catalog.byArticleCode.get(articleCode) : null) ??
      null;
    localizeRecord(record, product, language, options);
  });
  return payload;
}
