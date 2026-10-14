export const FACTORY_CATALOG_LANGUAGES = ["en", "ar", "fr"] as const;

export type FactoryCatalogLanguage = (typeof FACTORY_CATALOG_LANGUAGES)[number];

export const FACTORY_ARABIC_IMPORT_MODES = ["fill-missing", "replace-existing"] as const;

export type FactoryArabicImportMode = (typeof FACTORY_ARABIC_IMPORT_MODES)[number];

export interface FactoryLocalizedTextSource {
  english?: string | null;
  arabic?: string | null;
  french?: string | null;
  articleCode?: string | null;
}

export interface FactoryBilingualProductSource {
  articleCode?: string | null;
  name?: string | null;
  nameAr?: string | null;
  nameFr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
  descriptionFr?: string | null;
}

export interface FactoryBilingualCategorySource {
  name?: string | null;
  nameAr?: string | null;
  nameFr?: string | null;
}

export interface FactoryBilingualProductDisplaySource extends FactoryBilingualProductSource {
  categoryName?: string | null;
  categoryNameAr?: string | null;
  categoryNameFr?: string | null;
}

export interface FactoryResolvedProductLanguage {
  language: FactoryCatalogLanguage;
  articleCode: string;
  name: string;
  categoryName: string;
  description: string;
}

export interface FactoryBilingualProductSnapshot {
  articleCode: string;
  productNameEn: string | null;
  productNameAr: string | null;
  productNameFr: string | null;
  categoryNameEn: string | null;
  categoryNameAr: string | null;
  categoryNameFr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  descriptionFr: string | null;
}

export interface FactoryArabicTranslationImportRow {
  articleCode: string;
  productNameAr: string | null;
  categoryNameAr: string | null;
  descriptionAr: string | null;
}

export interface FactorySnapshotResolutionInput {
  language: FactoryCatalogLanguage;
  snapshot: Pick<FactoryBilingualProductSnapshot, "articleCode" | "productNameEn" | "productNameAr" | "productNameFr">;
  catalog?: FactoryBilingualProductSource | null;
}

function cleanOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeFactoryArticleCode(value: unknown): string {
  const cleaned = cleanOptionalText(value);
  return cleaned ? cleaned.toUpperCase() : "";
}

export function parseFactoryCatalogLanguage(
  value: unknown,
  fallback: FactoryCatalogLanguage = "en"
): FactoryCatalogLanguage {
  return value === "en" || value === "ar" || value === "fr" ? value : fallback;
}

export function parseFactoryArabicImportMode(
  value: unknown,
  fallback: FactoryArabicImportMode = "fill-missing"
): FactoryArabicImportMode {
  return value === "fill-missing" || value === "replace-existing" ? value : fallback;
}

export function resolveFactoryLocalizedText(
  source: FactoryLocalizedTextSource,
  language: FactoryCatalogLanguage
): string {
  const english = cleanOptionalText(source.english);
  const arabic = cleanOptionalText(source.arabic);
  const french = cleanOptionalText(source.french);
  const articleCode = normalizeFactoryArticleCode(source.articleCode);

  if (language === "ar") return arabic ?? english ?? french ?? articleCode;
  if (language === "fr") return french ?? english ?? arabic ?? articleCode;
  return english ?? french ?? arabic ?? articleCode;
}

export function resolveFactoryProductName(
  product: FactoryBilingualProductSource,
  language: FactoryCatalogLanguage
): string {
  return resolveFactoryLocalizedText(
    { english: product.name, arabic: product.nameAr, french: product.nameFr, articleCode: product.articleCode },
    language
  );
}

export function resolveFactoryProductDescription(
  product: FactoryBilingualProductSource,
  language: FactoryCatalogLanguage
): string {
  return resolveFactoryLocalizedText(
    {
      english: product.description,
      arabic: product.descriptionAr,
      french: product.descriptionFr,
      articleCode: product.articleCode,
    },
    language
  );
}

export function resolveFactoryCategoryName(
  category: FactoryBilingualCategorySource,
  language: FactoryCatalogLanguage,
  articleCode?: string | null
): string {
  return resolveFactoryLocalizedText(
    { english: category.name, arabic: category.nameAr, french: category.nameFr, articleCode },
    language
  );
}

export function resolveFactoryProductLanguage(
  product: FactoryBilingualProductDisplaySource,
  language: FactoryCatalogLanguage
): FactoryResolvedProductLanguage {
  return {
    language,
    articleCode: normalizeFactoryArticleCode(product.articleCode),
    name: resolveFactoryProductName(product, language),
    categoryName: resolveFactoryCategoryName(
      { name: product.categoryName, nameAr: product.categoryNameAr, nameFr: product.categoryNameFr },
      language,
      product.articleCode
    ),
    description: resolveFactoryProductDescription(product, language),
  };
}

export function factorySearchValues(product: FactoryBilingualProductDisplaySource): string[] {
  return [
    normalizeFactoryArticleCode(product.articleCode),
    cleanOptionalText(product.name),
    cleanOptionalText(product.nameAr),
    cleanOptionalText(product.nameFr),
    cleanOptionalText(product.categoryName),
    cleanOptionalText(product.categoryNameAr),
    cleanOptionalText(product.categoryNameFr),
  ].filter((value): value is string => Boolean(value));
}

export function resolveFactorySnapshotProductName(input: FactorySnapshotResolutionInput): string {
  const snapshotRequested = cleanOptionalText(
    input.language === "ar"
      ? input.snapshot.productNameAr
      : input.language === "fr"
        ? input.snapshot.productNameFr
        : input.snapshot.productNameEn
  );
  const snapshotOpposite =
    cleanOptionalText(input.snapshot.productNameEn) ??
    cleanOptionalText(input.snapshot.productNameAr) ??
    cleanOptionalText(input.snapshot.productNameFr);
  if (snapshotRequested) return snapshotRequested;
  if (snapshotOpposite) return snapshotOpposite;
  if (input.catalog) return resolveFactoryProductName(input.catalog, input.language);
  return normalizeFactoryArticleCode(input.snapshot.articleCode);
}

export function buildFactoryBilingualProductSnapshot(input: {
  product: FactoryBilingualProductSource;
  category?: FactoryBilingualCategorySource | null;
}): FactoryBilingualProductSnapshot {
  return {
    articleCode: normalizeFactoryArticleCode(input.product.articleCode),
    productNameEn: cleanOptionalText(input.product.name),
    productNameAr: cleanOptionalText(input.product.nameAr),
    productNameFr: cleanOptionalText(input.product.nameFr),
    categoryNameEn: cleanOptionalText(input.category?.name),
    categoryNameAr: cleanOptionalText(input.category?.nameAr),
    categoryNameFr: cleanOptionalText(input.category?.nameFr),
    descriptionEn: cleanOptionalText(input.product.description),
    descriptionAr: cleanOptionalText(input.product.descriptionAr),
    descriptionFr: cleanOptionalText(input.product.descriptionFr),
  };
}

export function normalizeFactoryArabicTranslationImportRow(input: {
  articleCode: unknown;
  productNameAr?: unknown;
  categoryNameAr?: unknown;
  descriptionAr?: unknown;
}): FactoryArabicTranslationImportRow {
  return {
    articleCode: normalizeFactoryArticleCode(input.articleCode),
    productNameAr: cleanOptionalText(input.productNameAr),
    categoryNameAr: cleanOptionalText(input.categoryNameAr),
    descriptionAr: cleanOptionalText(input.descriptionAr),
  };
}
