/**
 * Phase 10 — per-command remote-support auditing off the critical path.
 *
 * Phases 5–7 wrote one `audit_log` row synchronously before every mouse or
 * keyboard command was published. That put a database round trip in front of
 * each pointer move, so control latency was bounded by audit latency and a slow
 * audit table made the remote cursor feel broken.
 *
 * This queue keeps the accountability contract while removing the round trip
 * from the request path:
 *
 *   - the row is *built* at enqueue time, so it still describes the exact
 *     session, route, and capability state the command was authorized under,
 *     and it is still redacted by the same builder;
 *   - rows are flushed in batches on a short interval, so a burst of pointer
 *     moves becomes one multi-row insert instead of N serialized inserts;
 *   - when the audit backend stops accepting writes the queue becomes
 *     *unhealthy*, and callers must refuse new commands. Control is never
 *     silently unaudited — it fails closed at the door instead of paying for
 *     the write per command.
 */
import { auditLog } from "@shared/schema";
import { db } from "../db";
import { logger } from "../lib/logger";
import { buildRemoteSupportAuditRow, type RemoteSupportAuditInput } from "./remoteSupportAuditService";

export interface RemoteSupportCommandAuditHealth {
  pending: number;
  accepting: boolean;
  consecutiveFailures: number;
  droppedRecords: number;
  writtenRecords: number;
  flushedBatches: number;
  lastFlushAt: number | null;
  lastFailureAt: number | null;
}

type AuditRow = ReturnType<typeof buildRemoteSupportAuditRow>;
type AuditRowWriter = (rows: AuditRow[]) => Promise<void>;

/** One insert carries at most this many rows so a backlog cannot build a giant statement. */
const MAX_BATCH_ROWS = 25;
/** Coalescing window. Short enough that a stopped session still lands promptly. */
const FLUSH_INTERVAL_MS = 250;
/** Hard backlog ceiling. Beyond this the queue is unhealthy and sheds the oldest rows. */
const MAX_PENDING_ROWS = 500;
/** Consecutive failed flushes tolerated before new commands are refused. */
const MAX_CONSECUTIVE_FAILURES = 3;

const pendingRows: AuditRow[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<number> | null = null;
let consecutiveFailures = 0;
let droppedRecords = 0;
let writtenRecords = 0;
let flushedBatches = 0;
let lastFlushAt: number | null = null;
let lastFailureAt: number | null = null;

const defaultWriter: AuditRowWriter = async (rows) => {
  await db.insert(auditLog).values(rows);
};
let writer: AuditRowWriter = defaultWriter;

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushRemoteSupportCommandAudits().catch(() => undefined);
  }, FLUSH_INTERVAL_MS);
  (flushTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * True while the queue can still guarantee the command will be recorded.
 * Callers must treat `false` as "refuse the command", never as "skip the audit".
 */
export function isRemoteSupportCommandAuditAccepting(): boolean {
  return consecutiveFailures < MAX_CONSECUTIVE_FAILURES && pendingRows.length < MAX_PENDING_ROWS;
}

/**
 * Records a per-command audit row without waiting for the database.
 * Returns false when the row could not be accepted, which means the caller
 * published (or is about to publish) something it cannot account for.
 */
export function enqueueRemoteSupportCommandAudit(input: RemoteSupportAuditInput): boolean {
  let row: AuditRow;
  try {
    row = buildRemoteSupportAuditRow(input);
  } catch (error) {
    logger.error("[RemoteSupport] unable to build a command audit row", {
      error,
      event: input.event,
      sessionId: input.session.id,
    });
    return false;
  }

  pendingRows.push(row);
  if (pendingRows.length > MAX_PENDING_ROWS) {
    const shed = pendingRows.splice(0, pendingRows.length - MAX_PENDING_ROWS);
    droppedRecords += shed.length;
    logger.error("[RemoteSupport] command audit backlog exceeded; oldest rows shed", {
      dropped: shed.length,
      pending: pendingRows.length,
    });
  }

  if (pendingRows.length >= MAX_BATCH_ROWS) {
    void flushRemoteSupportCommandAudits().catch(() => undefined);
  } else {
    scheduleFlush();
  }
  return isRemoteSupportCommandAuditAccepting();
}

async function flushOnce(): Promise<number> {
  let written = 0;
  while (pendingRows.length > 0) {
    const batch = pendingRows.splice(0, MAX_BATCH_ROWS);
    try {
      await writer(batch);
      written += batch.length;
      writtenRecords += batch.length;
      flushedBatches += 1;
      consecutiveFailures = 0;
      lastFlushAt = Date.now();
    } catch (error) {
      // The batch goes back to the front so ordering survives a transient
      // failure; a permanent failure trips the accepting gate instead.
      pendingRows.unshift(...batch);
      consecutiveFailures += 1;
      lastFailureAt = Date.now();
      logger.error("[RemoteSupport] batched command audit write failed", {
        error,
        pending: pendingRows.length,
        consecutiveFailures,
      });
      scheduleFlush();
      break;
    }
  }
  return written;
}

/** Drains the queue. Concurrent callers share one in-flight drain. */
export function flushRemoteSupportCommandAudits(): Promise<number> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = flushOnce().finally(() => {
    flushInFlight = null;
    if (pendingRows.length > 0) scheduleFlush();
  });
  return flushInFlight;
}

export function getRemoteSupportCommandAuditHealth(): RemoteSupportCommandAuditHealth {
  return {
    pending: pendingRows.length,
    accepting: isRemoteSupportCommandAuditAccepting(),
    consecutiveFailures,
    droppedRecords,
    writtenRecords,
    flushedBatches,
    lastFlushAt,
    lastFailureAt,
  };
}

/** Test seam: replaces the database writer. Passing null restores the real one. */
export function setRemoteSupportCommandAuditWriterForTests(next: AuditRowWriter | null): void {
  writer = next ?? defaultWriter;
}

export function resetRemoteSupportCommandAuditQueueForTests(): void {
  pendingRows.length = 0;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  flushInFlight = null;
  consecutiveFailures = 0;
  droppedRecords = 0;
  writtenRecords = 0;
  flushedBatches = 0;
  lastFlushAt = null;
  lastFailureAt = null;
  writer = defaultWriter;
}
