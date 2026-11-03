#!/usr/bin/env node
/**
 * Phase 5 factory outage acceptance: public, read-only probes only.
 * This is NOT a replication or accounting correctness certification.
 */
import { readFile, writeFile, rename, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const SITE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = ["baseline", "outage", "restored"];

export function validateUrl(value, { edge = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error("INVALID_URL"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      url.search || url.hash || (edge && url.pathname !== "/")) {
    throw new Error("HTTPS_URL_WITHOUT_CREDENTIALS_REQUIRED");
  }
  return url;
}

export function classifyFailure(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "timeout";
  const codes = new Set([error?.code, error?.cause?.code]);
  if (["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
       "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT",
       "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED", "ERR_SSL_WRONG_VERSION_NUMBER"]
      .some(code => codes.has(code))) return "tls-error";
  if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH",
       "ETIMEDOUT", "ECONNRESET", "EPIPE"].some(code => codes.has(code))) return "network-error";
  return "unknown-error"; // Never interpret unrecognized exceptions as WAN outage.
}

function siteFromResponse(json) {
  const siteId = json?.siteId ?? json?.site_id;
  const mode = json?.mode ?? json?.edgeMode ?? json?.edge_mode;
  const writeMode = json?.writeMode ?? json?.write_mode;
  if (!SITE_UUID.test(siteId ?? "") || mode !== "lan" ||
      !["read-only", "lan-primary"].includes(writeMode)) {
    return { valid: false, reason: "EDGE_STATUS_CONTRACT_UNKNOWN" };
  }
  return { valid: true, siteId: siteId.toLowerCase(), writeMode };
}

async function publicGet(url, fetcher) {
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    return { response };
  } catch (error) {
    return { error: classifyFailure(error) };
  }
}

export async function probeEdge(edgeUrl, expectedSite, fetcher = fetch) {
  const url = new URL("/api/edge/status", validateUrl(edgeUrl, { edge: true }));
  const result = await publicGet(url.href, fetcher);
  if (result.error) return { ok: false, reason: "EDGE_" + result.error };
  const response = result.response;
  if (response.status !== 200 || response.redirected ||
      (response.status >= 300 && response.status < 400)) {
    return { ok: false, reason: "EDGE_HTTP_STATUS", httpStatus: response.status };
  }
  try {
    const body = await response.text();
    if (body.length > 8192) return { ok: false, reason: "EDGE_STATUS_OVERSIZED" };
    const parsed = siteFromResponse(JSON.parse(body));
    if (!parsed.valid) return { ok: false, reason: parsed.reason };
    if (parsed.siteId !== expectedSite.toLowerCase()) {
      return { ok: false, reason: "EDGE_SITE_MISMATCH" };
    }
    return { ok: true, siteId: parsed.siteId, writeMode: parsed.writeMode };
  } catch {
    return { ok: false, reason: "EDGE_STATUS_INVALID_JSON" };
  }
}

export async function probeCloud(cloudUrl, fetcher = fetch) {
  const url = validateUrl(cloudUrl);
  const result = await publicGet(url.href, fetcher);
  if (result.error) return { reachable: false, reason: result.error };
  // Any actual HTTPS HTTP response demonstrates a WAN path, including 401/503.
  return { reachable: true, httpStatus: result.response.status };
}

export function evaluateStage(stage, edge, cloud) {
  const failures = [];
  if (!edge.ok) failures.push(edge.reason);
  if (stage === "outage" && edge.ok && edge.writeMode !== "lan-primary") {
    failures.push("EDGE_NOT_PRIMARY_FOR_OFFLINE_WRITES");
  }
  if (stage === "outage") {
    if (cloud.reachable || !["network-error", "timeout"].includes(cloud.reason)) {
      failures.push("WAN_NOT_VERIFIABLY_DISCONNECTED");
    }
  } else if (!cloud.reachable) {
    failures.push("WAN_NOT_REACHABLE");
  }
  return { passed: failures.length === 0, failures };
}

function checkSequence(report, stage, edgeOrigin, cloudOrigin, expectedSite) {
  if (report.schemaVersion !== 1 || report.expectedSite !== expectedSite ||
      report.edgeOrigin !== edgeOrigin || report.cloudOrigin !== cloudOrigin) {
    throw new Error("REPORT_IDENTITY_MISMATCH");
  }
  if (stage === "baseline" && (report.stages.outage || report.stages.restored)) {
    throw new Error("BASELINE_ALREADY_ADVANCED");
  }
  if (stage === "outage" && !report.stages.baseline?.passed) {
    throw new Error("PASS_BASELINE_FIRST");
  }
  if (stage === "outage" && report.stages.restored) {
    throw new Error("OUTAGE_ALREADY_RESTORED");
  }
  if (stage === "restored" && !report.stages.outage?.passed) {
    throw new Error("PASS_OUTAGE_FIRST");
  }
}

