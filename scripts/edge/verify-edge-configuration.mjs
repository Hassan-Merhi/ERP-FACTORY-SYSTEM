import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFactoryEdgeConfiguration } from "../../server/edge/edgeRuntimePolicy.mjs";

function assertLocalIp(ip) {
  if (isIP(ip) !== 4) throw new Error("EDGE_BIND_IP_MUST_BE_IPV4");
  const octets = ip.split(".").map(Number);
  const privateLan = octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
  if (!privateLan) throw new Error("EDGE_BIND_IP_NOT_PRIVATE");
}

/** Strict dotenv-style key/value file. No shell evaluation or interpolation. */
export function parseEdgeEnvironment(raw) {
  const result = {};
  const allowedKeys = new Set([
    "EDGE_SITE_ID", "EDGE_HOSTNAME", "EDGE_BIND_IP",
    "EDGE_DB_PASSWORD", "EDGE_SESSION_SECRET",
    "EDGE_RELEASE_SHA", "EDGE_WRITER_EPOCH", "EDGE_BASELINE_SHA256",
    "EDGE_WRITE_MODE", "EDGE_PRIMARY_ACK",
    "EDGE_BACKUP_AGE_RECIPIENT",
    "EDGE_SYNC_REMOTE", "EDGE_SYNC_SIGNING_KEY",
    "EDGE_SYNC_CLOUD_URL", "EDGE_SYNC_API_KEY",
  ]);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || !allowedKeys.has(match[1])) throw new Error("EDGE_ENV_UNRECOGNIZED_LINE");
    const key = match[1];
    if (Object.hasOwn(result, key)) throw new Error("EDGE_ENV_DUPLICATE_KEY");
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    if (/[\r\n`$]/.test(value)) throw new Error("EDGE_ENV_UNSAFE_VALUE");
    result[key] = value;
  }
  return result;
}

/** Cert/key must match and cert must cover LAN hostname for at least one week. */
export function verifyEdgeTlsCertificate(certPem, keyPem, hostname, now = Date.now()) {
  const certificate = new X509Certificate(certPem);
  const privateKey = createPrivateKey(keyPem);
  const publicFromKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const publicFromCert = certificate.publicKey.export({ type: "spki", format: "der" });
  if (!publicFromKey.equals(publicFromCert)) throw new Error("EDGE_TLS_KEY_MISMATCH");
  if (Date.parse(certificate.validFrom) > now) throw new Error("EDGE_TLS_NOT_VALID_YET");
  if (Date.parse(certificate.validTo) < now + 7 * 24 * 60 * 60 * 1000) {
    throw new Error("EDGE_TLS_EXPIRED_OR_EXPIRING");
  }
  const san = certificate.subjectAltName ?? "";
  const names = san.split(",").map(x => x.trim()).filter(x => x.startsWith("DNS:")).map(x => x.slice(4).toLowerCase());
  if (!names.includes(hostname.toLowerCase())) throw new Error("EDGE_TLS_HOSTNAME_NOT_IN_SAN");
  return { expiresAt: certificate.validTo, hostname };
}

export function verifyEdgeInstallation(env, certPem, keyPem) {
  assertLocalIp(env.EDGE_BIND_IP);
  const config = readFactoryEdgeConfiguration({
    NODE_ENV: "production",
    FACTORY_EDGE_MODE: "lan",
    FACTORY_EDGE_SITE_ID: env.EDGE_SITE_ID,
    FACTORY_EDGE_HOSTNAME: env.EDGE_HOSTNAME,
    FACTORY_EDGE_WRITE_MODE: env.EDGE_WRITE_MODE,
    FACTORY_EDGE_PRIMARY_ACK: env.EDGE_PRIMARY_ACK,
    FACTORY_EDGE_WRITER_EPOCH: env.EDGE_WRITER_EPOCH,
    FACTORY_EDGE_BASELINE_SHA256: env.EDGE_BASELINE_SHA256,
    PGHOST: "postgres",
    PGPORT: "5432",
    PGUSER: "erp_edge",
    PGPASSWORD: env.EDGE_DB_PASSWORD,
    PGDATABASE: "erp_edge",
    PGSSLMODE: "disable",
    SESSION_SECRET: env.EDGE_SESSION_SECRET,
    CSRF_ENFORCE: "1",
    ENABLE_SCHEDULERS: "false",
    RUN_STARTUP_MIGRATIONS: "true",
  });
  verifyEdgeTlsCertificate(certPem, keyPem, config.hostname);
  return config;
}

const invokedAsScript = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const deployDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../deploy/lan");
  const envPath = resolve(process.argv[2] || resolve(deployDir, ".env"));
  try {
    if (!existsSync(envPath)) throw new Error("EDGE_ENV_MISSING");
    const mode = statSync(envPath).mode & 0o077;
    if (mode !== 0) throw new Error("EDGE_ENV_PERMISSIONS_NOT_PRIVATE");
    const values = parseEdgeEnvironment(readFileSync(envPath, "utf8"));
    const certPath = resolve(deployDir, "certs/server.pem");
    const keyPath = resolve(deployDir, "certs/server-key.pem");
    if (!existsSync(certPath) || !existsSync(keyPath)) throw new Error("EDGE_TLS_FILES_MISSING");
    if ((statSync(keyPath).mode & 0o077) !== 0) throw new Error("EDGE_TLS_KEY_PERMISSIONS_NOT_PRIVATE");
    const config = verifyEdgeInstallation(values, readFileSync(certPath), readFileSync(keyPath));
    console.log("Factory edge preflight PASSED", {
      siteId: config.siteId,
      hostname: config.hostname,
      writeMode: config.writeMode,
      replication: "not-configured",
    });
  } catch (error) {
    console.error("Factory edge preflight FAILED", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
