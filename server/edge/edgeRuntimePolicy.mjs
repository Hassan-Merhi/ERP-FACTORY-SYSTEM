/** Factory LAN edge: explicit opt-in, never inferred from network reachability. */
const SAFE_EDGE_HOSTS = new Set(["postgres", "db", "localhost", "127.0.0.1", "::1"]);
const PRIMARY_ACK = "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED";
const CLOUD_FENCE_ACK = "CLOUD_WRITES_DISABLED_FOR_FACTORY_HANDOFF";
// Only the reviewed HTTP verb + path pairs escape a read-only LAN fence.
// A future PUT/PATCH/DELETE route must never inherit a POST session exemption.
const SAFE_SESSION_WRITES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/set-company",
  "POST /api/csp-report",
]);

function parseSite(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function parseHostname(value) {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(value) &&
    !value.includes("..")
  );
}

export function readFactoryEdgeConfiguration(env = process.env) {
  const mode = env.FACTORY_EDGE_MODE || "cloud";
  if (mode !== "cloud" && mode !== "lan") throw new Error("EDGE_MODE_INVALID");
  if (mode === "cloud") {
    if (env.FACTORY_EDGE_WRITE_MODE || env.FACTORY_EDGE_PRIMARY_ACK) {
      throw new Error("EDGE_CLOUD_MISCONFIGURED");
    }
    const cloudWriteMode = env.FACTORY_CLOUD_WRITE_MODE || "primary";
    if (cloudWriteMode !== "primary" && cloudWriteMode !== "fenced") {
      throw new Error("CLOUD_WRITE_MODE_INVALID");
    }
    if (cloudWriteMode === "fenced" && env.FACTORY_CLOUD_FENCE_ACK !== CLOUD_FENCE_ACK) {
      throw new Error("CLOUD_FENCE_NOT_ACKNOWLEDGED");
    }
    if (cloudWriteMode === "primary" && env.FACTORY_CLOUD_FENCE_ACK) {
      throw new Error("CLOUD_FENCE_ACK_WITHOUT_FENCE");
    }
    return Object.freeze({
      mode: "cloud",
      siteId: null,
      hostname: null,
      writeMode: cloudWriteMode === "fenced" ? "fenced" : "cloud",
      primary: false,
    });
  }
  if (env.FACTORY_CLOUD_WRITE_MODE || env.FACTORY_CLOUD_FENCE_ACK) {
    throw new Error("EDGE_CLOUD_FENCE_MISCONFIGURED");
  }

  if (env.NODE_ENV !== "production") throw new Error("EDGE_REQUIRES_PRODUCTION");
  if (!parseSite(env.FACTORY_EDGE_SITE_ID)) throw new Error("EDGE_SITE_ID_INVALID");
  if (!parseHostname(env.FACTORY_EDGE_HOSTNAME)) throw new Error("EDGE_HOSTNAME_INVALID");
  if (env.DATABASE_URL) throw new Error("EDGE_DATABASE_URL_FORBIDDEN");
  if (!SAFE_EDGE_HOSTS.has(env.PGHOST || "")) throw new Error("EDGE_DATABASE_HOST_NOT_LOCAL");
  if (!env.PGUSER || !env.PGPASSWORD || !env.PGDATABASE || !env.PGPORT) {
    throw new Error("EDGE_DATABASE_UNCONFIGURED");
  }
  if (env.PGPASSWORD.length < 32 || /^REPLACE/i.test(env.PGPASSWORD)) {
    throw new Error("EDGE_DATABASE_PASSWORD_WEAK");
  }
  if (env.SESSION_SECRET && /^REPLACE/i.test(env.SESSION_SECRET)) {
    throw new Error("EDGE_SESSION_SECRET_PLACEHOLDER");
  }
  if (env.PGSSLMODE !== "disable") throw new Error("EDGE_DATABASE_MUST_USE_PRIVATE_NETWORK");
  if (env.CSRF_ENFORCE !== "1") throw new Error("EDGE_CSRF_REQUIRED");
  if (env.ENABLE_SCHEDULERS !== "false") throw new Error("EDGE_SCHEDULERS_MUST_BE_DISABLED");
  if (env.RUN_STARTUP_MIGRATIONS !== "true") throw new Error("EDGE_MIGRATIONS_REQUIRED");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 48) throw new Error("EDGE_SESSION_SECRET_WEAK");
  if (env.CAPACITOR_ENABLED === "true") throw new Error("EDGE_CROSS_ORIGIN_SESSIONS_DISABLED");
  const writeMode = env.FACTORY_EDGE_WRITE_MODE || "read-only";
  if (writeMode !== "read-only" && writeMode !== "lan-primary") throw new Error("EDGE_WRITE_MODE_INVALID");
  if (writeMode === "lan-primary" && env.FACTORY_EDGE_PRIMARY_ACK !== PRIMARY_ACK) {
    throw new Error("EDGE_PRIMARY_CUTOVER_NOT_ACKNOWLEDGED");
  }
  if (writeMode !== "lan-primary" && env.FACTORY_EDGE_PRIMARY_ACK) {
    throw new Error("EDGE_UNEXPECTED_PRIMARY_ACK");
  }
  // Phase 7: the operator ACK alone is not sufficient for authority.
  // The DB-installed fence must match an exact positive epoch and a verified
  // encrypted source baseline. An unconfigured/privileged DB role still blocks.
  const writerEpoch = env.FACTORY_EDGE_WRITER_EPOCH || "";
  const baselineSha256 = env.FACTORY_EDGE_BASELINE_SHA256 || "";
  if (writeMode === "lan-primary") {
    if (!/^[1-9][0-9]{0,14}$/.test(writerEpoch) || !Number.isSafeInteger(Number(writerEpoch))) {
      throw new Error("EDGE_PHASE7_WRITER_EPOCH_REQUIRED");
    }
    if (!/^[0-9a-f]{64}$/.test(baselineSha256)) {
      throw new Error("EDGE_PHASE7_BASELINE_DIGEST_REQUIRED");
    }
  } else if (writerEpoch || baselineSha256) {
    throw new Error("EDGE_PHASE7_EPOCH_WITHOUT_PRIMARY");
  }

  return Object.freeze({
    mode: "lan",
    siteId: env.FACTORY_EDGE_SITE_ID,
    hostname: env.FACTORY_EDGE_HOSTNAME,
    writeMode,
    primary: writeMode === "lan-primary",
    writerEpoch: writeMode === "lan-primary" ? writerEpoch : null,
    baselineSha256: writeMode === "lan-primary" ? baselineSha256 : null,
  });
}

