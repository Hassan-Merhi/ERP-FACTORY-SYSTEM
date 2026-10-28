import { randomUUID } from "node:crypto";
import { pool } from "../db";

// One global signal shared by all Render instances, companies, and user sessions.
// It is deliberately independent of the deployment/build version.
const SETTING_KEY = "global_force_refresh_token";
const READ_CACHE_MS = 2_000;

let cachedToken = "";
let cacheExpiresAt = 0;
let pendingRead: Promise<string> | null = null;

export async function readGlobalForceRefreshToken(): Promise<string> {
  if (Date.now() < cacheExpiresAt) return cachedToken;
  if (!pendingRead) {
    pendingRead = pool
      .query<{ value: string | null }>("SELECT value FROM system_settings WHERE key = $1", [SETTING_KEY])
      .then((result) => {
        cachedToken = result.rows[0]?.value ?? "";
        cacheExpiresAt = Date.now() + READ_CACHE_MS;
        return cachedToken;
      })
      .finally(() => {
        pendingRead = null;
      });
  }
  return pendingRead;
}

export async function issueGlobalForceRefresh(): Promise<{ token: string; issuedAt: Date } | null> {
  const token = randomUUID();
  const result = await pool.query<{ value: string; updated_at: Date }>(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()
     WHERE system_settings.updated_at < NOW() - INTERVAL '30 seconds'
     RETURNING value, updated_at`,
    [SETTING_KEY, token]
  );

  // A database-enforced cooldown stops accidental rapid repeated refreshes,
  // including requests handled by different Render instances.
  const row = result.rows[0];
  if (!row) return null;
  cachedToken = row.value;
  cacheExpiresAt = Date.now() + READ_CACHE_MS;
  return { token: row.value, issuedAt: row.updated_at };
}
