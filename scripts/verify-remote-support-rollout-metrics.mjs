#!/usr/bin/env node

const baseUrl = String(process.env.REMOTE_SUPPORT_GATE_BASE_URL || "").replace(/\/$/, "");
const username = process.env.REMOTE_SUPPORT_GATE_USERNAME || "";
const password = process.env.REMOTE_SUPPORT_GATE_PASSWORD || "";

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const thresholds = {
  minFrameSamples: numberEnv("REMOTE_SUPPORT_GATE_MIN_FRAME_SAMPLES", 20),
  maxFrameIntervalP95Ms: numberEnv("REMOTE_SUPPORT_GATE_MAX_FRAME_INTERVAL_P95_MS", 1500),
  maxClientToViewerP95Ms: numberEnv("REMOTE_SUPPORT_GATE_MAX_CLIENT_TO_VIEWER_P95_MS", 1500),
  maxCaptureP95Ms: numberEnv("REMOTE_SUPPORT_GATE_MAX_CAPTURE_P95_MS", 1500),
  minClickSamples: numberEnv("REMOTE_SUPPORT_GATE_MIN_CLICK_SAMPLES", 5),
  minClickSuccessRate: numberEnv("REMOTE_SUPPORT_GATE_MIN_CLICK_SUCCESS_RATE", 0.95),
  minAuditRows: numberEnv("REMOTE_SUPPORT_GATE_MIN_AUDIT_ROWS", 1),
};

function fail(message, details) {
  console.error(`[remote-support-rollout] FAIL: ${message}`);
  if (details) console.error(JSON.stringify(details, null, 2));
  process.exitCode = 1;
}

if (!baseUrl || !username || !password) {
  fail("REMOTE_SUPPORT_GATE_BASE_URL, REMOTE_SUPPORT_GATE_USERNAME, and REMOTE_SUPPORT_GATE_PASSWORD are required.");
  process.exit();
}

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
  redirect: "manual",
});
if (!loginResponse.ok) {
  fail(`login failed with HTTP ${loginResponse.status}`);
  process.exit();
}

const cookieHeader = loginResponse.headers.get("set-cookie");
if (!cookieHeader) {
  fail("login succeeded without a session cookie");
  process.exit();
}
const cookie = cookieHeader.split(/,(?=[^;]+?=)/)[0].split(";")[0];

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { cookie, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

let runtime;
let audit;
try {
  [runtime, audit] = await Promise.all([
    getJson("/api/screen-feed/admin/runtime"),
    getJson("/api/screen-feed/control/audit?limit=1&page=1"),
  ]);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exit();
}

const metrics = runtime?.metrics || {};
const latency = metrics.latency || {};
const frameInterval = latency.frameIntervalMs || {};
const clientToViewer = latency.clientToViewerMs || {};
const capture = latency.captureDurationMs || {};
const failures = [];

if ((frameInterval.count || 0) < thresholds.minFrameSamples) {
  failures.push(`frame samples ${frameInterval.count || 0} < ${thresholds.minFrameSamples}`);
}
if ((frameInterval.p95Ms || 0) > thresholds.maxFrameIntervalP95Ms) {
  failures.push(`frame interval p95 ${frameInterval.p95Ms}ms > ${thresholds.maxFrameIntervalP95Ms}ms`);
}
if ((clientToViewer.count || 0) < thresholds.minFrameSamples) {
  failures.push(`client→viewer samples ${clientToViewer.count || 0} < ${thresholds.minFrameSamples}`);
}
if ((clientToViewer.p95Ms || 0) > thresholds.maxClientToViewerP95Ms) {
  failures.push(`client→viewer p95 ${clientToViewer.p95Ms}ms > ${thresholds.maxClientToViewerP95Ms}ms`);
}
if ((capture.count || 0) < thresholds.minFrameSamples) {
  failures.push(`capture samples ${capture.count || 0} < ${thresholds.minFrameSamples}`);
}
if ((capture.p95Ms || 0) > thresholds.maxCaptureP95Ms) {
  failures.push(`capture p95 ${capture.p95Ms}ms > ${thresholds.maxCaptureP95Ms}ms`);
}
if ((metrics.clickCommandsSent || 0) < thresholds.minClickSamples) {
  failures.push(`click samples ${metrics.clickCommandsSent || 0} < ${thresholds.minClickSamples}`);
}
if (typeof metrics.clickSuccessRate !== "number" || metrics.clickSuccessRate < thresholds.minClickSuccessRate) {
  failures.push(`click success rate ${metrics.clickSuccessRate ?? "n/a"} < ${thresholds.minClickSuccessRate}`);
}
if ((audit?.total || 0) < thresholds.minAuditRows) {
  failures.push(`remote-support audit rows ${audit?.total || 0} < ${thresholds.minAuditRows}`);
}

const report = {
  pass: failures.length === 0,
  thresholds,
  observed: {
    frameIntervalP95Ms: frameInterval.p95Ms ?? null,
    frameSamples: frameInterval.count ?? 0,
    clientToViewerP95Ms: clientToViewer.p95Ms ?? null,
    clientToViewerSamples: clientToViewer.count ?? 0,
    captureP95Ms: capture.p95Ms ?? null,
    captureSamples: capture.count ?? 0,
    clickCommandsSent: metrics.clickCommandsSent ?? 0,
    clickCommandsExecuted: metrics.clickCommandsExecuted ?? 0,
    clickSuccessRate: metrics.clickSuccessRate ?? null,
    auditRows: audit?.total ?? 0,
  },
  failures,
};

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exitCode = 1;
