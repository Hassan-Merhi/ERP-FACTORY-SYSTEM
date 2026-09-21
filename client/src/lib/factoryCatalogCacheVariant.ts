const FACTORY_LANGUAGE_COOKIE = "factory_catalog_language";

function normalizeLanguage(value: string | null | undefined): "en" | "ar" | "fr" | null {
  return value === "en" || value === "ar" || value === "fr" ? value : null;
}

function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return value.join("=");
    }
  }
  return null;
}

/**
 * Browser response caches sit below React Query, so invalidating React Query
 * alone is not enough when Factory catalog language changes. Include the same
 * language selectors the server understands in every Factory cache key.
 */
export function factoryCatalogLanguageCacheVariant(
  url: URL,
  headers: Headers,
  cookieHeader = typeof document !== "undefined" ? document.cookie : ""
): string {
  if (!url.pathname.startsWith("/api/factory/")) return "factory-catalog-language=none";

  const queryLanguage =
    normalizeLanguage(url.searchParams.get("lang")) ?? normalizeLanguage(url.searchParams.get("language"));
  const headerLanguage = normalizeLanguage(headers.get("x-factory-catalog-language"));
  const cookieLanguage = normalizeLanguage(readCookie(cookieHeader, FACTORY_LANGUAGE_COOKIE));
  const language = queryLanguage ?? headerLanguage ?? cookieLanguage ?? "en";

  return `factory-catalog-language=${language}`;
}
