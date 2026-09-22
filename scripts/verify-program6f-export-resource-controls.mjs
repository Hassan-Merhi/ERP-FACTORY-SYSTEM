#!/usr/bin/env node

import fs from "node:fs";

const failures = [];
const read = (path) => fs.readFileSync(path, "utf8");
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};

const packageJson = JSON.parse(read("package.json"));
const dev = String(packageJson.scripts?.dev || "");
const start = String(packageJson.scripts?.start || "");
const bridge = read("server/exportBufferBridge.mjs");
const memoryGuard = read("server/runtimeMemoryGuard.mjs");
const puppeteer = read("server/lib/puppeteerSemaphore.ts");
const exportAudit = read("scripts/audit-large-export-buffers.mjs");
const renderBlueprint = read("render.yaml");
const hasRenderEnv = (key, value) =>
  renderBlueprint.includes(`- key: ${key}\n        value: "${value}"`);

assert(dev.includes("--import ./server/exportBufferBridge.mjs"), "Export bridge must be preloaded in development.");
assert(start.includes("--import ./server/exportBufferBridge.mjs"), "Export bridge must be preloaded in production.");
assert(start.includes("--import ./server/runtimeMemoryGuard.mjs"), "Runtime memory guard must be preloaded in production.");

assert(bridge.includes("HEAVY_EXPORT_MAX_CONCURRENT"), "Heavy exports must have a configurable concurrency limit.");
assert(bridge.includes("HEAVY_EXPORT_MAX_QUEUE"), "Heavy exports must have a bounded queue.");
assert(bridge.includes("HEAVY_EXPORT_WAIT_TIMEOUT_MS"), "Heavy export queue waits must time out.");
assert(bridge.includes("createWriteStream(filePath"), "Workbook downloads must spill to temporary files instead of one in-memory buffer.");
assert(bridge.includes("createReadStream(payload.path)"), "Temporary workbook files must stream to the response.");
assert(bridge.includes("waitForDrain"), "Export streaming must respect response backpressure.");
assert(bridge.includes("cleanupStaleFiles"), "Stale temporary export files must be cleaned up.");
assert(bridge.includes("this.once(\"close\", cleanup)"), "Disconnected downloads must release temporary export resources.");

assert(memoryGuard.includes("MEMORY_SOFT_RSS_MB"), "Runtime memory guard must retain a soft RSS threshold.");
assert(memoryGuard.includes("MEMORY_HARD_RSS_MB"), "Runtime memory guard must retain a hard RSS threshold.");
assert(memoryGuard.includes("MEMORY_PRESSURE"), "Critical memory pressure must reject new API work safely.");
assert(memoryGuard.includes('path.includes("/export")'), "Export endpoints must retain endpoint-level concurrency protection.");
assert(memoryGuard.includes("controlled-restart"), "Sustained hard memory pressure must trigger controlled restart behavior.");
assert(
  memoryGuard.includes("REQUEST_SAMPLE_MIN_INTERVAL_MS = 1_000"),
  "Request-triggered memory sampling must remain throttled."
);
assert(
  memoryGuard.includes('if (path.startsWith("/api/"))'),
  "Request-triggered memory sampling must stay limited to API traffic."
);

// Reconciled with the live service during Wave 7 certification: it runs on the
// `standard` plan (2 GB container), not the 512 MB Starter these limits were
// originally written for, and its runtime memory guard reports softRssMb 1200 /
// hardRssMb 1500. The intent is unchanged — cap the JS heap below the container
// ceiling, start shedding pressure before the container OOMs — only the ceiling
// these are measured against moved.
assert(
  hasRenderEnv("NODE_OPTIONS", "--max-old-space-size=1024"),
  "Render runtime must cap the Node old-space heap below the 2 GB standard container."
);
assert(
  hasRenderEnv("MEMORY_SOFT_RSS_MB", "1200"),
  "Render memory soft pressure must start below the standard memory ceiling."
);
assert(
  hasRenderEnv("MEMORY_HARD_RSS_MB", "1500"),
  "Render memory hard pressure must start before the standard OOM ceiling."
);
assert(hasRenderEnv("PG_POOL_MAX", "8"), "Render main database pool must keep its Phase 1 peak connection budget.");
assert(hasRenderEnv("PG_POOL_MIN", "0"), "Render main database pool must not pin idle connections open.");
assert(
  hasRenderEnv("PG_IDLE_TIMEOUT_MS", "30000"),
  "Render main database pool must release idle clients after 30 seconds."
);
assert(
  hasRenderEnv("PG_SESSION_POOL_MAX", "3"),
  "Render session database pool must keep the connection budget production reports."
);

assert(puppeteer.includes("PUPPETEER_MAX_CONCURRENT"), "Puppeteer concurrency must be deployment-configurable and bounded.");
assert(puppeteer.includes("PUPPETEER_MAX_QUEUE_DEPTH"), "Puppeteer waiting callers must have a queue-depth limit.");
assert(puppeteer.includes("PUPPETEER_QUEUE_WAIT_TIMEOUT_MS"), "Puppeteer queue waits must have a timeout.");
assert(puppeteer.includes("PUPPETEER_QUEUE_FULL"), "Puppeteer must fail fast when its queue is full.");
assert(puppeteer.includes("PUPPETEER_QUEUE_TIMEOUT"), "Puppeteer must fail safely when queue wait time is exceeded.");
assert(puppeteer.includes("if (released) return"), "Puppeteer slot release must be idempotent.");

assert(exportAudit.includes("unprotectedHighRisk"), "Large-export audit must report unprotected high-risk buffering.");
assert(exportAudit.includes("EXPORT_BUFFER_AUDIT_FAIL"), "Large-export audit must support a strict failure mode.");

if (failures.length) {
  console.error("Program 6F export/resource-control verification failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Program 6F export and resource-control invariants verified.");
