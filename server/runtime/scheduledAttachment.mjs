import { createWriteStream, mkdirSync, openSync, closeSync, writeSync, readFileSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";

const INSTALL_KEY = Symbol.for("erp.scheduled-attachment-bridge.installed");
const EXPORT_MARKER_KEY = Symbol.for("erp.export-buffer-bridge.marker");
const REQUEST_CONTEXT_KEY = Symbol.for("erp.export-buffer-bridge.request-context");
const PATCH_KEY = Symbol.for("erp.scheduled-attachment-bridge.patch");

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;

  const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const minimumBytes = parsePositiveInt(process.env.SCHEDULED_ATTACHMENT_MIN_BYTES, 128 * 1024);
  const cleanupDelayMs = parsePositiveInt(process.env.SCHEDULED_ATTACHMENT_CLEANUP_DELAY_MS, 15 * 60 * 1000);
  const orphanCleanupDelayMs = parsePositiveInt(
    process.env.SCHEDULED_ATTACHMENT_ORPHAN_CLEANUP_DELAY_MS,
    60 * 60 * 1000
  );
  const forceBridge = process.env.SCHEDULED_ATTACHMENT_FORCE === "1";
  const tempRoot = process.env.EXPORT_BRIDGE_TEMP_DIR || path.join(tmpdir(), "erp-export-bridge");

  function markerPayload(value) {
    return value && typeof value === "object" ? value[EXPORT_MARKER_KEY] : undefined;
  }

  function armCleanup(payload, delayMs = cleanupDelayMs) {
    if (!payload?.managedAttachment || !payload.path) return;
    if (payload.cleanupTimer) clearTimeout(payload.cleanupTimer);
    payload.cleanupTimer = setTimeout(() => {
      payload.cleanupTimer = undefined;
      void rm(payload.path, { force: true }).catch((error) => {
        if (error?.code !== "ENOENT") {
          console.warn(`[ScheduledAttachmentBridge] Failed to remove ${payload.path}:`, error?.message || error);
        }
      });
    }, delayMs);
    payload.cleanupTimer.unref?.();
  }

  function createMarker(payload) {
    const marker = Buffer.alloc(0);
    Object.defineProperty(marker, EXPORT_MARKER_KEY, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: payload,
    });
    return marker;
  }

  function createFileMarker(filePath, length, source) {
    const payload = {
      kind: "file",
      path: filePath,
      length,
      pathname: source,
      started: false,
      managedAttachment: true,
      cleanupDelayMs,
      cleanupTimer: undefined,
    };
    const marker = createMarker(payload);
    armCleanup(payload, orphanCleanupDelayMs);
    return marker;
  }

  function applicationStack() {
    return String(new Error().stack || "")
      .split("\n")
      .slice(2)
      .filter((line) => !line.includes("scheduledAttachmentBridge.mjs") && !line.includes("node:internal"));
  }

  function isKnownAttachmentConcat() {
    const lines = applicationStack();
    if (forceBridge) return Boolean(lines[0] && !lines[0].includes("node_modules"));
    const firstOwner = lines.find((line) => !line.includes("node_modules"));
    if (!firstOwner) return false;
    return /schedulerService|buildFullExportZip|generateStockPdf|exportRoutes/i.test(lines.join("\n"));
  }

  function isBackgroundWorkbookWrite() {
    if (forceBridge) return true;
    const requestStore = globalThis[REQUEST_CONTEXT_KEY]?.getStore?.();
    if (requestStore) return false;

    const stack = applicationStack().join("\n");
    if (/exportExcelService|streamCompanyWorkbookDirect/i.test(stack)) return false;
    return /schedulerService|scheduledExportArtifact|generateNetPositionExcel/i.test(stack);
  }

  function looksLikeZipOrPdf(list) {
    const first = list.find((part) => part && part.byteLength > 0);
    if (!first) return false;
    const bytes = Buffer.isBuffer(first) ? first : Buffer.from(first.buffer, first.byteOffset, first.byteLength);
    return (
      (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) ||
      (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "%PDF")
    );
  }

  function writeChunksToManagedFile(list, totalLength, label) {
    mkdirSync(tempRoot, { recursive: true });
    const filePath = path.join(tempRoot, `${Date.now()}-${randomUUID()}.attachment`);
    const fd = openSync(filePath, "wx");
    let written = 0;
    try {
      for (const part of list) {
        const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part.buffer, part.byteOffset, part.byteLength);
        let offset = 0;
        while (offset < buffer.length) {
          const count = writeSync(fd, buffer, offset, buffer.length - offset);
          if (count <= 0) throw new Error("Failed to write scheduled attachment chunk");
          offset += count;
          written += count;
        }
      }
    } catch (error) {
      closeSync(fd);
      void rm(filePath, { force: true });
      throw error;
    }
    closeSync(fd);

    if (Number.isFinite(totalLength) && written !== totalLength) {
      void rm(filePath, { force: true });
      throw new Error(`Scheduled attachment size mismatch (${totalLength} expected, ${written} written)`);
    }
    return createFileMarker(filePath, written, label);
  }

  const previousConcat = Buffer.concat;
  Buffer.concat = function scheduledAttachmentConcat(list, totalLength) {
    if (
      Array.isArray(list) &&
      list.length > 0 &&
      list.every((part) => Buffer.isBuffer(part) || part instanceof Uint8Array) &&
      isKnownAttachmentConcat() &&
      looksLikeZipOrPdf(list)
    ) {
      const length = Number.isFinite(totalLength) ? totalLength : list.reduce((sum, part) => sum + part.byteLength, 0);
      if (length >= minimumBytes) {
        return writeChunksToManagedFile(list, length, "scheduled-buffer-concat");
      }
    }
    return previousConcat.call(Buffer, list, totalLength);
  };
  Object.defineProperty(Buffer.concat, PATCH_KEY, { value: true });

  const excelNamespace = await import("exceljs");
  const ExcelJS = excelNamespace.default || excelNamespace;
  const Workbook = ExcelJS.Workbook || excelNamespace.Workbook;
  const probeWorkbook = new Workbook();
  const xlsxPrototype = Object.getPrototypeOf(probeWorkbook.xlsx);
  const previousWriteBuffer = xlsxPrototype.writeBuffer;
  const directWrite = xlsxPrototype.write;

  if (!previousWriteBuffer[PATCH_KEY]) {
    const scheduledWriteBuffer = async function scheduledAttachmentWriteBuffer(options) {
      if (!isBackgroundWorkbookWrite()) return previousWriteBuffer.call(this, options);

      await mkdir(tempRoot, { recursive: true });
      const filePath = path.join(tempRoot, `${Date.now()}-${randomUUID()}.xlsx`);
      const output = createWriteStream(filePath, { flags: "wx" });
      try {
        const writing = directWrite.call(this, output, options);
        await Promise.all([writing, finished(output)]);
        const info = await stat(filePath);
        if (!info.isFile() || info.size <= 0) throw new Error("Scheduled workbook attachment is empty");
        return createFileMarker(filePath, info.size, "scheduled-workbook");
      } catch (error) {
        output.destroy();
        await rm(filePath, { force: true }).catch(() => undefined);
        throw error;
      }
    };
    Object.defineProperty(scheduledWriteBuffer, PATCH_KEY, { value: true });
    xlsxPrototype.writeBuffer = scheduledWriteBuffer;
  }

  function materializeMarker(payload) {
    if (payload.kind === "file" && payload.path) {
      const buffer = readFileSync(payload.path);
      armCleanup(payload);
      return buffer;
    }
    if (payload.kind === "chunks" && Array.isArray(payload.chunks)) {
      const buffer = Buffer.allocUnsafe(payload.length);
      let offset = 0;
      for (const chunk of payload.chunks) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        part.copy(buffer, offset);
        offset += part.length;
      }
      return buffer;
    }
    throw new Error(`Unsupported deferred attachment marker: ${payload.kind}`);
  }

  const formDataNamespace = await import("form-data");
  const FormDataClass = formDataNamespace.default || formDataNamespace;
  const formPrototype = FormDataClass?.prototype;
  let originalFormGetBuffer;

  function materializeFormBuffer(form) {
    const streams = Array.isArray(form?._streams) ? form._streams : [];
    const restored = [];
    try {
      for (let index = 0; index < streams.length; index += 1) {
        const payload = markerPayload(streams[index]);
        if (!payload || payload.kind === "deferred-form") continue;
        restored.push([index, streams[index]]);
        streams[index] = materializeMarker(payload);
      }
      return originalFormGetBuffer.call(form);
    } finally {
      for (const [index, marker] of restored) streams[index] = marker;
    }
  }

  if (formPrototype?.getBuffer && !formPrototype.getBuffer[PATCH_KEY]) {
    originalFormGetBuffer = formPrototype.getBuffer;
    const patchedGetBuffer = function deferredScheduledAttachmentFormBuffer() {
      const streams = Array.isArray(this._streams) ? this._streams : [];
      const containsManagedAttachment = streams.some((entry) => {
        const payload = markerPayload(entry);
        return payload && payload.kind !== "deferred-form";
      });
      if (!containsManagedAttachment) return originalFormGetBuffer.call(this);
      return createMarker({ kind: "deferred-form", form: this });
    };
    Object.defineProperty(patchedGetBuffer, PATCH_KEY, { value: true });
    formPrototype.getBuffer = patchedGetBuffer;
  }

  const originalFetch = globalThis.fetch?.bind(globalThis);
  let uploadTail = Promise.resolve();

  async function withUploadSlot(work) {
    const previous = uploadTail;
    let release;
    uploadTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
    }
  }

  if (originalFetch && !globalThis.fetch[PATCH_KEY]) {
    const patchedFetch = async function scheduledAttachmentFetch(input, init) {
      const payload = markerPayload(init?.body);
      if (payload?.kind !== "deferred-form") return originalFetch(input, init);

      return withUploadSlot(async () => {
        const body = materializeFormBuffer(payload.form);
        return originalFetch(input, { ...init, body });
      });
    };
    Object.defineProperty(patchedFetch, PATCH_KEY, { value: true });
    globalThis.fetch = patchedFetch;
  }

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "INFO",
      message: "Scheduled attachment bridge enabled",
      module: "scheduled-attachment-bridge",
      minimumBytes,
      cleanupDelayMs,
      orphanCleanupDelayMs,
      forceBridge,
    })
  );
}
