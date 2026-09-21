import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Server } from "node:http";

const startedAt = Date.now();
const slowRequestMs = Number.parseInt(process.env.SLOW_REQUEST_MS || "1000", 10);
const emitRequestLogs = process.env.RUNTIME_OBSERVABILITY_REQUEST_LOGS === "true";
const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

const metrics = {
  activeRequests: 0,
  totalRequests: 0,
  total5xx: 0,
  slowRequests: 0,
  maxActiveRequests: 0,
  last5xxAt: null,
};

globalThis.__erpRuntimeMetrics = metrics;

function pathnameOf(req) {
  try { return new URL(req.url || "/", "http://localhost").pathname; }
  catch { return req.url || "/"; }
}

function isExpectedLongLivedRequest(req, path) {
  if (path === "/api/screen-feed/live/status") return true;
  const accept = String(req.headers?.accept || "").toLowerCase();
  return accept.includes("text/event-stream");
}

function snapshot() {
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    requests: { ...metrics },
    eventLoop: {
      meanMs: Number.isFinite(histogram.mean) ? Number((histogram.mean / 1e6).toFixed(2)) : 0,
      maxMs: Number((histogram.max / 1e6).toFixed(2)),
      p95Ms: Number((histogram.percentile(95) / 1e6).toFixed(2)),
      p99Ms: Number((histogram.percentile(99) / 1e6).toFixed(2)),
      utilizationPercent: Number((performance.eventLoopUtilization().utilization * 100).toFixed(2)),
    },
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
      heapUsedPercent: memory.heapTotal > 0 ? Number(((memory.heapUsed / memory.heapTotal) * 100).toFixed(2)) : 0,
      externalMb: Math.round(memory.external / 1024 / 1024),
      arrayBuffersMb: Math.round((memory.arrayBuffers ?? 0) / 1024 / 1024),
    },
    exportCoordinator:
      typeof globalThis.__erpExportCoordinatorSnapshot === "function"
        ? globalThis.__erpExportCoordinatorSnapshot()
        : null,
  };
}

function readableMessage(action, details) {
  if (action === "startup") {
    return `Runtime observability started with a ${details.slowRequestMs} ms slow-request threshold.`;
  }
  if (action === "http-5xx") {
    return `${details.method || "HTTP"} ${details.path || "request"} failed with status ${details.statusCode} in ${details.durationMs} ms.`;
  }
  if (action === "slow-request") {
    return `${details.method || "HTTP"} ${details.path || "request"} was slow and completed in ${details.durationMs} ms.`;
  }
  if (action === "runtime-pressure") {
    return `Runtime pressure detected: RSS memory is ${details.memory?.rssMb ?? "unknown"} MB and event-loop p99 is ${details.eventLoop?.p99Ms ?? "unknown"} ms.`;
  }
  return "Runtime observability event recorded.";
}

function log(level, action, details) {
  const message = readableMessage(action, details);
  const sharedLogger = globalThis.__erpLogger;
  const method = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "info";
  if (sharedLogger && typeof sharedLogger[method] === "function") {
    sharedLogger[method](message, {
      event: `runtime.${action}`,
      module: "runtime-observability",
      action,
      ...details,
    });
    return;
  }

  const line = `[${level}] ${message}`;
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

const originalEmit = Server.prototype.emit;
Server.prototype.emit = function observableEmit(event, ...args) {
  if (event !== "request") return originalEmit.call(this, event, ...args);
  const [req, res] = args;
  const path = pathnameOf(req);

  if (path === "/api/health/metrics") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(snapshot()));
    return true;
  }

  const started = Date.now();
  const expectedLongLived = isExpectedLongLivedRequest(req, path);
  metrics.totalRequests += 1;
  metrics.activeRequests += 1;
  metrics.maxActiveRequests = Math.max(metrics.maxActiveRequests, metrics.activeRequests);
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    metrics.activeRequests = Math.max(0, metrics.activeRequests - 1);
    const durationMs = Date.now() - started;
    if (res.statusCode >= 500) {
      metrics.total5xx += 1;
      metrics.last5xxAt = new Date().toISOString();
      if (emitRequestLogs) {
        log("ERROR", "http-5xx", { method: req.method, path, statusCode: res.statusCode, durationMs });
      }
    } else if (!expectedLongLived && durationMs >= slowRequestMs) {
      metrics.slowRequests += 1;
      if (emitRequestLogs) {
        log("WARN", "slow-request", { method: req.method, path, statusCode: res.statusCode, durationMs });
      }
    }
  };

  res.once("finish", release);
  res.once("close", release);
  return originalEmit.call(this, event, ...args);
};

const periodic = setInterval(() => {
  const data = snapshot();
  if (data.eventLoop.p99Ms >= 250 || data.memory.rssMb >= 1200) {
    log("WARN", "runtime-pressure", data);
  }
  histogram.reset();
}, 60_000);
periodic.unref();

log("INFO", "startup", { slowRequestMs, requestLogsEnabled: emitRequestLogs, initial: snapshot() });
