import { logger } from "../../lib/logger";

/**
 * Master-password impersonation is an emergency-only development capability.
 *
 * Production never accepts a shared master password. If legacy Render/env
 * configuration is still present, remove it from the process before auth routes
 * snapshot MASTER_PASSWORD so the capability is fail-closed without requiring a
 * production outage just to clean up stale environment variables.
 *
 * Outside production, merely setting MASTER_PASSWORD is still not enough:
 * operators must explicitly opt in and provide a future ISO expiry timestamp.
 * The expiry window is snapshotted here at process start but *enforced* at
 * each use via isMasterPasswordWindowActive(), so a lapsed window stops
 * working immediately — a long-lived server must never honor an expired
 * emergency password just because it has not been restarted yet.
 */
const configuredMasterPassword = process.env.MASTER_PASSWORD;
const hasAnyMasterPasswordConfiguration = Boolean(
  configuredMasterPassword || process.env.MASTER_PASSWORD_ENABLED || process.env.MASTER_PASSWORD_EXPIRES_AT
);

const isProduction = process.env.NODE_ENV === "production";
const explicitlyEnabled = !isProduction && process.env.MASTER_PASSWORD_ENABLED === "true";
const configuredExpiresAtMs =
  !isProduction && configuredMasterPassword && process.env.MASTER_PASSWORD_EXPIRES_AT
    ? Date.parse(process.env.MASTER_PASSWORD_EXPIRES_AT)
    : Number.NaN;
const hasValidFutureExpiry = Number.isFinite(configuredExpiresAtMs) && configuredExpiresAtMs > Date.now();

if (isProduction) {
  delete process.env.MASTER_PASSWORD;
  delete process.env.MASTER_PASSWORD_ENABLED;
  delete process.env.MASTER_PASSWORD_EXPIRES_AT;

  if (hasAnyMasterPasswordConfiguration) {
    logger.info("[Auth] Ignored legacy master-password configuration; impersonation is disabled in production.");
  }
} else if (configuredMasterPassword) {
  if (!explicitlyEnabled || !hasValidFutureExpiry) {
    delete process.env.MASTER_PASSWORD;
    logger.warn(
      "[Auth] MASTER_PASSWORD ignored. Emergency impersonation requires MASTER_PASSWORD_ENABLED=true and a future MASTER_PASSWORD_EXPIRES_AT ISO timestamp."
    );
  } else {
    logger.warn("[Auth] Emergency master-password impersonation is enabled temporarily.", {
      expiresAt: new Date(configuredExpiresAtMs).toISOString(),
    });
  }
}

/**
 * Runtime gate for the emergency master password. Auth routes must call this
 * on every attempt instead of trusting the module-level hash alone, so the
 * configured expiry window is honored even when the process outlives it.
 */
export function isMasterPasswordWindowActive(): boolean {
  if (isProduction) return false;
  if (!explicitlyEnabled) return false;
  if (!configuredMasterPassword) return false;
  return Number.isFinite(configuredExpiresAtMs) && configuredExpiresAtMs > Date.now();
}
