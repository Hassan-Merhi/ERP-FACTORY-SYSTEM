/**
 * Permanent audit for passive screen viewing (watch start / watch end).
 *
 * Interactive control already records session_started / session_stopped. Passive
 * viewing previously left no trail even though frames were being streamed. These
 * rows share the remote_support_sessions module so the existing company-scoped
 * audit endpoint surfaces them without a new table.
 */
import { auditLog } from "@shared/schema";
import { db } from "../db";
import { logger } from "../lib/logger";

export type ScreenWatchAuditEvent = "screen_watch_started" | "screen_watch_ended";

export interface ScreenWatchAuditInput {
  event: ScreenWatchAuditEvent;
  companyId: number;
  controllerUserId: string;
  controllerUsername: string;
  controllerRole: string;
  targetUserId: string;
  targetUsername?: string;
  watchId?: string;
  route?: string | null;
  stopReason?: string | null;
}

interface ActiveScreenWatch {
  watchId: string;
  companyId: number;
  controllerUserId: string;
  controllerUsername: string;
  controllerRole: string;
  targetUserId: string;
  targetUsername: string;
  startedAt: number;
  lastSeenAt: number;
}

const WATCH_TTL_MS = 15_000;
const activeWatches = new Map<string, ActiveScreenWatch>();
let sweeperInstalled = false;
let sweeperTimer: ReturnType<typeof setInterval> | null = null;

function watchKey(controllerUserId: string, targetUserId: string): string {
  return `${controllerUserId}::${targetUserId}`;
}

function boundedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function buildWatchAuditRow(input: ScreenWatchAuditInput) {
  const watchId =
    boundedText(input.watchId, 128) ??
    `watch:${input.controllerUserId}:${input.targetUserId}:${Date.now()}`;
  return {
    userId: boundedText(input.controllerUserId, 128) ?? "unknown",
    username: boundedText(input.controllerUsername, 160) ?? input.controllerUserId,
    companyId: input.companyId,
    action: `remote_support_${input.event}`,
    tableName: "remote_support_sessions",
    recordId: null as number | null,
    recordIdentifier: watchId,
    changes: {
      event: { new: input.event },
      controllerUserId: { new: input.controllerUserId },
      controllerUsername: { new: boundedText(input.controllerUsername, 160) },
      controllerRole: { new: boundedText(input.controllerRole, 80) },
      targetUserId: { new: input.targetUserId },
      targetUsername: { new: boundedText(input.targetUsername, 160) },
      capability: { new: "view" },
      scope: { new: "screen-watch" },
      ...(input.route ? { route: { new: boundedText(input.route, 300) ?? "/" } } : {}),
      ...(input.stopReason
        ? { stopReason: { new: boundedText(input.stopReason, 120) } }
        : {}),
    },
  };
}

export async function writeScreenWatchAudit(input: ScreenWatchAuditInput): Promise<void> {
  try {
    await db.insert(auditLog).values(buildWatchAuditRow(input));
  } catch (error) {
    logger.error("[RemoteSupport] screen watch audit write failed", {
      error,
      event: input.event,
      companyId: input.companyId,
      targetUserId: input.targetUserId,
    });
    // Viewing must remain available even when the audit backend is down; the
    // failure is logged so operators can see the gap. Interactive control still
    // fails closed through the command audit queue.
  }
}

