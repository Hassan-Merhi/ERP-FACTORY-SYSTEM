import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES } from "./retailInventoryTypes";

const MAX_EDGE_PX = 1600;

/**
 * Phone cameras produce 3–12 MB photos. Downscale to a 1600px JPEG before upload
 * so intake stays fast on store Wi-Fi/mobile data. Falls back to the original
 * file when the browser cannot decode it.
 */
export async function compressRetailPhoto(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 1.5 * 1024 * 1024 && ALLOWED_IMAGE_TYPES.has(file.type)) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) return file;
    const name = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${name}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/** Uploads one photo to company file storage and returns a host-agnostic retail media URL. */
export async function uploadRetailPhoto(file: File): Promise<string> {
  const prepared = await compressRetailPhoto(file);
  if (!ALLOWED_IMAGE_TYPES.has(prepared.type)) throw new Error("Use JPG, PNG, WEBP or GIF images.");
  if (prepared.size > MAX_IMAGE_BYTES) throw new Error(`${prepared.name} is larger than 10 MB.`);
  const formData = new FormData();
  formData.append("file", prepared);
  const response = await fetch("/api/files/upload", { method: "POST", body: formData, credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id) throw new Error(body.message || `Could not upload ${prepared.name}`);
  return `/api/retail/media/${body.id}`;
}
