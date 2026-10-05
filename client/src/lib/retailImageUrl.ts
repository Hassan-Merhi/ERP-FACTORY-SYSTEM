/**
 * Retail product photos are stored in the company file store, but product rows
 * must never persist an environment-specific host name. Convert legacy absolute
 * /api/files/:id/preview URLs and current relative preview URLs to the dedicated
 * retail media route so the same photo keeps working across Render/Replit/custom
 * domains and for retail users who do not have the generic files.download permission.
 */
export function normalizeRetailImageUrl(value?: string | null): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  let path = raw;
  try {
    if (/^https?:\/\//i.test(raw)) path = new URL(raw).pathname;
    else path = raw.split(/[?#]/, 1)[0];
  } catch {
    return raw;
  }

  const storedPreview = path.match(/^\/api\/files\/(\d+)\/preview\/?$/);
  if (storedPreview) return `/api/retail/media/${storedPreview[1]}`;

  return raw;
}

export function normalizeRetailImageUrls(values?: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const src = normalizeRetailImageUrl(value);
    if (!src || seen.has(src)) continue;
    seen.add(src);
    normalized.push(src);
  }
  return normalized;
}
