import { sql } from "drizzle-orm";
import { db } from "../db";
import { logger } from "../lib/logger";

const DEFAULT_RETENTION_DAYS = 180;
const DEFAULT_MAX_ROWS = 100_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

let installed = false;
let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let sweepInFlight = false;

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function retentionDays(): number {
  return boundedInteger(process.env.REMOTE_SUPPORT_AUDIT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, 30, 3650);
}

function maxRows(): number {
  return boundedInteger(process.env.REMOTE_SUPPORT_AUDIT_MAX_ROWS, DEFAULT_MAX_ROWS, 1_000, 1_000_000);
}

export async function pruneRemoteSupportAuditRows(): Promise<void> {
  const days = retentionDays();
  const rowLimit = maxRows();

  await db.execute(sql`
    DELETE FROM audit_log
    WHERE (table_name = 'remote_support_sessions' OR action LIKE 'remote_support_%')
      AND created_at < now() - (${days} * interval '1 day')
  `);

  await db.execute(sql`
    DELETE FROM audit_log AS audit
    WHERE audit.id IN (
      SELECT id
      FROM audit_log
      WHERE table_name = 'remote_support_sessions' OR action LIKE 'remote_support_%'
      ORDER BY created_at DESC, id DESC
      OFFSET ${rowLimit}
    )
  `);
}

async function runSweep(): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    await pruneRemoteSupportAuditRows();
  } catch (error) {
    logger.warn("[RemoteSupport] scheduled audit retention sweep failed", { error });
  } finally {
    sweepInFlight = false;
  }
}

export function installRemoteSupportAuditRetention(): void {
  if (installed) return;
  installed = true;

  initialTimer = setTimeout(() => void runSweep(), 60_000);
  (initialTimer as unknown as { unref?: () => void }).unref?.();

  timer = setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function resetRemoteSupportAuditRetentionForTests(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (timer) clearInterval(timer);
  initialTimer = null;
  timer = null;
  sweepInFlight = false;
  installed = false;
}
