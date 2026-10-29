/** Factory LAN edge: explicit opt-in, never inferred from network reachability. */
const SAFE_EDGE_HOSTS = new Set(["postgres", "db", "localhost", "127.0.0.1", "::1"]);
const PRIMARY_ACK = "CLOUD_WRITES_FENCED_AND_EDGE_DATA_APPROVED";
const SAFE_SESSION_PATHS = new Set(["/api/auth/login", "/api/auth/logout", "/api/auth/set-company", "/api/csp-report"]);

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
    return Object.freeze({ mode: "cloud", siteId: null, hostname: null, writeMode: "cloud", primary: false });
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

  return Object.freeze({
    mode: "lan",
    siteId: env.FACTORY_EDGE_SITE_ID,
    hostname: env.FACTORY_EDGE_HOSTNAME,
    writeMode,
    primary: writeMode === "lan-primary",
  });
}

export function edgeBlocksWrite(config, method, path) {
  if (config.mode !== "lan" || config.primary) return false;
  if (["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase())) return false;
  return !SAFE_SESSION_PATHS.has(path);
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

/** LAN edge must never run cloud-derived post-startup repair/cleanup jobs. */
export function shouldStartEdgeBackgroundJobs(config) {
  return config.mode !== "lan";
}
