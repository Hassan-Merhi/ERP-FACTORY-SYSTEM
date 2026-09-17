import { sql } from "drizzle-orm";
import { db } from "../db";
import { logger } from "../lib/logger";

const PRESENCE_STALE_AFTER_MS = 3 * 60 * 1000;
const PRESENCE_SWEEP_INTERVAL_MS = 60 * 1000;
const ACTIVITY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const ACTIVITY_PER_USER_LIMIT = 200;
const DEFAULT_ACTIVITY_RETENTION_DAYS = 30;

let installed = false;
let presenceTimer: ReturnType<typeof setInterval> | null = null;
let activityTimer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function activityRetentionDays(): number {
  return boundedInteger(process.env.USER_ACTIVITY_RETENTION_DAYS, DEFAULT_ACTIVITY_RETENTION_DAYS, 1, 3650);
}

export async function pruneStalePresence(now = Date.now()): Promise<void> {
  const cutoff = new Date(now - PRESENCE_STALE_AFTER_MS);
  await db.execute(sql`DELETE FROM user_presence WHERE last_seen < ${cutoff}`);
}

export async function pruneUserActivityHistory(): Promise<void> {
  const retentionDays = activityRetentionDays();
  await db.execute(sql`
    DELETE FROM user_activity_log
    WHERE occurred_at < now() - (${retentionDays} * interval '1 day')
  `);

  await db.execute(sql`
    WITH ranked AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY user_id
               ORDER BY occurred_at DESC, id DESC
             ) AS row_num
      FROM user_activity_log
    )
    DELETE FROM user_activity_log AS activity
    USING ranked
    WHERE activity.id = ranked.id
      AND ranked.row_num > ${ACTIVITY_PER_USER_LIMIT}
  `);
}

async function runPresenceSweep(): Promise<void> {
  try {
    await pruneStalePresence();
  } catch (error) {
    logger.warn("[Presence] scheduled stale-row cleanup failed", { error });
  }
}

async function runActivitySweep(): Promise<void> {
  try {
    await pruneUserActivityHistory();
  } catch (error) {
    logger.warn("[Presence] scheduled activity-log cleanup failed", { error });
  }
}

export function installPresenceMaintenance(): void {
  if (installed) return;
  installed = true;

  initialTimer = setTimeout(() => {
    void runPresenceSweep();
    void runActivitySweep();
  }, 15_000);
  (initialTimer as unknown as { unref?: () => void }).unref?.();

  presenceTimer = setInterval(() => void runPresenceSweep(), PRESENCE_SWEEP_INTERVAL_MS);
  activityTimer = setInterval(() => void runActivitySweep(), ACTIVITY_SWEEP_INTERVAL_MS);
  (presenceTimer as unknown as { unref?: () => void }).unref?.();
  (activityTimer as unknown as { unref?: () => void }).unref?.();
}

export function resetPresenceMaintenanceForTests(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (presenceTimer) clearInterval(presenceTimer);
  if (activityTimer) clearInterval(activityTimer);
  initialTimer = null;
  presenceTimer = null;
  activityTimer = null;
  installed = false;
}
