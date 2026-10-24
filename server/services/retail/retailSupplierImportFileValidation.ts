/** Minimal binary signature validation for already-uploaded company files.
 * The caller fetches just the first 48 Base64 chars, not whole images/PDFs.
 * MIME/size/company ownership are separately checked against stored_files.
 */
export const RETAIL_SUPPLIER_ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
]);

export const RETAIL_SUPPLIER_ALLOWED_INVOICE_TYPES = new Set([
  "application/pdf", "image/jpeg", "image/png",
]);

export function retailSupplierFileMagicMatches(mime: string, base64Head: string): boolean {
  if (!base64Head || !/^[A-Za-z0-9+/=]+$/.test(base64Head)) return false;
  const bytes = Buffer.from(base64Head, "base64");
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString("ascii");
  if (mime === "application/pdf") return bytes.length >= 5 && ascii(0, 5) === "%PDF-";
  if (mime === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/png") {
    return bytes.length >= 8 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n);
  }
  if (mime === "image/webp") {
    return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  }
  if (mime === "image/gif") {
    return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6));
  }
  return false;
}
