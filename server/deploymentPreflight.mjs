import { readFactoryEdgeConfiguration } from "./edge/edgeRuntimePolicy.mjs";
const isProduction = process.env.NODE_ENV === "production";
export const factoryEdgeRuntimeConfig = readFactoryEdgeConfiguration(process.env);

function parseBoundedInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    const message = `${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(raw)}`;
    if (isProduction) throw new Error(message);
    console.warn(`[DeploymentPreflight] ${message}; using ${fallback}`);
    return fallback;
  }
  return value;
}

function requireProductionSetting(name) {
  const value = process.env[name]?.trim();
  if (!value && isProduction) {
    throw new Error(`${name} is required in production`);
  }
  return value || null;
}

function resolveDatabaseSource() {
  if (process.env.DATABASE_URL?.trim()) return "DATABASE_URL";
  const pgKeys = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"];
  if (pgKeys.every((key) => process.env[key]?.trim())) return "PG_ENV";
  if (isProduction) {
    throw new Error("Production requires DATABASE_URL or the complete PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE set");
  }
  return "missing-development-database";
}

const sessionSecret = requireProductionSetting("SESSION_SECRET");
if (sessionSecret && sessionSecret.length < 32) {
  const message = "SESSION_SECRET must contain at least 32 characters";
  if (isProduction) throw new Error(message);
  console.warn(`[DeploymentPreflight] ${message}`);
}

const port = parseBoundedInteger("PORT", 5000, 1, 65535);
const sessionPoolMax = parseBoundedInteger("PG_SESSION_POOL_MAX", 3, 1, 20);
const shutdownGraceMs = parseBoundedInteger("SHUTDOWN_GRACE_MS", 25000, 1000, 120000);
const databaseSource = resolveDatabaseSource();
const buildVersion =
  process.env.BUILD_VERSION?.trim() ||
  process.env.RENDER_GIT_COMMIT?.trim()?.slice(0, 8) ||
  process.env.REPL_SLUG?.trim() ||
  "dev";

export const deploymentRuntimeConfig = Object.freeze({
  isProduction,
  port,
  sessionPoolMax,
  shutdownGraceMs,
  databaseSource,
  buildVersion,
  factoryEdgeMode: factoryEdgeRuntimeConfig.mode,
});

console.log("[DeploymentPreflight] configuration accepted", {
  environment: isProduction ? "production" : process.env.NODE_ENV || "development",
  port,
  databaseSource,
  buildVersion,
  sessionPoolMax,
  shutdownGraceMs,
});