function ensureSweeper(): void {
  if (sweeperInstalled) return;
  sweeperInstalled = true;
  sweeperTimer = setInterval(() => {
    void expireStaleScreenWatches();
  }, 5_000);
  (sweeperTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * Marks a controller as actively watching a target. Writes screen_watch_started
 * only on the first observation of the pair; subsequent polls/heartbeats refresh
 * the TTL without producing duplicate rows.
 */
export async function beginScreenWatch(input: {
  companyId: number;
  controllerUserId: string;
  controllerUsername: string;
  controllerRole: string;
  targetUserId: string;
  targetUsername?: string;
  route?: string | null;
  now?: number;
}): Promise<{ watchId: string; started: boolean }> {
  ensureSweeper();
  const now = input.now ?? Date.now();
  const key = watchKey(input.controllerUserId, input.targetUserId);
  const existing = activeWatches.get(key);
  if (existing) {
    existing.lastSeenAt = now;
    existing.companyId = input.companyId;
    if (input.targetUsername) existing.targetUsername = input.targetUsername;
    return { watchId: existing.watchId, started: false };
  }

  const watchId = `watch:${input.controllerUserId}:${input.targetUserId}:${now}`;
  activeWatches.set(key, {
    watchId,
    companyId: input.companyId,
    controllerUserId: input.controllerUserId,
    controllerUsername: input.controllerUsername,
    controllerRole: input.controllerRole,
    targetUserId: input.targetUserId,
    targetUsername: input.targetUsername ?? input.targetUserId,
    startedAt: now,
    lastSeenAt: now,
  });

  await writeScreenWatchAudit({
    event: "screen_watch_started",
    companyId: input.companyId,
    controllerUserId: input.controllerUserId,
    controllerUsername: input.controllerUsername,
    controllerRole: input.controllerRole,
    targetUserId: input.targetUserId,
    targetUsername: input.targetUsername,
    watchId,
    route: input.route,
  });

  return { watchId, started: true };
}

/**
 * Ends an active watch pair and writes screen_watch_ended when one was open.
 */
export async function endScreenWatch(input: {
  controllerUserId: string;
  targetUserId: string;
  stopReason?: string | null;
  now?: number;
}): Promise<boolean> {
  const key = watchKey(input.controllerUserId, input.targetUserId);
  const existing = activeWatches.get(key);
  if (!existing) return false;
  activeWatches.delete(key);

  await writeScreenWatchAudit({
    event: "screen_watch_ended",
    companyId: existing.companyId,
    controllerUserId: existing.controllerUserId,
    controllerUsername: existing.controllerUsername,
    controllerRole: existing.controllerRole,
    targetUserId: existing.targetUserId,
    targetUsername: existing.targetUsername,
    watchId: existing.watchId,
    stopReason: input.stopReason ?? "viewer-closed",
  });
  return true;
}

/** Ends every watch held by a controller (e.g. emergency stop / logout). */
export async function endAllScreenWatchesForController(
  controllerUserId: string,
  stopReason = "controller-cleared"
): Promise<number> {
  let ended = 0;
  for (const [key, watch] of activeWatches.entries()) {
    if (watch.controllerUserId !== controllerUserId) continue;
    activeWatches.delete(key);
    await writeScreenWatchAudit({
      event: "screen_watch_ended",
      companyId: watch.companyId,
      controllerUserId: watch.controllerUserId,
      controllerUsername: watch.controllerUsername,
      controllerRole: watch.controllerRole,
      targetUserId: watch.targetUserId,
      targetUsername: watch.targetUsername,
      watchId: watch.watchId,
      stopReason,
    });
    ended += 1;
  }
  return ended;
}

/** Ends every watch of a target user (e.g. feed disabled). */
export async function endAllScreenWatchesForTarget(
  targetUserId: string,
  stopReason = "target-cleared"
): Promise<number> {
  let ended = 0;
  for (const [key, watch] of activeWatches.entries()) {
    if (watch.targetUserId !== targetUserId) continue;
    activeWatches.delete(key);
    await writeScreenWatchAudit({
      event: "screen_watch_ended",
      companyId: watch.companyId,
      controllerUserId: watch.controllerUserId,
      controllerUsername: watch.controllerUsername,
      controllerRole: watch.controllerRole,
      targetUserId: watch.targetUserId,
      targetUsername: watch.targetUsername,
      watchId: watch.watchId,
      stopReason,
    });
    ended += 1;
  }
  return ended;
}

export async function expireStaleScreenWatches(now = Date.now()): Promise<number> {
  let ended = 0;
  for (const [key, watch] of activeWatches.entries()) {
    if (now - watch.lastSeenAt < WATCH_TTL_MS) continue;
    activeWatches.delete(key);
    await writeScreenWatchAudit({
      event: "screen_watch_ended",
      companyId: watch.companyId,
      controllerUserId: watch.controllerUserId,
      controllerUsername: watch.controllerUsername,
      controllerRole: watch.controllerRole,
      targetUserId: watch.targetUserId,
      targetUsername: watch.targetUsername,
      watchId: watch.watchId,
      stopReason: "watch-timeout",
    });
    ended += 1;
  }
  return ended;
}

export function getActiveScreenWatchCountForTests(): number {
  return activeWatches.size;
}

export function resetScreenWatchAuditStateForTests(): void {
  activeWatches.clear();
  if (sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
  sweeperInstalled = false;
}

export function buildScreenWatchAuditRowForTests(input: ScreenWatchAuditInput) {
  return buildWatchAuditRow(input);
}
