// Extracted from ./auditHelpers.ts
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { auditLog } from "@shared/schema";
import { currentAuditActor } from "../../services/audit/auditActorContext";

// ─── Audit log ────────────────────────────────────────────────────────────────
export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "restore"
  | "reverse"
  | "void"
  | "return"
  | "recalculate"
  | "repair"
  | "import"
  | "export"
  | "send_whatsapp"
  | "send_email"
  | "approve"
  | "cancel"
  | "offload"
  | "transfer"
  | "adjust"
  | "login"
  | "permission_change"
  | "settings_change";

function normalizeAuditAction(params: {
  action: AuditAction;
  tableName: string;
  changes?: Record<string, { old?: AuditChangeValue; new?: AuditChangeValue }> | null;
}): AuditAction {
  if (params.action !== "update" || params.tableName !== "factory_customer_orders") {
    return params.action;
  }

  const statusChange = params.changes?.status;
  const oldStatus = String(statusChange?.old ?? "").toUpperCase();
  const newStatus = String(statusChange?.new ?? "").toUpperCase();

  if (newStatus === "CANCELLED") return "cancel";
  if (oldStatus === "CANCELLED" && newStatus === "LOADING") return "restore";

  return params.action;
}

export async function logAudit(
  params: {
    userId: string;
    username: string;
    companyId?: number | null;
    action: AuditAction;
    tableName: string;
    recordId?: number | null;
    recordIdentifier?: string | null;
    changes?: Record<string, { old?: AuditChangeValue; new?: AuditChangeValue }> | null;
  },
  // Optional transaction/connection handle. Pass the same `tx` used for the
  // financial write so the audit INSERT is atomic with it — if the audit
  // insert fails, the whole transaction (including the financial write)
  // rolls back instead of silently losing the audit trail. Defaults to the
  // pool-level `db` for existing non-transactional callers.
  dbConn: { insert: typeof db.insert } = db
) {
  try {
    // Phase 21 (A), AT4: an empty or "unknown" actor is the request's actor when known.
    const actorMissing = !String(params.userId ?? "").trim() || params.userId === "unknown";
    const actor = actorMissing ? currentAuditActor({ userId: "unknown", username: "unknown" }) : null;
    await dbConn.insert(auditLog).values({
      userId: actor?.userId ?? params.userId,
      username: actor?.username ?? params.username,
      companyId: params.companyId,
      action: normalizeAuditAction(params),
      tableName: params.tableName,
      recordId: params.recordId,
      recordIdentifier: params.recordIdentifier,
      changes: params.changes,
    });
  } catch (error) {
    logger.error("Error logging audit:", { error: error });
    throw error;
  }
}

export type EntrySnap = { account: string; debit: string; credit: string; narration?: string };

/**
 * A recorded before/after value. Audit entries carry whatever the changed
 * column held, so the value is only ever serialised, never inspected.
 */
export type AuditChangeValue = unknown;

/**
 * Entries as recorded on an audit row: either the resolved snapshot or the raw
 * voucher-entry rows a caller already has. Both are only compared and stored.
 */
export type RecordedEntries = readonly (EntrySnap | Record<string, unknown>)[];

export type VoucherSnap = {
  voucherType?: string | null;
  voucherDate?: string | null;
  totalAmount?: string | null;
  description?: string | null;
  locationName?: string | null;
  locationId?: number | null;
  optional?: boolean | null;
};
