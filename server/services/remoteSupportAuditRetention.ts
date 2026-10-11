import { sql } from "drizzle-orm";
import { db } from "../db";
import { logger } from "../lib/logger";
import { AUDIT_LOG_MAINTENANCE_SETTING, AUDIT_LOG_RETENTION_MODE } from "./audit/auditLogRetentionPolicy";

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

/**
 * The scheduled audit retention job: the only code allowed to delete audit_log
 * rows (wave 12, owner decision 3). It runs in one transaction that sets the
 * transaction-local maintenance setting the append-only trigger checks, and
 * removes only remote-support rows; erp_audit_log_is_financial excludes any
 * financial row here and again in the trigger, so a financial row is kept
 * forever even if one were ever tagged with a remote_support_ action.
 */
export async function pruneRemoteSupportAuditRows(): Promise<void> {
  const days = retentionDays();
  const rowLimit = maxRows();

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config(${AUDIT_LOG_MAINTENANCE_SETTING}, ${AUDIT_LOG_RETENTION_MODE}, true)`);

    await tx.execute(sql`
      DELETE FROM audit_log
      WHERE (table_name = 'remote_support_sessions' OR action LIKE 'remote_support_%')
        AND NOT erp_audit_log_is_financial(table_name)
        AND created_at < now() - (${days} * interval '1 day')
    `);

    await tx.execute(sql`
      DELETE FROM audit_log AS audit
      WHERE audit.id IN (
        SELECT id
        FROM audit_log
        WHERE (table_name = 'remote_support_sessions' OR action LIKE 'remote_support_%')
          AND NOT erp_audit_log_is_financial(table_name)
        ORDER BY created_at DESC, id DESC
        OFFSET ${rowLimit}
      )
    `);
  });
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
