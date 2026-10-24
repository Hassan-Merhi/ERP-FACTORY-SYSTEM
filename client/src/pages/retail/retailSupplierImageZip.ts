import JSZip from "jszip";
import { MAX_IMAGE_BYTES, MAX_VARIANT_IMAGES } from "./retailInventoryTypes";
import type { RetailSupplierImportRow } from "./retailSupplierImportDraft";

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 6000;
const VALID_EXTENSIONS = /\.(jpe?g|png|webp|gif)$/i;
const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", gif: "image/gif",
};

export interface RetailSupplierImageArchive {
  filename: string;
  images: Map<string, File>;
  imageCount: number;
}

export interface RetailSupplierImageMatch {
  files: File[];
  errors: string[];
}

function normalizedFilename(value: string) {
  return value.replace(/\\/g, "/").split("/").pop()?.trim().toLocaleLowerCase("en") ?? "";
}

function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)))) return "image/gif";
  return null;
}

/** Browser-side ZIP extraction for preview. No images are uploaded until the atomic purchase flow exists. */
export async function readRetailSupplierImageZip(file: File): Promise<RetailSupplierImageArchive> {
  if (!/\.zip$/i.test(file.name) || file.size > MAX_ZIP_BYTES || !file.size) {
    throw new Error("Choose a valid image ZIP (maximum 50 MB).");
  }
  const zip = await JSZip.loadAsync(await file.arrayBuffer(), { createFolders: false });
  const entries = Object.values(zip.files).filter(entry => !entry.dir &&
    !entry.name.startsWith("__MACOSX/") && !entry.name.endsWith(".DS_Store"));
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error("ZIP contains too many files (maximum 6,000).");
  const images = new Map<string, File>();
  let declaredBytes = 0;
  for (const entry of entries) {
    // JSZip sanitizes paths. Reject originally unsafe paths instead of allowing ambiguous names.
    const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (/^(?:\/|[a-z]:)/i.test(original) || original.split(/[\\/]/).some(part => part === ".." || !part)) {
      throw new Error(`Unsafe image path in ZIP: ${entry.name}`);
    }
    if (!VALID_EXTENSIONS.test(entry.name)) continue;
    const filename = normalizedFilename(entry.name);
    if (!filename) continue;
    if (images.has(filename)) throw new Error(`Duplicate image filename in ZIP: ${filename}`);
    // Reject zip bombs before inflating a potentially large image.
    const metadata = entry as unknown as { _data?: { uncompressedSize?: number } };
    const declared = metadata._data?.uncompressedSize;
    if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared < 1 || declared > MAX_IMAGE_BYTES) {
      throw new Error(`Invalid or too-large image in ZIP: ${entry.name}`);
    }
    declaredBytes += declared;
    if (declaredBytes > MAX_ZIP_UNCOMPRESSED_BYTES) throw new Error("ZIP exceeds 100 MB of image data.");
    const bytes = await entry.async("uint8array");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(`Image too large: ${entry.name}`);
    const detectedMime = imageMime(bytes);
    const extension = filename.split(".").pop() ?? "";
    if (!detectedMime || MIME[extension] !== detectedMime) {
      throw new Error(`Image file extension/content mismatch: ${entry.name}`);
    }
    images.set(filename, new File([new Uint8Array(bytes)], filename, { type: detectedMime }));
  }
  if (!images.size) throw new Error("ZIP contains no supported JPG, PNG, WEBP or GIF images.");
  return { filename: file.name, images, imageCount: images.size };
}

export function matchRetailSupplierImages(
  rows: RetailSupplierImportRow[],
  archive: RetailSupplierImageArchive | null
): Map<number, RetailSupplierImageMatch> {
  const results = new Map<number, RetailSupplierImageMatch>();
  for (const row of rows) {
    const filenames = [row.mainImage, ...row.extraImages].filter(Boolean);
    const errors: string[] = [];
    const files: File[] = [];
    const seen = new Set<string>();
    if (filenames.length > MAX_VARIANT_IMAGES) {
      errors.push(`Maximum ${MAX_VARIANT_IMAGES} pictures per color/size variant`);
    }
    for (const candidate of filenames) {
      // HTTPS image URLs are left for later server-side validation; do not fetch remote content in the browser.
      if (/^https?:\/\//i.test(candidate)) {
        errors.push("Use image filenames from the ZIP, not external image URLs");
        continue;
      }
      const key = normalizedFilename(candidate);
      if (!key || !VALID_EXTENSIONS.test(key)) {
        errors.push(`Unsupported image filename: ${candidate}`);
        continue;
      }
      if (seen.has(key)) {
        errors.push(`Duplicate image reference: ${candidate}`);
        continue;
      }
      seen.add(key);
      if (!archive) {
        errors.push(`Upload the image ZIP to match: ${candidate}`);
        continue;
      }
      const found = archive.images.get(key);
      if (!found) errors.push(`Image not found in ZIP: ${candidate}`);
      else files.push(found);
    }
    results.set(row.rowNumber, { files, errors });
  }
  return results;
}
