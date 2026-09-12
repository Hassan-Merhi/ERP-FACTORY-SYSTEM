import { randomUUID } from "crypto";

// ── Temporary file store for WhatsApp sendFileByUrl ──────────────────────────
export const tempPdfStore = new Map<string, { buffer: Buffer; expiresAt: number; contentType?: string; filename?: string }>();

export function storeTempFile(buffer: Buffer, contentType?: string, filename?: string): string {
  const id = randomUUID();
  tempPdfStore.set(id, { buffer, expiresAt: Date.now() + 10 * 60 * 1000, contentType, filename });
  setTimeout(() => tempPdfStore.delete(id), 10 * 60 * 1000);
  return id;
}

// keep old name as alias
export const storeTempPdf = storeTempFile;
