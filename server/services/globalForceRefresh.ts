import { randomUUID } from "node:crypto";
import { pool } from "../db";

export type ForceRefreshTarget = "regular" | "privileged";

// Keep the legacy key for regular users so already-open clients can receive
// regular-user commands. Privileged users have an independent signal.
const SETTING_KEYS: Record<ForceRefreshTarget, string> = {
  regular: "global_force_refresh_token",
  privileged: "global_force_refresh_privileged_token",
};
const READ_CACHE_MS = 2_000;

type TokenCache = { token: string; expiresAt: number; pending: Promise<string> | null };
const caches: Record<ForceRefreshTarget, TokenCache> = {
  regular: { token: "", expiresAt: 0, pending: null },
  privileged: { token: "", expiresAt: 0, pending: null },
};

export async function readGlobalForceRefreshToken(target: ForceRefreshTarget = "regular"): Promise<string> {
  const cache = caches[target];
  if (Date.now() < cache.expiresAt) return cache.token;
  if (!cache.pending) {
    // Until the privileged token is first written, fall back to the legacy
    // token. This prevents existing admin/owner/dev tabs reloading just because
    // the new scoped implementation was deployed.
    const query = target === "privileged"
      ? pool.query<{ value: string | null }>(
          `SELECT COALESCE(
             (SELECT value FROM system_settings WHERE key = $1),
             (SELECT value FROM system_settings WHERE key = $2),
             ''
           ) AS value`,
          [SETTING_KEYS.privileged, SETTING_KEYS.regular]
        )
      : pool.query<{ value: string | null }>(
          "SELECT value FROM system_settings WHERE key = $1",
          [SETTING_KEYS.regular]
        );

    cache.pending = query
      .then((result) => {
        cache.token = result.rows[0]?.value ?? "";
        cache.expiresAt = Date.now() + READ_CACHE_MS;
        return cache.token;
      })
      .finally(() => {
        cache.pending = null;
      });
  }
  return cache.pending;
}

export async function issueGlobalForceRefresh(
  target: ForceRefreshTarget = "regular"
): Promise<{ token: string; issuedAt: Date } | null> {
  if (target === "regular") {
    // Freeze the privileged baseline BEFORE changing the legacy token. Without
    // this, the privileged fallback above would follow regular-user refreshes
    // until the first privileged command, inadvertently refreshing admins.
    await pool.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES (
         $1,
         COALESCE((SELECT value FROM system_settings WHERE key = $2), ''),
         NOW() - INTERVAL '1 day'
       )
       ON CONFLICT (key) DO NOTHING`,
      [SETTING_KEYS.privileged, SETTING_KEYS.regular]
    );
  }

  const token = randomUUID();
  const result = await pool.query<{ value: string; updated_at: Date }>(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()
     WHERE system_settings.updated_at < NOW() - INTERVAL '30 seconds'
     RETURNING value, updated_at`,
    [SETTING_KEYS[target], token]
  );

  // Each target has its own database-enforced 30-second cooldown, including
  // requests handled by different Render instances.
  const row = result.rows[0];
  if (!row) return null;
  const cache = caches[target];
  cache.token = row.value;
  cache.expiresAt = Date.now() + READ_CACHE_MS;
  return { token: row.value, issuedAt: row.updated_at };
}
