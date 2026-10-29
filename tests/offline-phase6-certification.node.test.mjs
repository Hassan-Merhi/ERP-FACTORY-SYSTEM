import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  certify,
  checkReleaseManifest,
  probeEdge,
  probeReleaseVersion,
  validateHttpsOrigin,
  REQUIRED_DRILLS,
} from "../scripts/edge/certify-offline-phase6.mjs";

const RELEASE_SHA = "a".repeat(40);
const NOW = Date.parse("2026-10-30T09:00:00Z");
const READY = {
  status: "ready",
  listening: true,
  shuttingDown: false,
  environmentValid: true,
  database: { ok: true, schema: { ok: true }, edgeDataProvisioned: true },
};
function response(status, body) {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => JSON.stringify(body),
  };
}
async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "erp-phase6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const drills = {};
  for (const [i, key] of REQUIRED_DRILLS.entries()) {
    const file = "proof-" + i + ".txt";
    const bytes = "validated evidence " + key;
    await writeFile(path.join(root, file), bytes);
    drills[key] = {
      result: "pass",
      releaseSha: RELEASE_SHA,
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      recordedAt: "2026-10-30T08:00:00Z",
    };
  }
  const manifest = {
    version: 1,
    environment: "staging",
    releaseSha: RELEASE_SHA,
    siteId: "123e4567-e89b-42d3-a456-426614174000",
    edgeOrigin: "https://erp.factory.internal",
    expectedWriteMode: "read-only",
    drills,
  };
  return { root, manifest };
}

test("HTTPS origin validation forbids credentials, redirects, and paths", () => {
  assert.equal(validateHttpsOrigin("https://erp.factory.internal"), true);
  for (const unsafe of [
    "http://erp.factory.internal",
    "https://u:p@erp.factory.internal",
    "https://erp.factory.internal/hidden",
    "https://erp.factory.internal?x=1",
    "https://erp.factory.internal/#token",
    "https://erp.factory.internal:443/",
  ]) {
    assert.equal(validateHttpsOrigin(unsafe), false, unsafe);
  }
});

test("every drill with matching exact-head integrity proof passes local validation", async (t) => {
  const { root, manifest } = await makeFixture(t);
  assert.deepEqual(await checkReleaseManifest(manifest, { evidenceRoot: root, now: NOW }), { ok: true, blockers: [] });
});

