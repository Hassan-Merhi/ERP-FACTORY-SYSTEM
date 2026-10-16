import fs from "fs";
import os from "os";
import path from "path";
import { logger } from "../lib/logger";

const EXPORT_MARKER_KEY = Symbol.for("erp.export-buffer-bridge.marker");
const DEFAULT_CLEANUP_DELAY_MS = 15 * 60 * 1000;

interface ExportFileMarkerPayload {
  kind: "file";
  path: string;
  length: number;
  managedAttachment?: boolean;
  cleanupDelayMs?: number;
  cleanupTimer?: NodeJS.Timeout;
}

export type ExportAttachmentSource =
  | Buffer
  | {
      filePath: string;
      sizeBytes: number;
    };

function getMarkerPayload(source: ExportAttachmentSource): ExportFileMarkerPayload | undefined {
  if (!Buffer.isBuffer(source)) return undefined;
  const payload = Reflect.get(source, EXPORT_MARKER_KEY) as ExportFileMarkerPayload | undefined;
  return payload?.kind === "file" && payload.path ? payload : undefined;
}

/**
 * File-backed export attachments are only ever written under the OS temp
 * directory (or the configured export bridge temp dir). Refuse any other path so
 * a malformed attachment source can never read or delete arbitrary files.
 */
function resolveManagedExportPath(filePath: string): string {
  // This is the traversal guard: the resolved path is checked against the managed roots below.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const resolved = path.resolve(filePath);
  const roots = [os.tmpdir(), process.env.EXPORT_BRIDGE_TEMP_DIR]
    .filter((root): root is string => Boolean(root))
    // Roots come from the OS temp dir and server configuration, not from requests.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    .map((root) => path.resolve(root) + path.sep);
  if (!roots.some((root) => resolved.startsWith(root))) {
    throw new Error("Invalid file path");
  }
  return resolved;
}

function getFileAttachment(source: ExportAttachmentSource): { filePath: string; sizeBytes: number } | undefined {
  const marker = getMarkerPayload(source);
  if (marker) return { filePath: resolveManagedExportPath(marker.path), sizeBytes: marker.length };
  if (!Buffer.isBuffer(source))
    return { filePath: resolveManagedExportPath(source.filePath), sizeBytes: source.sizeBytes };
  return undefined;
}

function requireBufferSource(source: ExportAttachmentSource): Buffer {
  if (!Buffer.isBuffer(source)) {
    throw new Error("Expected an in-memory export attachment");
  }
  return source;
}

export function armExportAttachmentCleanup(source: ExportAttachmentSource, delayMs = DEFAULT_CLEANUP_DELAY_MS): void {
  const marker = getMarkerPayload(source);
  if (!marker?.managedAttachment) return;
  const filePath = resolveManagedExportPath(marker.path);

  if (marker.cleanupTimer) clearTimeout(marker.cleanupTimer);
  marker.cleanupTimer = setTimeout(() => {
    marker.cleanupTimer = undefined;
    fs.promises.rm(filePath, { force: true }).catch((error: unknown) => {
      if ((error as { code?: string }).code !== "ENOENT") {
        logger.warn(`[ExportAttachment] Failed to remove managed attachment ${marker.path}:`, { error });
      }
    });
  }, marker.cleanupDelayMs ?? delayMs);
  marker.cleanupTimer.unref?.();
}

export async function releaseManagedExportAttachment(source: ExportAttachmentSource): Promise<void> {
  const marker = getMarkerPayload(source);
  if (!marker?.managedAttachment) return;
  if (marker.cleanupTimer) clearTimeout(marker.cleanupTimer);
  marker.cleanupTimer = undefined;
  await fs.promises.rm(resolveManagedExportPath(marker.path), { force: true }).catch((error: unknown) => {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  });
}

export function getExportAttachmentSize(source: ExportAttachmentSource): number {
  const file = getFileAttachment(source);
  return file ? file.sizeBytes : requireBufferSource(source).length;
}

export function toNodemailerAttachment(
  source: ExportAttachmentSource,
  filename: string,
  contentType: string
): { filename: string; contentType: string; content?: Buffer; path?: string } {
  const file = getFileAttachment(source);
  if (file) {
    armExportAttachmentCleanup(source);
    return { filename, contentType, path: file.filePath };
  }

  return { filename, contentType, content: requireBufferSource(source) };
}

export async function readExportAttachmentBuffer(source: ExportAttachmentSource): Promise<Buffer> {
  const file = getFileAttachment(source);
  if (!file) return requireBufferSource(source);
  armExportAttachmentCleanup(source);
  return fs.promises.readFile(file.filePath);
}

export async function assertExportAttachmentAvailable(source: ExportAttachmentSource): Promise<void> {
  const file = getFileAttachment(source);
  if (!file) {
    if (requireBufferSource(source).length <= 0) throw new Error("Export attachment is empty");
    return;
  }

  const stat = await fs.promises.stat(file.filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error("Export attachment file is unavailable or empty");
  if (stat.size !== file.sizeBytes) {
    throw new Error(`Export attachment size changed unexpectedly (${file.sizeBytes} expected, ${stat.size} found)`);
  }
}

let materializationTail: Promise<void> = Promise.resolve();

/**
 * Materialize at most one complete file-backed attachment at a time. This is
 * required for providers such as Green API that still require a complete
 * multipart Buffer. Ordinary in-memory POS and invoice attachments keep their
 * existing direct delivery path and are not added to the scheduled-export queue.
 */
export async function withSerializedExportAttachmentBuffer<T>(
  source: ExportAttachmentSource,
  work: (buffer: Buffer) => Promise<T>
): Promise<T> {
  if (!getFileAttachment(source)) {
    return work(requireBufferSource(source));
  }

  const previous = materializationTail;
  let release!: () => void;
  materializationTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    await assertExportAttachmentAvailable(source);
    const buffer = await readExportAttachmentBuffer(source);
    return await work(buffer);
  } finally {
    release();
  }
}
