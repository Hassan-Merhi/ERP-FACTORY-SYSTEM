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
function resolveManagedExportPath(filePath: string): string;
function resolveManagedExportPath(filePath: string, allowMissing: true): string | undefined;
function resolveManagedExportPath(filePath: string, allowMissing = false): string | undefined {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  const filename = path.basename(resolved);
  const archiveRoot = path.resolve(os.tmpdir());
  const bridgeRoot = path.resolve(process.env.EXPORT_BRIDGE_TEMP_DIR || path.join(os.tmpdir(), "erp-export-bridge"));

  // Only the two server-created artifact families may be attached or removed.
  // Being anywhere beneath a writable /tmp directory is NOT sufficient.
  const isArchive = directory === archiveRoot && /^erp-export-[a-zA-Z0-9_-]+-\d{13}\.zip$/.test(filename);
  const isBridge =
    directory === bridgeRoot &&
    /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(xlsx|attachment)$/i.test(filename);
  if (!isArchive && !isBridge) throw new Error("EXPORT_PATH_ERR");

  const trustedRoot = fs.realpathSync.native(isArchive ? archiveRoot : bridgeRoot);
  if (fs.realpathSync.native(directory) !== trustedRoot) {
    throw new Error("EXPORT_PATH_ERR");
  }
  // Resolve a real file entry under a trusted root. The path used for the
  // filesystem operation is built from the OS directory entry, not the caller's
  // string; the caller only selects an exact, validated server artifact name.
  const entry = fs.readdirSync(trustedRoot, { withFileTypes: true }).find((item) => item.name === filename);
  if (!entry) {
    if (allowMissing) return undefined;
    throw new Error("EXPORT_PATH_ERR");
  }
  if (!entry.isFile()) throw new Error("EXPORT_PATH_ERR");

  const safePath = trustedRoot.endsWith(path.sep) ? trustedRoot + entry.name : trustedRoot + path.sep + entry.name;
  const metadata = fs.lstatSync(safePath);
  // Do not follow symbolic links or accept hard-linked files as export artifacts.
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("EXPORT_PATH_ERR");
  }
  if (path.dirname(fs.realpathSync.native(safePath)) !== trustedRoot) {
    throw new Error("EXPORT_PATH_ERR");
  }
  return safePath;
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
  const filePath = resolveManagedExportPath(marker.path, true);
  if (!filePath) return;

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
  const filePath = resolveManagedExportPath(marker.path, true);
  if (!filePath) return;
  await fs.promises.rm(filePath, { force: true }).catch((error: unknown) => {
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
