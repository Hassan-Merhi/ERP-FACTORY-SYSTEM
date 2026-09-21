import { randomUUID } from "crypto";

// ── Temporary file store for WhatsApp sendFileByUrl ──────────────────────────
const TEMP_FILE_TTL_MS = 10 * 60 * 1000;
const TEMP_FILE_SWEEP_MS = 60 * 1000;
const DEFAULT_MAX_TEMP_FILES = 256;
const DEFAULT_MAX_TEMP_FILE_BYTES = 128 * 1024 * 1024;

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const maxTempFiles = positiveInteger(process.env.POS_TEMP_FILE_MAX_ENTRIES, DEFAULT_MAX_TEMP_FILES);
const maxTempFileBytes = positiveInteger(process.env.POS_TEMP_FILE_MAX_BYTES, DEFAULT_MAX_TEMP_FILE_BYTES);

export const tempPdfStore = new Map<
  string,
  { buffer: Buffer; expiresAt: number; contentType?: string; filename?: string }
>();

function pruneTempFiles(now = Date.now()): void {
  for (const [id, file] of tempPdfStore) {
    if (file.expiresAt <= now) tempPdfStore.delete(id);
  }

  let totalBytes = 0;
  for (const file of tempPdfStore.values()) totalBytes += file.buffer.byteLength;

  // Map preserves insertion order, so oldest temporary files are evicted first
  // under unusual burst load instead of allowing short-lived WhatsApp buffers
  // to consume the whole server heap until their TTL expires.
  while (tempPdfStore.size > maxTempFiles || totalBytes > maxTempFileBytes) {
    const oldest = tempPdfStore.entries().next();
    if (oldest.done) break;
    const [id, file] = oldest.value;
    totalBytes -= file.buffer.byteLength;
    tempPdfStore.delete(id);
  }
}

const tempFileSweepTimer = setInterval(() => pruneTempFiles(), TEMP_FILE_SWEEP_MS);
tempFileSweepTimer.unref?.();

export function storeTempFile(buffer: Buffer, contentType?: string, filename?: string): string {
  pruneTempFiles();
  const id = randomUUID();
  tempPdfStore.set(id, { buffer, expiresAt: Date.now() + TEMP_FILE_TTL_MS, contentType, filename });
  pruneTempFiles();
  return id;
}

// keep old name as alias
export const storeTempPdf = storeTempFile;
