import type { Database } from "../../db";
import { and, desc, eq, gte, like } from "drizzle-orm";
import { auditLog } from "@shared/schema";
import {
  buildSecurityAuditRecord,
  detectSecurityAnomalies,
  type SecurityAuditRecord,
  type SecurityEventInput,
} from "./securityAuditPolicy";

const SECURITY_ACTION_PREFIX = "SECURITY:";

export function toAuditLogInsert(input: SecurityEventInput, username: string) {
  const record = buildSecurityAuditRecord(input);
  const numericTargetId = record.targetId && /^\d+$/.test(record.targetId) ? Number(record.targetId) : null;
  return {
    record,
    insert: {
      userId: record.actorUserId ?? "anonymous",
      username: username.trim() || "anonymous",
      companyId: record.companyId,
      action: `${SECURITY_ACTION_PREFIX}${record.kind}:${record.action}:${record.outcome}`,
      tableName: "security_events",
      recordId: Number.isSafeInteger(numericTargetId) ? numericTargetId : null,
      recordIdentifier: record.eventKey,
      changes: record,
      createdAt: new Date(record.occurredAt),
    } satisfies typeof auditLog.$inferInsert,
  };
}

export async function persistSecurityEvent(
  db: Database,
  input: SecurityEventInput,
  username: string
): Promise<SecurityAuditRecord> {
  const { record, insert } = toAuditLogInsert(input, username);
  await db.insert(auditLog).values(insert);
  return record;
}

function isSecurityAuditRecord(value: unknown): value is SecurityAuditRecord {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SecurityAuditRecord>;
  return (
    typeof item.eventKey === "string" &&
    typeof item.kind === "string" &&
    typeof item.action === "string" &&
    typeof item.outcome === "string" &&
    typeof item.occurredAt === "number"
  );
}

export async function loadCompanySecurityAnomalies(
  db: Database,
  companyId: number,
  options: { now?: number; windowMs?: number; denialThreshold?: number; limit?: number } = {}
) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const since = new Date(now - windowMs);
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);
  const rows = await db
    .select({ changes: auditLog.changes })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.companyId, companyId),
        gte(auditLog.createdAt, since),
        like(auditLog.action, `${SECURITY_ACTION_PREFIX}%`)
      )
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  const events = rows.map((row) => row.changes).filter(isSecurityAuditRecord);
  return {
    windowMs,
    eventCount: events.length,
    anomalies: detectSecurityAnomalies(events, {
      now,
      windowMs,
      denialThreshold: options.denialThreshold,
    }),
  };
}