test("missing Phase 4 / 5 drills and stale CI cannot certify", async (t) => {
  const { root, manifest } = await makeFixture(t);
  delete manifest.drills["phase4-sync-verified"];
  manifest.drills["phase5-conflict-resolution"].releaseSha = "b".repeat(40);
  manifest.drills["exact-head-ci"].recordedAt = "2026-09-01T08:00:00Z";
  const result = await checkReleaseManifest(manifest, { evidenceRoot: root, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers.map((x) => x.code).sort(), [
    "DRILL_MISSING_OR_INVALID",
    "DRILL_MISSING_OR_INVALID",
    "STALE_OR_INVALID_EVIDENCE",
  ]);
});

test("evidence tampering, duplicate proof, and symlink escape fail closed", async (t) => {
  const { root, manifest } = await makeFixture(t);
  await writeFile(path.join(root, "proof-0.txt"), "tampered");
  manifest.drills["independent-security-review"].file = "proof-0.txt";
  const outside = await mkdtemp(path.join(os.tmpdir(), "erp-phase6-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "external.txt"), "secret");
  await symlink(path.join(outside, "external.txt"), path.join(root, "escape.txt"));
  manifest.drills["phase4-sync-verified"].file = "escape.txt";
  const result = await checkReleaseManifest(manifest, { evidenceRoot: root, now: NOW });
  assert.equal(result.ok, false);
  assert(result.blockers.some((x) => x.code === "REUSED_EVIDENCE_FILE"));
  assert(result.blockers.some((x) => x.code === "EVIDENCE_INTEGRITY_FAILED"));
});

test("invalid or unapproved manifest never probes network", async (t) => {
  const { root, manifest } = await makeFixture(t);
  manifest.environment = "production";
  const result = await certify(manifest, {
    evidenceRoot: root,
    now: NOW,
    fetcher: () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.blockers[0].code, "INVALID_MANIFEST");
});

test("offline-only validation never claims full certification", async (t) => {
  const { root, manifest } = await makeFixture(t);
  const result = await certify(manifest, { evidenceRoot: root, now: NOW, noNetwork: true });
  assert.equal(result.ok, false);
  assert.equal(result.blockers[0].code, "LIVE_PROBE_REQUIRED");
});

test("LAN status and health probes must be healthy and replicated", async () => {
  const config = { siteId: "123e4567-e89b-42d3-a456-426614174000", expectedWriteMode: "read-only" };
  const healthy = async (url) =>
    response(
      200,
      url.endsWith("/api/edge/status")
        ? {
            mode: "lan",
            siteId: config.siteId,
            writeMode: "read-only",
            databaseProvisioned: true,
            cloudReplication: "verified",
          }
        : READY
    );
  assert.deepEqual(await probeEdge("https://erp.factory.internal", { ...config, fetcher: healthy }), []);
  const incomplete = async (url) =>
    response(
      200,
      url.endsWith("/api/edge/status")
        ? {
            mode: "lan",
            siteId: config.siteId,
            writeMode: "read-only",
            databaseProvisioned: true,
            cloudReplication: "not-configured",
          }
        : READY
    );
  const blocked = await probeEdge("https://erp.factory.internal", { ...config, fetcher: incomplete });
  assert.deepEqual(
    blocked.map((x) => x.code),
    ["EDGE_PROBE_UNSAFE_STATE"]
  );
  const unknown = await probeEdge("https://erp.factory.internal", {
    ...config,
    fetcher: async (url) =>
      response(
        200,
        url.endsWith("/api/edge/status")
          ? {
              mode: "lan",
              siteId: config.siteId,
              writeMode: "read-only",
              databaseProvisioned: true,
              cloudReplication: "error",
            }
          : READY
      ),
  });
  assert.deepEqual(
    unknown.map((x) => x.code),
    ["EDGE_PROBE_UNSAFE_STATE"]
  );
});

test("a successful HTTP status does not override failed readiness conditions", async () => {
  const base = { siteId: "factory", expectedWriteMode: "read-only" };
  const status = {
    mode: "lan", siteId: "factory", writeMode: "read-only",
    databaseProvisioned: true, cloudReplication: "verified",
  };
  for (const faulty of [
    { ...READY, status: "not_ready" },
    { ...READY, listening: false },
    { ...READY, shuttingDown: true },
    { ...READY, environmentValid: false },
    { ...READY, database: { ok: false, schema: { ok: true } } },
    { ...READY, database: { ok: true, schema: { ok: false } } },
    { ...READY, database: { ok: true, schema: { ok: true }, edgeDataProvisioned: false } },
  ]) {
    const result = await probeEdge("https://erp.factory.internal", {
      ...base,
      fetcher: async (url) => response(200, url.endsWith("/api/edge/status") ? status : faulty),
    });
    assert.deepEqual(result.map((x) => x.code), ["EDGE_PROBE_UNSAFE_STATE"]);
    assert.equal(result[0].endpoint, "/api/health/ready");
  }
});

test("the deployed build SHA must exactly match every release-proof SHA", async (t) => {
  const { root, manifest } = await makeFixture(t);
  const seen = [];
  const network = (version) => async (url, options) => {
    seen.push({ url, options });
    if (url.endsWith("/api/edge/status")) {
      return response(200, {
        mode: "lan", siteId: manifest.siteId, writeMode: manifest.expectedWriteMode,
        databaseProvisioned: true, cloudReplication: "verified",
      });
    }
    if (url.endsWith("/api/health/ready")) return response(200, READY);
    if (url.endsWith("/api/build-info")) return response(200, { version });
    throw new Error("Unexpected endpoint: " + url);
  };
  const success = await certify(manifest, { evidenceRoot: root, now: NOW, fetcher: network(RELEASE_SHA) });
  assert.deepEqual(success, { ok: true, blockers: [] });
  assert.deepEqual(
    seen.map((x) => new URL(x.url).pathname),
    ["/api/edge/status", "/api/health/ready", "/api/build-info"]
  );
  assert(seen.every((x) => x.options.method === "GET" && x.options.redirect === "manual"));
  const mismatch = await certify(manifest, {
    evidenceRoot: root, now: NOW, fetcher: network("b".repeat(40)),
  });
  assert.deepEqual(mismatch.blockers.map((x) => x.code), ["BUILD_VERSION_MISMATCH"]);
  assert.equal(mismatch.ok, false);
  const missing = await probeReleaseVersion(manifest.edgeOrigin, RELEASE_SHA, async () => response(404, {}));
  assert.deepEqual(missing.map((x) => x.code), ["BUILD_VERSION_PROBE_FAILED"]);
  const unreachable = await probeReleaseVersion(manifest.edgeOrigin, RELEASE_SHA, async () => {
    throw new Error("Network disconnected");
  });
  assert.deepEqual(unreachable.map((x) => x.code), ["BUILD_VERSION_UNREACHABLE"]);
});

test("unreachable, HTTP error and redirects cannot pass the status probe", async () => {
  const base = { siteId: "site", expectedWriteMode: "read-only" };
  const unreachable = await probeEdge("https://example.test", {
    ...base,
    fetcher: async () => {
      throw new Error("WAN cut");
    },
  });
  assert.equal(unreachable.length, 2);
  assert(unreachable.every((x) => x.code === "EDGE_PROBE_UNREACHABLE"));
  const redirect = await probeEdge("https://example.test", { ...base, fetcher: async () => response(302, {}) });
  assert(redirect.every((x) => x.code === "EDGE_PROBE_FAILED"));
});