async function loadReport(output, edgeOrigin, cloudOrigin, expectedSite) {
  let data;
  try {
    const stat = await lstat(output);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("INVALID_REPORT_PATH");
    data = JSON.parse(await readFile(output, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    data = {
      schemaVersion: 1,
      expectedSite,
      edgeOrigin,
      cloudOrigin,
      stages: {},
      // No cookies, session data, request/response bodies or credentials.
      certification: "LAN_CONNECTIVITY_ONLY_NO_REPLICATION_ASSERTION",
    };
  }
  if (!data || typeof data.stages !== "object" || Array.isArray(data.stages)) {
    throw new Error("INVALID_REPORT");
  }
  return data;
}

async function saveReport(path, report) {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function runStage({ stage, edge, cloud, expectedSite, output }, { fetcher = fetch } = {}) {
  if (!STAGES.includes(stage)) throw new Error("UNKNOWN_STAGE");
  if (!SITE_UUID.test(expectedSite ?? "")) throw new Error("INVALID_EXPECTED_SITE_UUID");
  if (!output || typeof output !== "string") throw new Error("OUTPUT_FILE_REQUIRED");
  const edgeOrigin = validateUrl(edge, { edge: true }).origin;
  const cloudOrigin = validateUrl(cloud).origin;
  if (edgeOrigin === cloudOrigin) throw new Error("LAN_AND_CLOUD_MUST_BE_DISTINCT");
  const canonicalSite = expectedSite.toLowerCase();
  const path = resolve(output);
  const report = await loadReport(path, edgeOrigin, cloudOrigin, canonicalSite);
  checkSequence(report, stage, edgeOrigin, cloudOrigin, canonicalSite);
  const [edgeResult, cloudResult] = await Promise.all([
    probeEdge(edgeOrigin, canonicalSite, fetcher),
    probeCloud(cloud, fetcher),
  ]);
  const decision = evaluateStage(stage, edgeResult, cloudResult);
  const entry = {
    recordedAt: new Date().toISOString(),
    passed: decision.passed,
    failures: decision.failures,
    edge: edgeResult,
    cloud: cloudResult,
  };
  report.stages[stage] = entry;
  await saveReport(path, report);
  return { stage, ...entry, reportPath: path, replicationCertified: false };
}

function parseArgs(argv) {
  if (argv.includes("--help")) return { help: true };
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || !argv[i + 1]) throw new Error("INVALID_ARGUMENTS");
    const name = argv[i].slice(2);
    if (!["stage", "edge", "cloud", "expected-site", "output"].includes(name) ||
        Object.hasOwn(result, name)) throw new Error("INVALID_ARGUMENTS");
    result[name] = argv[i + 1];
  }
  return {
    stage: result.stage, edge: result.edge, cloud: result.cloud,
    expectedSite: result["expected-site"], output: result.output,
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log("node scripts/offline-phase5/acceptance.mjs --stage baseline|outage|restored --edge https://factory.lan --cloud https://cloud.example.com/health --expected-site UUID --output ./offline-acceptance.json");
      return 0;
    }
    const result = await runStage(options);
    console.log(JSON.stringify(result, null, 2));
    return result.passed ? 0 : 1;
  } catch (error) {
    // Controlled error codes only. Do not log raw URLs or exception payloads.
    const safeCodes = new Set(["UNKNOWN_STAGE", "INVALID_EXPECTED_SITE_UUID", "OUTPUT_FILE_REQUIRED",
      "INVALID_URL", "HTTPS_URL_WITHOUT_CREDENTIALS_REQUIRED", "LAN_AND_CLOUD_MUST_BE_DISTINCT",
      "REPORT_IDENTITY_MISMATCH", "INVALID_REPORT_PATH", "INVALID_REPORT", "PASS_BASELINE_FIRST",
      "BASELINE_ALREADY_ADVANCED", "OUTAGE_ALREADY_RESTORED", "PASS_OUTAGE_FIRST", "INVALID_ARGUMENTS"]);
    console.error(safeCodes.has(error.message) ? error.message : "OFFLINE_ACCEPTANCE_FAILED");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
