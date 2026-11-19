// Extracted from ./ProductComparisonChartsStat.tsx

export type Metric = "bales" | "weight";

export interface BaleProductCatalogRow {
  id: number;
  code?: string | null;
  articleCode?: string | null;
  name?: string | null;
  nameAr?: string | null;
  nameFr?: string | null;
  categoryId?: number | null;
  active?: boolean | null;
}

export interface CategoryRow {
  id: number;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
}

export function normalizeArticle(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase();
}

export function localeFor(language: "en" | "ar" | "fr"): string {
  if (language === "ar") return "ar";
  if (language === "fr") return "fr-FR";
  return "en-US";
}

export type StatKind = "products" | "selected" | "compared" | "difference";

export type StatTone = "violet" | "blue" | "green" | "rose";
