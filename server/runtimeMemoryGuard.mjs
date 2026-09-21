import "./deploymentPreflight.mjs";
import "./criticalSecuritySchemaBridge.mjs";
import "./factoryContainerSchemaBridge.mjs";
import "./runtimeReleaseState.mjs";
import "./runtimeSecurityGuard.mjs";
import "./runtimeHealthGuard.mjs";
import "./runtimeObservability.mjs";
import "./runtimeLifecycleGuard.mjs";
import "./startupWarningRepair.mjs";
import { Server } from "node:http";
import process from "node:process";

const mb = (bytes) => Math.round(bytes / 1024 / 1024);
const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const SOFT_RSS_MB = parsePositiveInt(process.env.MEMORY_SOFT_RSS_MB, 1200);
const HARD_RSS_MB = parsePositiveInt(process.env.MEMORY_HARD_RSS_MB, 1500);
const SAMPLE_INTERVAL_MS = parsePositiveInt(process.env.MEMORY_SAMPLE_INTERVAL_MS, 15_000);
const HARD_SAMPLES_BEFORE_EXIT = parsePositiveInt(process.env.MEMORY_HARD_SAMPLES_BEFORE_EXIT, 4);
// process.memoryUsage() walks all memory categories and can be relatively
// expensive. Request bursts should not turn the safety guard itself into CPU
// work, and four requests in the same millisecond should not count as four
// independent hard-pressure samples. One request-triggered sample per second
// is responsive enough to shed API load before the interval sampler fires.
const REQUEST_SAMPLE_MIN_INTERVAL_MS = 1_000;

const pressureState = {
  level: "normal",
  hardSamples: 0,
  lastSampleAt: Date.now(),
  rssMb: 0,
  heapUsedMb: 0,
  externalMb: 0,
  arrayBuffersMb: 0,
};

globalThis.__erpMemoryPressure = pressureState;

function sampleMemory(trigger = "interval") {
  const sampledAt = Date.now();
  if (trigger === "request" && sampledAt - pressureState.lastSampleAt < REQUEST_SAMPLE_MIN_INTERVAL_MS) {
    return;
  }

  const memory = process.memoryUsage();
  pressureState.lastSampleAt = sampledAt;
  pressureState.rssMb = mb(memory.rss);
  pressureState.heapUsedMb = mb(memory.heapUsed);
  pressureState.externalMb = mb(memory.external);
  pressureState.arrayBuffersMb = mb(memory.arrayBuffers ?? 0);

  if (pressureState.rssMb >= HARD_RSS_MB) {
    pressureState.level = "critical";
    pressureState.hardSamples += 1;
  } else if (pressureState.rssMb >= SOFT_RSS_MB) {
    pressureState.level = "soft";
    pressureState.hardSamples = 0;
  } else {
    pressureState.level = "normal";
    pressureState.hardSamples = 0;
  }

  if (pressureState.level !== "normal") {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: pressureState.level === "critical" ? "ERROR" : "WARN",
        message: "Runtime memory pressure detected",
        module: "memory-guard",
        action: "memory-sample",
        trigger,
        rssMb: pressureState.rssMb,
        heapUsedMb: pressureState.heapUsedMb,
        externalMb: pressureState.externalMb,
        arrayBuffersMb: pressureState.arrayBuffersMb,
        softLimitMb: SOFT_RSS_MB,
        hardLimitMb: HARD_RSS_MB,
        hardSamples: pressureState.hardSamples,
      })
    );
  }

  if (pressureState.level === "critical" && typeof globalThis.gc === "function") {
    try {
      globalThis.gc();
    } catch {}
  }

  if (pressureState.hardSamples >= HARD_SAMPLES_BEFORE_EXIT) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "FATAL",
        message: "Memory stayed above the hard RSS limit; exiting before an OOM kill",
        module: "memory-guard",
        action: "controlled-restart",
        rssMb: pressureState.rssMb,
        hardLimitMb: HARD_RSS_MB,
        samples: pressureState.hardSamples,
      })
    );
    const shutdown = globalThis.__erpRequestGracefulShutdown;
    if (typeof shutdown === "function") {
      shutdown("memory-hard-limit", 1, null);
    } else {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "FATAL",
          module: "memory-guard",
          action: "shutdown-fallback",
          message: "Graceful shutdown unavailable — calling process.exit directly",
        })
      );
      process.exit(1);
    }
  }
}

const pathLimits = [
  { test: (path) => path === "/api/factory/net-position", max: 2, name: "factory-net-position" },
  { test: (path) => path === "/api/factory/raw-stock", max: 2, name: "factory-raw-stock" },
  { test: (path) => path === "/api/factory/bale-ledger", max: 2, name: "factory-bale-ledger" },
  { test: (path) => path.includes("/export"), max: 1, name: "exports" },
  // Proven heavy routes from the latest incident:
  { test: (path) => path === "/api/factory/bales/stock-entry-history", max: 2, name: "factory-stock-entry-history" },
  { test: (path) => path === "/api/factory/monthly-salary-summary", max: 2, name: "factory-monthly-salary-summary" },
  { test: (path) => path === "/api/factory/workers", max: 2, name: "factory-workers" },
  { test: (path) => path === "/api/factory/cash-accounts", max: 2, name: "factory-cash-accounts" },
  // This route issues several grouped financial queries in parallel. Keep only
  // one cold-cache calculation active so a dashboard request cannot consume the
  // entire PostgreSQL pool and starve authorization/session queries.
  { test: (path) => path === "/api/stats/net-profit", max: 1, name: "stats-net-profit" },
  { test: (path) => path === "/api/ledger-accounts", max: 2, name: "ledger-accounts" },
];

