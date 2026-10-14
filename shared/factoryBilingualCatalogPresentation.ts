import {
  resolveFactoryProductDescription,
  resolveFactoryProductName,
  type FactoryCatalogLanguage,
} from "./factoryBilingualContract";

export interface FactoryCatalogProductPresentationSource {
  articleCode?: string | null;
  name?: string | null;
  nameAr?: string | null;
  description?: string | null;
  descriptionAr?: string | null;
  [key: string]: unknown;
}

export interface FactoryLegacyLocalizedEdit {
  body: Record<string, unknown>;
  deferredArabic: {
    nameAr?: string | null;
    descriptionAr?: string | null;
  };
}

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value.trim() || null : String(value).trim() || null;
}

/**
 * The legacy Bale Explorer edit form posts `name` and `description`. In Arabic
 * display mode those values represent Arabic fields and must never overwrite
 * the canonical English catalog text. The legacy route still processes every
 * language-neutral field while this helper defers the Arabic text update.
 */
export function mapFactoryLegacyProductEdit(
  input: Record<string, unknown>,
  language: FactoryCatalogLanguage
): FactoryLegacyLocalizedEdit {
  const body = { ...input };
  const deferredArabic: FactoryLegacyLocalizedEdit["deferredArabic"] = {};

  if (language === "ar") {
    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      deferredArabic.nameAr = optionalText(body.name);
      delete body.name;
    }
    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      deferredArabic.descriptionAr = optionalText(body.description);
      delete body.description;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "nameAr")) {
    deferredArabic.nameAr = optionalText(body.nameAr);
    delete body.nameAr;
  }
  if (Object.prototype.hasOwnProperty.call(body, "descriptionAr")) {
    deferredArabic.descriptionAr = optionalText(body.descriptionAr);
    delete body.descriptionAr;
  }

  return { body, deferredArabic };
}

/**
 * A localized form can display English/article-code fallback text when Arabic
 * is absent. Saving an unrelated price or weight change must not turn that
 * fallback into a real Arabic translation.
 */
export function suppressUnchangedFactoryArabicFallbacks(
  update: FactoryLegacyLocalizedEdit["deferredArabic"],
  current: FactoryCatalogProductPresentationSource
): FactoryLegacyLocalizedEdit["deferredArabic"] {
  const safe = { ...update };

  if (
    current.nameAr == null &&
    safe.nameAr !== undefined &&
    safe.nameAr === resolveFactoryProductName(current, "ar")
  ) {
    delete safe.nameAr;
  }

  if (
    current.descriptionAr == null &&
    safe.descriptionAr !== undefined &&
    safe.descriptionAr === resolveFactoryProductDescription(current, "ar")
  ) {
    delete safe.descriptionAr;
  }

  return safe;
}

