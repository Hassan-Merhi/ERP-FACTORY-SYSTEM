import { auditLog } from "@shared/schema";
import { db } from "../db";
import { logger } from "../lib/logger";
import { installRemoteSupportAuditRetention } from "./remoteSupportAuditRetention";
import { subscribeRemoteControlSessionStops, type RemoteControlSession } from "./remoteControlSessionService";

export type RemoteSupportAuditEvent =
  | "session_started"
  | "session_stopped"
  | "mouse_authorized"
  | "mouse_revoked"
  | "keyboard_authorized"
  | "keyboard_revoked"
  | "mouse_command"
  | "mouse_result"
  | "keyboard_command"
  | "keyboard_result"
  | "command_blocked"
  | "permission_denied";

export interface RemoteSupportAuditDetails {
  capability?: "view" | "mouse" | "keyboard" | "audit";
  commandType?: string;
  key?: string;
  textLength?: number;
  sequence?: number;
  status?: "executed" | "blocked" | "ignored" | "requested" | "denied";
  reason?: string | null;
  route?: string;
  stopReason?: string | null;
}

const ALLOWED_DETAIL_KEYS = new Set<keyof RemoteSupportAuditDetails>([
  "capability",
  "commandType",
  "key",
  "textLength",
  "sequence",
  "status",
  "reason",
  "route",
  "stopReason",
]);
const auditedStoppedSessionIds = new Set<string>();
let stopAuditInstalled = false;

function boundedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function safeDetails(details: RemoteSupportAuditDetails): Record<string, { new: unknown }> {
  const safe: Record<string, { new: unknown }> = {};
  for (const [rawKey, rawValue] of Object.entries(details)) {
    const key = rawKey as keyof RemoteSupportAuditDetails;
    if (!ALLOWED_DETAIL_KEYS.has(key) || rawValue === undefined) continue;
    if (key === "textLength" || key === "sequence") {
      const numberValue = Number(rawValue);
      if (Number.isFinite(numberValue) && numberValue >= 0) {
        safe[key] = { new: Math.floor(numberValue) };
      }
      continue;
    }
    if (key === "route") {
      safe[key] = { new: boundedText(rawValue, 300) ?? "/" };
      continue;
    }
    if (key === "reason" || key === "stopReason") {
      safe[key] = { new: boundedText(rawValue, 120) };
      continue;
    }
    const textValue = boundedText(rawValue, 80);
    if (textValue) safe[key] = { new: textValue };
  }
  return safe;
}

export function buildRemoteSupportAuditChanges(input: {
  event: RemoteSupportAuditEvent;
  session: RemoteControlSession;
  details?: RemoteSupportAuditDetails;
}): Record<string, { new: unknown }> {
  return {
    event: { new: input.event },
    controllerUserId: { new: input.session.controllerUserId },
    controllerUsername: { new: input.session.controllerUsername },
    controllerRole: { new: input.session.controllerRole },
    targetUserId: { new: input.session.targetUserId },
    targetUsername: { new: input.session.targetUsername },
    scope: { new: input.session.scope },
    targetRoute: { new: input.session.targetRoute },
    mouseEnabled: { new: input.session.capabilities.mouse },
    keyboardEnabled: { new: input.session.capabilities.keyboard },
    ...safeDetails(input.details ?? {}),
  };
}

export interface RemoteSupportAuditInput {
  event: RemoteSupportAuditEvent;
  session: RemoteControlSession;
  actorUserId?: string;
  actorUsername?: string;
  details?: RemoteSupportAuditDetails;
}

/**
 * Builds the exact `audit_log` row a remote-support event produces, without
 * writing it. Phase 10 batches per-command rows off the request path, so the
 * row has to be materialized at the moment the command is authorized — the
 * session route and capability flags it records must be the ones in force
 * then, not whatever they have become by the time the batch is flushed.
 */
export function buildRemoteSupportAuditRow(input: RemoteSupportAuditInput) {
  return {
    userId: boundedText(input.actorUserId, 128) ?? input.session.controllerUserId,
    username: boundedText(input.actorUsername, 160) ?? input.session.controllerUsername,
    companyId: input.session.companyId,
    action: `remote_support_${input.event}`,
    tableName: "remote_support_sessions",
    recordId: null,
    recordIdentifier: input.session.id,
    changes: buildRemoteSupportAuditChanges(input),
  };
}

export async function writeRemoteSupportAudit(input: RemoteSupportAuditInput): Promise<void> {
  if (input.event === "session_stopped" && auditedStoppedSessionIds.has(input.session.id)) return;

  try {
    await db.insert(auditLog).values(buildRemoteSupportAuditRow(input));
    if (input.event === "session_stopped") auditedStoppedSessionIds.add(input.session.id);
  } catch (error) {
    logger.error("[RemoteSupport] permanent audit write failed", {
      error,
      event: input.event,
      sessionId: input.session.id,
      companyId: input.session.companyId,
    });
    throw error;
  }
}

export function installRemoteSupportSessionStopAudit(): void {
  installRemoteSupportAuditRetention();
  if (stopAuditInstalled) return;
  stopAuditInstalled = true;
  subscribeRemoteControlSessionStops((session) => {
    // A stopped session is the natural boundary for the batched per-command
    // queue: the history of what was just done should be readable immediately
    // rather than after the next interval tick. Imported lazily because the
    // queue imports this module for its row builder.
    void import("./remoteSupportCommandAuditQueue")
      .then((queue) => queue.flushRemoteSupportCommandAudits())
      .catch(() => undefined);
    void writeRemoteSupportAudit({
      event: "session_stopped",
      session,
      actorUserId: session.controllerUserId,
      actorUsername: session.controllerUsername,
      details: {
        capability: "view",
        stopReason: session.stopReason,
        route: session.targetRoute,
      },
    }).catch(() => undefined);
  });
}

export function remoteSupportCommandAuditDetails(input: {
  capability: "mouse" | "keyboard";
  commandType: string;
  sequence?: number;
  key?: string;
  text?: string;
  route?: string;
}): RemoteSupportAuditDetails {
  return {
    capability: input.capability,
    commandType: boundedText(input.commandType, 80) ?? "unknown",
    sequence: input.sequence,
    key: boundedText(input.key, 40) ?? undefined,
    textLength: typeof input.text === "string" ? Array.from(input.text).length : undefined,
    route: input.route,
    status: "requested",
  };
}

export function resetRemoteSupportAuditStateForTests(): void {
  auditedStoppedSessionIds.clear();
  stopAuditInstalled = false;
}
