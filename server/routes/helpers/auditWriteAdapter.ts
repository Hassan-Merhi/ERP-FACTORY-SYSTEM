import { writeAuditEvent } from "../../services/audit";
import type { AuditAction, AuditChanges, AuditExecutor } from "../../services/audit";

/**
 * Compatibility adapter for established server-side audit call sites.
 *
 * Phases 8B and 8C intentionally preserve the existing logAudit API while
 * routing voucher, POS, inventory, transfer, adjustment, and container events
 * through the shared Phase 8A framework so sanitization, bounds,
 * normalization, and safe failure logging are applied consistently.
 *
 * Wave 12 (audit trail): a financial edit or delete passes its transaction as
 * `executor`, so the audit row commits with the change or the change rolls
 * back. Omitting it writes on the pool, outside any transaction.
 */
export async function logAudit(
  params: {
    userId: string;
    username: string;
    companyId?: number | null;
    action: AuditAction;
    tableName: string;
    recordId?: number | null;
    recordIdentifier?: string | null;
    changes?: AuditChanges | null;
  },
  executor?: AuditExecutor
): Promise<void> {
  await writeAuditEvent(params, executor);
}
