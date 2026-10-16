/**
 * contentDisposition.ts
 *
 * Shared helper for building safe Content-Disposition headers for file downloads.
 */

export function sanitiseFilename(raw: string): string {
  return (
    raw
      .replace(/[^\x20-\x7E]/g, "_")
      .replace(/[\r\n\t]/g, "_")
      .replace(/["\\]/g, "")
      .replace(/[']/g, "")
      .replace(/[/\\*?:[\]<>|;]/g, "")
      .replace(/\s+/g, "_")
      .replace(/^[._]+|[._]+$/g, "")
      .trim() || "download"
  );
}

export function buildSafeFilename(parts: (string | number | null | undefined)[], ext?: string): string {
  const safe = parts
    .filter((part): part is string | number => part !== null && part !== undefined && String(part).trim().length > 0)
    .map((part) => sanitiseFilename(String(part)))
    .filter((part) => part.length > 0 && part !== "download");
  const base = safe.join("_") || "export";
  return ext ? `${base}.${ext}` : base;
}

export function contentDisposition(
  filenameWithExt: string,
  disposition: "attachment" | "inline" = "attachment"
): string {
  const safe = sanitiseFilename(filenameWithExt);
  const encoded = encodeRFC5987(filenameWithExt);
  return `${disposition}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

function encodeRFC5987(str: string): string {
  return encodeURIComponent(str)
    .replace(/%21/gi, "!")
    .replace(/%23/gi, "#")
    .replace(/%24/gi, "$")
    .replace(/%26/gi, "&")
    .replace(/%2B/gi, "+")
    .replace(/%2D/gi, "-")
    .replace(/%2E/gi, ".")
    .replace(/%5E/gi, "^")
    .replace(/%5F/gi, "_")
    .replace(/%60/gi, "`")
    .replace(/%7C/gi, "|")
    .replace(/%7E/gi, "~");
}
