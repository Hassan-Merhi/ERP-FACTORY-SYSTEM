import { AsyncLocalStorage } from "node:async_hooks";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";

const BRIDGE_FLAG = Symbol.for("erp.export-buffer-bridge.installed");
const REQUEST_CONTEXT_KEY = Symbol.for("erp.export-buffer-bridge.request-context");
const RESPONSE_STATE_KEY = Symbol.for("erp.export-buffer-bridge.response-state");
const EXPORT_MARKER_KEY = Symbol.for("erp.export-buffer-bridge.marker");
const COORDINATOR_STATE_KEY = Symbol.for("erp.heavy-export-coordinator.state");
const COORDINATOR_CONTEXT_KEY = Symbol.for("erp.heavy-export-coordinator.context");

if (!globalThis[BRIDGE_FLAG]) {
  globalThis[BRIDGE_FLAG] = true;

  const requestContext = (globalThis[REQUEST_CONTEXT_KEY] ??= new AsyncLocalStorage());
  const slotContext = (globalThis[COORDINATOR_CONTEXT_KEY] ??= new AsyncLocalStorage());
  const coordinatorState = (globalThis[COORDINATOR_STATE_KEY] ??= { active: 0, queue: [] });

  const parsePositiveInt = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const maxConcurrent = () => parsePositiveInt(process.env.HEAVY_EXPORT_MAX_CONCURRENT, 1);
  const maxQueue = () => parsePositiveInt(process.env.HEAVY_EXPORT_MAX_QUEUE, 6);
  const waitTimeoutMs = () => parsePositiveInt(process.env.HEAVY_EXPORT_WAIT_TIMEOUT_MS, 15 * 60 * 1000);
  const chunkBridgeThreshold = parsePositiveInt(process.env.EXPORT_CHUNK_BRIDGE_MIN_BYTES, 128 * 1024);
  const staleFileMaxAgeMs = parsePositiveInt(process.env.EXPORT_BRIDGE_FILE_MAX_AGE_MS, 6 * 60 * 60 * 1000);
  const bridgeDisabled = process.env.EXPORT_BUFFER_BRIDGE_DISABLED === "1";
  const tempRoot = process.env.EXPORT_BRIDGE_TEMP_DIR || path.join(tmpdir(), "erp-export-bridge");

  globalThis.__erpExportCoordinatorSnapshot = () => ({
    active: coordinatorState.active,
    queued: coordinatorState.queue.length,
    oldestWaitMs: coordinatorState.queue.length
      ? Math.max(0, Date.now() - coordinatorState.queue[0].enqueuedAt)
      : 0,
    maxConcurrent: maxConcurrent(),
    maxQueue: maxQueue(),
  });

  function dispatchCoordinator() {
    while (coordinatorState.active < maxConcurrent() && coordinatorState.queue.length > 0) {
      const entry = coordinatorState.queue.shift();
      clearTimeout(entry.timeout);
      coordinatorState.active += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        coordinatorState.active = Math.max(0, coordinatorState.active - 1);
        dispatchCoordinator();
      });
    }
  }

  function acquireSlot(label) {
    if (coordinatorState.queue.length >= maxQueue() && coordinatorState.active >= maxConcurrent()) {
      return Promise.reject(
        new Error(
          `Export capacity reached (${coordinatorState.active} active, ${coordinatorState.queue.length} queued). Try again after the current export finishes.`
        )
      );
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = coordinatorState.queue.findIndex((entry) => entry.timeout === timeout);
        if (index >= 0) coordinatorState.queue.splice(index, 1);
        reject(
          new Error(`Timed out waiting for export capacity after ${Math.round(waitTimeoutMs() / 60000)} minutes.`)
        );
      }, waitTimeoutMs());
      timeout.unref?.();
      coordinatorState.queue.push({ label, enqueuedAt: Date.now(), resolve, reject, timeout });
      dispatchCoordinator();
    });
  }

  async function withSharedExportSlot(label, work) {
    if (slotContext.getStore()?.active === true) return work();
    const release = await acquireSlot(label);
    return slotContext.run({ active: true, label }, async () => {
      try {
        return await work();
      } finally {
        release();
      }
    });
  }

  function pathnameOf(req) {
    try {
      return new URL(req?.url || "/", "http://localhost").pathname;
    } catch {
      return req?.url || "/";
    }
  }

  function requestTargetOf(store) {
    return `${store?.pathname || ""} ${store?.req?.url || ""}`;
  }

  function headerValue(res, name) {
    const value = res?.getHeader?.(name);
    if (Array.isArray(value)) return value.join(",");
    return value == null ? "" : String(value);
  }

  function isExcludedDeliveryPath(pathname) {
    // Paths that produce lightweight static template files — bridge overhead is
    // unnecessary and the stream-based write used internally by the bridge fails
    // on ExcelJS 3.x, producing a 0-byte download.
    if (/import-template|export-template|blank-template/i.test(pathname)) return true;
    return /(?:send|email|mail|whatsapp|schedule|scheduled|notification)/i.test(pathname);
  }

  function looksLikeWorkbookDownload(store) {
    if (!store || bridgeDisabled || isExcludedDeliveryPath(requestTargetOf(store))) return false;
    const disposition = headerValue(store.res, "Content-Disposition").toLowerCase();
    const contentType = headerValue(store.res, "Content-Type").toLowerCase();
    const attachmentWorkbook =
      disposition.includes("attachment") &&
      (contentType.includes("spreadsheetml") || contentType.includes("excel") || disposition.includes(".xlsx"));
    if (attachmentWorkbook) return true;
    return (
      (store.req?.method === "GET" || store.req?.method === "HEAD") &&
      /(?:export|download|excel|xlsx|format=(?:excel|xlsx))/i.test(requestTargetOf(store))
    );
  }

  function looksLikeChunkDownload(store) {
    if (!store || bridgeDisabled || isExcludedDeliveryPath(requestTargetOf(store))) return false;
    const disposition = headerValue(store.res, "Content-Disposition").toLowerCase();
    const contentType = headerValue(store.res, "Content-Type").toLowerCase();
    const attachmentChunk =
      disposition.includes("attachment") &&
      (contentType.includes("application/pdf") ||
        contentType.includes("application/zip") ||
        contentType.includes("application/x-zip") ||
        (contentType.includes("application/octet-stream") && /\.(?:pdf|zip)(?:"|$)/i.test(disposition)));
    if (attachmentChunk) return true;
    return (
      (store.req?.method === "GET" || store.req?.method === "HEAD") &&
      /(?:export|download|pdf|zip|format=(?:pdf|zip))/i.test(requestTargetOf(store))
    );
  }

  function applicationOwnsConcatCall() {
    const stackLines = String(new Error().stack || "")
      .split("\n")
      .slice(2);
    const caller = stackLines.find(
      (line) => !line.includes("exportBufferBridge.mjs") && !line.includes("node:internal")
    );
    if (!caller || caller.includes("node_modules")) return false;
    return (
      caller.includes("/server/") ||
      caller.includes("\\server\\") ||
      caller.includes("/dist/index.js") ||
      caller.includes("\\dist\\index.js")
    );
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

  function markerPayload(value) {
    return value && typeof value === "object" ? value[EXPORT_MARKER_KEY] : undefined;
  }

  // A number of legacy export routes normalize ExcelJS results with
  // `Buffer.from(await workbook.xlsx.writeBuffer())`. Large workbooks are
  // represented by zero-backed deferred markers, so the native Buffer.from
  // implementation would turn those markers into ordinary empty buffers and
  // discard the deferred payload. Preserve only our private marker while
  // delegating every normal Buffer conversion to Node unchanged.
  const originalBufferFrom = Buffer.from;
  if (!Buffer.from[BRIDGE_FLAG]) {
    const bridgedBufferFrom = function exportMarkerBufferFrom(value, ...args) {
      const payload = markerPayload(value);
      if (payload) return createMarker(payload);
      return originalBufferFrom.call(Buffer, value, ...args);
    };
    Object.defineProperty(bridgedBufferFrom, BRIDGE_FLAG, { value: true });
    Buffer.from = bridgedBufferFrom;
  }

  async function cleanupStaleFiles() {
    try {
      await mkdir(tempRoot, { recursive: true });
      const entries = await readdir(tempRoot, { withFileTypes: true });
      const cutoff = Date.now() - staleFileMaxAgeMs;
      // Keep cleanup deliberately low-pressure. A crash can leave many export
      // files behind; processing them sequentially avoids turning recovery into
      // a burst of filesystem promises and temporary allocations.
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(tempRoot, entry.name);
        try {
          const info = await stat(filePath);
          if (info.mtimeMs < cutoff) await unlink(filePath);
        } catch {
          // Best-effort cleanup only.
        }
      }
    } catch (error) {
      console.warn("[ExportBufferBridge] stale-file cleanup failed", error?.message || error);
    }
  }

  function waitForDrain(res) {
    return new Promise((resolve, reject) => {
      const onDrain = () => finish(resolve);
      const onClose = () => finish(() => reject(new Error("Export response closed before drain")));
      const onError = (error) => finish(() => reject(error));
      const finish = (done) => {
        res.off("drain", onDrain);
        res.off("close", onClose);
        res.off("error", onError);
        done();
      };
      res.once("drain", onDrain);
      res.once("close", onClose);
      res.once("error", onError);
    });
  }

  function installResponseBridge(res) {
    if (!res || res[RESPONSE_STATE_KEY]) return;

    const rawWrite = res.write;
    const rawEnd = res.end;
    Object.defineProperty(res, RESPONSE_STATE_KEY, { value: { rawWrite, rawEnd } });

    res.end = function bridgedResponseEnd(chunk, encoding, callback) {
      const payload = markerPayload(chunk);
      if (!payload) return rawEnd.call(this, chunk, encoding, callback);
      if (payload.started) return this;
      payload.started = true;

      const done = typeof encoding === "function" ? encoding : typeof callback === "function" ? callback : undefined;
      const declaredLength = this.getHeader("Content-Length");
      if (
        !this.headersSent &&
        Number.isFinite(payload.length) &&
        (declaredLength == null || Number(declaredLength) === 0)
      ) {
        this.setHeader("Content-Length", String(payload.length));
      }
      if (!this.headersSent) this.setHeader("X-Accel-Buffering", "no");

      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        if (payload.kind === "file" && payload.path) {
          try {
            await unlink(payload.path);
          } catch {
            // File may already be gone after a disconnect or process cleanup.
          }
        }
        if (payload.kind === "chunks" && Array.isArray(payload.chunks)) payload.chunks.length = 0;
      };

      this.once("finish", cleanup);
      this.once("close", cleanup);

      void (async () => {
        try {
          if (payload.kind === "file") {
            const input = createReadStream(payload.path);
            input.once("error", (error) => this.destroy(error));
            for await (const part of input) {
              if (this.destroyed || this.writableEnded) break;
              if (!rawWrite.call(this, part)) await waitForDrain(this);
            }
          } else if (payload.kind === "chunks") {
            for (const part of payload.chunks) {
              if (this.destroyed || this.writableEnded) break;
              if (!rawWrite.call(this, part)) await waitForDrain(this);
            }
          } else {
            throw new Error(`Unknown export marker kind: ${payload.kind}`);
          }

          if (!this.destroyed && !this.writableEnded) rawEnd.call(this, done);
        } catch (error) {
          await cleanup();
          if (!this.destroyed) this.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      })();

      return this;
    };
  }

  const previousEmit = Server.prototype.emit;
  Server.prototype.emit = function exportContextEmit(event, ...args) {
    if (event !== "request") return previousEmit.call(this, event, ...args);
    const [req, res] = args;
    installResponseBridge(res);
    return requestContext.run({ req, res, pathname: pathnameOf(req) }, () => previousEmit.call(this, event, ...args));
  };

  const expressNamespace = await import("express");
  const expressModule = expressNamespace.default || expressNamespace;
  const responsePrototype = expressModule.response || expressNamespace.response;
  if (responsePrototype?.send && !responsePrototype.send[BRIDGE_FLAG]) {
    const originalSend = responsePrototype.send;
    const bridgedSend = function exportMarkerSend(body) {
      if (markerPayload(body)) {
        this.end(body);
        return this;
      }
      return originalSend.call(this, body);
    };
    Object.defineProperty(bridgedSend, BRIDGE_FLAG, { value: true });
    responsePrototype.send = bridgedSend;
  }

  const originalConcat = Buffer.concat;
  Buffer.concat = function bridgedBufferConcat(list, totalLength) {
    const store = requestContext.getStore();
    if (
      applicationOwnsConcatCall() &&
      looksLikeChunkDownload(store) &&
      Array.isArray(list) &&
      list.length > 0 &&
      list.every((part) => Buffer.isBuffer(part) || part instanceof Uint8Array)
    ) {
      const length = Number.isFinite(totalLength) ? totalLength : list.reduce((sum, part) => sum + part.byteLength, 0);
      if (length >= chunkBridgeThreshold) {
        return createMarker({
          kind: "chunks",
          chunks: list.slice(),
          length,
          pathname: store.pathname,
          started: false,
        });
      }
    }
    return originalConcat.call(Buffer, list, totalLength);
  };

  const excelNamespace = await import("exceljs");
  const ExcelJS = excelNamespace.default || excelNamespace;
  const Workbook = ExcelJS.Workbook || excelNamespace.Workbook;
  const probeWorkbook = new Workbook();
  const xlsxPrototype = Object.getPrototypeOf(probeWorkbook.xlsx);
  const originalWriteBuffer = xlsxPrototype.writeBuffer;
  const originalWrite = xlsxPrototype.write;

  if (!xlsxPrototype.writeBuffer[BRIDGE_FLAG]) {
    const bridgedWriteBuffer = async function exportAwareWriteBuffer(options) {
      const store = requestContext.getStore();
      const label = store?.pathname ? `legacy-workbook:${store.pathname}` : "legacy-workbook:attachment";

      if (!looksLikeWorkbookDownload(store)) {
        return withSharedExportSlot(label, () => originalWriteBuffer.call(this, options));
      }

      return withSharedExportSlot(label, async () => {
        // Use writeBuffer() (not write(stream)) — ExcelJS 3.x write(stream) is broken
        // (throws "ea.results is not a Promise" and produces 0-byte / corrupt output).
        // writeBuffer() is the only reliable API; we then flush the in-memory buffer to
        // a temp file so large exports don't block the event loop for too long.
        const rawBuffer = await originalWriteBuffer.call(this, options);

        // Normalise whatever ExcelJS actually returned (Buffer / Uint8Array / ArrayBuffer)
        let buf;
        if (Buffer.isBuffer(rawBuffer)) {
          buf = rawBuffer;
        } else if (rawBuffer instanceof Uint8Array) {
          buf = Buffer.from(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);
        } else if (rawBuffer instanceof ArrayBuffer) {
          buf = Buffer.from(rawBuffer);
        } else {
          // Fallback — return as-is and let the route handle it
          return rawBuffer;
        }

        // Only write to a temp file when the buffer is large enough to justify it;
        // small workbooks are returned directly as an in-memory marker.
        if (buf.byteLength < chunkBridgeThreshold) {
          return buf;
        }

        await mkdir(tempRoot, { recursive: true });
        const filePath = path.join(tempRoot, `${Date.now()}-${randomUUID()}.xlsx`);
        const output = createWriteStream(filePath, { flags: "wx" });
        try {
          output.write(buf);
          output.end();
          await finished(output);
          const info = await stat(filePath);
          return createMarker({
            kind: "file",
            path: filePath,
            length: info.size,
            pathname: store.pathname,
            started: false,
          });
        } catch (error) {
          output.destroy();
          try {
            await unlink(filePath);
          } catch {
            // Partial file may not have been created.
          }
          throw error;
        }
      });
    };

    Object.defineProperty(bridgedWriteBuffer, BRIDGE_FLAG, { value: true });
    xlsxPrototype.writeBuffer = bridgedWriteBuffer;
  }

  await cleanupStaleFiles();
  const staleCleanupIntervalMs = Math.max(5 * 60 * 1000, Math.min(staleFileMaxAgeMs, 30 * 60 * 1000));
  const staleCleanupTimer = setInterval(() => {
    void cleanupStaleFiles();
  }, staleCleanupIntervalMs);
  staleCleanupTimer.unref?.();

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "INFO",
      message: "Legacy export buffer bridge enabled",
      module: "export-buffer-bridge",
      action: "startup",
      tempRoot,
      chunkBridgeThreshold,
      bridgeDisabled,
    })
  );
}