export const PHASE9_PRESSING_CONFIRM_ROUTE = "POST /api/factory/pressing-machines/confirm";

// No module without atomic capture and validated replay is implicitly enabled
// by a one-time operator primary acknowledgement. Add routes only after
// end-to-end cloud acceptance tests, not when merely adding a UI queue.
const LAN_PRIMARY_CAPTURE_ALLOWLIST = new Set([
  "POST /api/vouchers/with-entries",
  // Phase 9: atomic pressing.confirmation.v1 capture -> signed stage ->
  // exactly-once cloud apply with conflict register -> verified LAN receipt.
  PHASE9_PRESSING_CONFIRM_ROUTE,
]);

export function edgeBlocksWrite(config, method, path) {
  const verb = String(method).toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(verb)) return false;
  if (SAFE_SESSION_WRITES.has(`${verb} ${path}`)) return false;
  if (config.mode === "cloud") return config.writeMode === "fenced";
  if (!config.primary) return true;
  return !LAN_PRIMARY_CAPTURE_ALLOWLIST.has(`${verb} ${path}`);
}

export function edgeStatusPayload(config, databaseProvisioned = false) {
  return {
    mode: config.mode,
    siteId: config.siteId,
    writeMode: config.writeMode,
    databaseProvisioned: Boolean(databaseProvisioned),
    // This indicator never asserts cloud replication is configured or complete.
    cloudReplication: "not-configured",
  };
}

export const EDGE_PRIMARY_ACK = PRIMARY_ACK;
export const CLOUD_WRITER_FENCE_ACK = CLOUD_FENCE_ACK;

/** LAN edge must never run cloud-derived post-startup repair/cleanup jobs. */
export function shouldStartEdgeBackgroundJobs(config) {
  return config.mode === "cloud" && config.writeMode !== "fenced";
}
