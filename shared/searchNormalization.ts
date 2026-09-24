/**
 * Canonical text normalization for user-facing search.
 *
 * Search deliberately ignores separators and punctuation so values such as
 * "AB-123.45", "AB 123 45", and "ab12345" all match each other.
 * It also keeps the existing multilingual normalization used by Factory.
 */

const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

function toAsciiDigit(digit: string): string {
  const code = digit.charCodeAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  return digit;
}

export function normalizeSearchText(value: unknown): string {
  if (value === null || value === undefined) return "";

  return String(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(ARABIC_INDIC_DIGITS, toAsciiDigit)
    .replace(/[آأإٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function searchIncludes(value: unknown, query: unknown): boolean {
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  return normalizeSearchText(value).includes(needle);
}

export function searchEquals(value: unknown, query: unknown): boolean {
  const needle = normalizeSearchText(query);
  return !!needle && normalizeSearchText(value) === needle;
}

export function searchAny(query: unknown, ...values: unknown[]): boolean {
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  return values.some((value) => normalizeSearchText(value).includes(needle));
}
