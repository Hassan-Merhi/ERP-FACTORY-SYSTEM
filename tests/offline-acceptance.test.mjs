import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateUrl,
  classifyFailure,
  probeEdge,
  probeCloud,
  evaluateStage,
  runStage,
} from "../scripts/offline-phase5/acceptance.mjs";

const SITE = "4caa4fb0-9c6a-4a55-92d2-14f826879a5c";
const edgeUrl = "https://factory.lan";
const cloudUrl = "https://cloud.example.com/healthz";
const edgeStatus = (writeMode = "read-only", siteId = SITE) =>
  new Response(JSON.stringify({ mode: "lan", siteId, writeMode, replication: "not-configured" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const networkError = () => Object.assign(new Error("network down"), { cause: { code: "ENETUNREACH" } });
const tlsError = () => Object.assign(new Error("TLS failure"), { cause: { code: "CERT_HAS_EXPIRED" } });

test("edge URL rejects HTTP, credentials, query and unexpected path", () => {
  for (const bad of [
    "http://factory.lan",
    "https://user:pass@factory.lan",
    "https://factory.lan?key=secret",
    "https://factory.lan/some-api",
    "https://factory.lan/#x",
  ]) {
    assert.throws(() => validateUrl(bad, { edge: true }));
  }
  assert.equal(validateUrl(edgeUrl, { edge: true }).origin, edgeUrl);
});

test("classifies TLS separately from genuine network disconnect", () => {
  assert.equal(classifyFailure(tlsError()), "tls-error");
  assert.equal(classifyFailure(networkError()), "network-error");
  assert.equal(classifyFailure(new Error("anything else")), "unknown-error");
});

test("edge validates exact site and explicit mode before certification", async () => {
  const wrong = await probeEdge(edgeUrl, SITE, async () =>
    edgeStatus("lan-primary", "ae8959c5-c30f-4364-a087-d69b8b086fc0")
  );
  assert.equal(wrong.reason, "EDGE_SITE_MISMATCH");
  const missing = await probeEdge(
    edgeUrl,
    SITE,
    async () => new Response(JSON.stringify({ mode: "lan", siteId: SITE }), { status: 200 })
  );
  assert.equal(missing.reason, "EDGE_STATUS_CONTRACT_UNKNOWN");
  const good = await probeEdge(edgeUrl, SITE, async () => edgeStatus("lan-primary"));
  assert.deepEqual(good, { ok: true, siteId: SITE, writeMode: "lan-primary" });
});

test("never treats HTTP 503 or certificate failure as disconnected WAN", async () => {
  const error503 = await probeCloud(cloudUrl, async () => new Response("down", { status: 503 }));
  assert.equal(error503.reachable, true);
  assert.equal(evaluateStage("outage", { ok: true, writeMode: "lan-primary" }, error503).passed, false);
  const invalidTls = await probeCloud(cloudUrl, async () => {
    throw tlsError();
  });
  assert.equal(invalidTls.reason, "tls-error");
  assert.equal(evaluateStage("outage", { ok: true, writeMode: "lan-primary" }, invalidTls).passed, false);
});

test("an outage with read-only edge fails even if cloud is absent", () => {
  const result = evaluateStage(
    "outage",
    { ok: true, writeMode: "read-only" },
    { reachable: false, reason: "network-error" }
  );
  assert.deepEqual(result.failures, ["EDGE_NOT_PRIMARY_FOR_OFFLINE_WRITES"]);
});

test("refuses restored stage without baseline and outage evidence", async () => {
  const folder = await mkdtemp(join(tmpdir(), "offline-phase5-"));
  try {
    const fetcher = async (url) => (url.includes("/api/edge/") ? edgeStatus() : new Response("ok"));
    await assert.rejects(
      runStage(
        { stage: "restored", edge: edgeUrl, cloud: cloudUrl, expectedSite: SITE, output: join(folder, "report.json") },
        { fetcher }
      ),
      /PASS_OUTAGE_FIRST/
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("three-stage acceptance persists minimal results and never claims replication verified", async () => {
  const folder = await mkdtemp(join(tmpdir(), "offline-phase5-"));
  const output = join(folder, "report.json");
  let mode = "read-only";
  let cloudOnline = true;
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    if (url === edgeUrl + "/api/edge/status") return edgeStatus(mode);
    if (!cloudOnline) throw networkError();
    return new Response("ok");
  };
  const opts = { edge: edgeUrl, cloud: cloudUrl, expectedSite: SITE, output };
  try {
    const baseline = await runStage({ ...opts, stage: "baseline" }, { fetcher });
    assert.equal(baseline.passed, true);
    mode = "lan-primary";
    cloudOnline = false;
    const outage = await runStage({ ...opts, stage: "outage" }, { fetcher });
    assert.equal(outage.passed, true);
    cloudOnline = true;
    const restored = await runStage({ ...opts, stage: "restored" }, { fetcher });
    assert.equal(restored.passed, true);
    assert.equal(restored.replicationCertified, false);
    const file = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(Object.keys(file.stages), ["baseline", "outage", "restored"]);
    assert.equal(file.certification, "LAN_CONNECTIVITY_ONLY_NO_REPLICATION_ASSERTION");
    assert.equal(JSON.stringify(file).includes("not-configured"), false);
    assert.equal(JSON.stringify(file).includes("ok"), true);
    assert.equal(requests.length, 6);
    for (const { init } of requests) {
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, "omit");
      assert.equal(init.headers.Authorization, undefined);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("failed outage persists visible failure and can be rerun safely", async () => {
  const folder = await mkdtemp(join(tmpdir(), "offline-phase5-"));
  const output = join(folder, "report.json");
  let cloudOnline = true;
  const fetcher = async (url) => {
    if (url.includes("/api/edge/")) return edgeStatus("lan-primary");
    if (cloudOnline) return new Response("ok");
    throw networkError();
  };
  const opts = { edge: edgeUrl, cloud: cloudUrl, expectedSite: SITE, output };
  try {
    await runStage({ ...opts, stage: "baseline" }, { fetcher });
    const failed = await runStage({ ...opts, stage: "outage" }, { fetcher });
    assert.equal(failed.passed, false);
    assert.ok(failed.failures.includes("WAN_NOT_VERIFIABLY_DISCONNECTED"));
    cloudOnline = false;
    const retried = await runStage({ ...opts, stage: "outage" }, { fetcher });
    assert.equal(retried.passed, true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