const activeByName = new Map();
// Exposed for the lifecycle guard's runtime snapshot.
globalThis.__erpConcurrencyCounters = activeByName;

// Instead of instantly rejecting when a heavy endpoint is saturated, hold the
// request in a short FIFO queue and start it as soon as a slot frees up. Users
// double-clicking an export or two POS users opening the same report used to
// see a raw ENDPOINT_BUSY JSON page; now the second request simply waits.
const QUEUE_MAX_WAIT_MS = parsePositiveInt(process.env.ENDPOINT_QUEUE_MAX_WAIT_MS, 20_000);
const QUEUE_MAX_DEPTH = parsePositiveInt(process.env.ENDPOINT_QUEUE_MAX_DEPTH, 8);
const queuesByName = new Map();

function queueFor(name) {
  let queue = queuesByName.get(name);
  if (!queue) {
    queue = [];
    queuesByName.set(name, queue);
  }
  return queue;
}

function tryAcquire(rule) {
  const current = activeByName.get(rule.name) ?? 0;
  if (current >= rule.max) return false;
  activeByName.set(rule.name, current + 1);
  return true;
}

function drainQueue(rule) {
  const queue = queuesByName.get(rule.name);
  while (queue && queue.length > 0 && tryAcquire(rule)) {
    const waiter = queue.shift();
    clearTimeout(waiter.timer);
    waiter.detach?.();
    if (waiter.res.writableEnded || waiter.res.destroyed || waiter.req.destroyed) {
      // Client went away while waiting — free the slot for the next waiter.
      releaseSlot(rule);
      continue;
    }
    waiter.start();
  }
}

function releaseSlot(rule) {
  activeByName.set(rule.name, Math.max(0, (activeByName.get(rule.name) ?? 1) - 1));
}
function pathnameOf(req) {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return req.url || "/";
  }
}
function reject(res, statusCode, code, message, retryAfterSeconds = 5) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.end(JSON.stringify({ message, code, retryAfterSeconds }));
}

const originalEmit = Server.prototype.emit;
Server.prototype.emit = function patchedEmit(event, ...args) {
  if (event !== "request") return originalEmit.call(this, event, ...args);
  const [req, res] = args;
  const path = pathnameOf(req);
  if (
    path === "/api/health" ||
    path === "/api/health/db" ||
    path === "/api/health/live" ||
    path === "/api/health/ready" ||
    path === "/api/health/metrics"
  )
    return originalEmit.call(this, event, ...args);
  if (globalThis.__erpRuntimeShuttingDown) {
    reject(res, 503, "SERVER_SHUTTING_DOWN", "Server is restarting. Please retry shortly.", 5);
    return true;
  }
  if (path.startsWith("/api/")) {
    sampleMemory("request");
    if (pressureState.level === "critical") {
      reject(res, 503, "MEMORY_PRESSURE", "Server is temporarily protecting itself from high memory usage.", 10);
      return true;
    }
  }
  const rule = pathLimits.find((candidate) => candidate.test(path));
  if (!rule) return originalEmit.call(this, event, ...args);

  const server = this;
  const start = () => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseSlot(rule);
      drainQueue(rule);
    };
    res.once("finish", release);
    res.once("close", release);
    originalEmit.call(server, event, req, res);
  };

  if (tryAcquire(rule)) {
    start();
    return true;
  }

  const queue = queueFor(rule.name);
  if (queue.length >= QUEUE_MAX_DEPTH) {
    // Queue is saturated too — shed load the old way rather than piling up.
    reject(res, 429, "ENDPOINT_BUSY", "This heavy operation is already running. Please retry shortly.", 5);
    return true;
  }

  const waiter = { req, res, start: null, timer: null, detach: null };
  waiter.start = start;
  const removeQueuedWaiter = () => {
    const index = queue.indexOf(waiter);
    if (index === -1) return;
    queue.splice(index, 1);
    clearTimeout(waiter.timer);
    detach();
  };
  const detach = () => {
    req.off?.("aborted", removeQueuedWaiter);
    res.off?.("close", removeQueuedWaiter);
  };
  waiter.detach = detach;
  req.once?.("aborted", removeQueuedWaiter);
  res.once?.("close", removeQueuedWaiter);
  waiter.timer = setTimeout(() => {
    const index = queue.indexOf(waiter);
    if (index !== -1) queue.splice(index, 1);
    detach();
    reject(res, 429, "ENDPOINT_BUSY", "This heavy operation is still busy. Please retry shortly.", 5);
  }, QUEUE_MAX_WAIT_MS);
  waiter.timer.unref?.();
  queue.push(waiter);
  return true;
};

const timer = setInterval(() => sampleMemory("interval"), SAMPLE_INTERVAL_MS);
timer.unref();
sampleMemory("startup");
console.log(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "INFO",
    message: "Runtime memory guard enabled",
    module: "memory-guard",
    action: "startup",
    softRssMb: SOFT_RSS_MB,
    hardRssMb: HARD_RSS_MB,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    requestSampleMinIntervalMs: REQUEST_SAMPLE_MIN_INTERVAL_MS,
    hardSamplesBeforeExit: HARD_SAMPLES_BEFORE_EXIT,
  })
);
