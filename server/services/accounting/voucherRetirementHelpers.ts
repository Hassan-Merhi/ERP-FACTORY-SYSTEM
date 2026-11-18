// Extracted from ./voucherRetirement.ts
import { currentAuditActor } from "../audit/auditActorContext";

export const RETIRED_NUMBER_PATTERN = /~DEL\d+$/;

export const RETIRED_VOUCHER_NOT_RESTORABLE = "RETIRED_VOUCHER_NOT_RESTORABLE" as const;

export const RETIRED_VOUCHER_NOT_RESTORABLE_MESSAGE =
  "This voucher was replaced when its source document was posted again, so it cannot be restored. The replacement is the live voucher.";

/** True for a voucher number given up by retireVouchersTx. */
export function isRetiredVoucherNumber(voucherNumber: string | null | undefined): boolean {
  return RETIRED_NUMBER_PATTERN.test(String(voucherNumber ?? ""));
}

export interface VoucherRetirementActor {
  userId: string | number;
  username: string;
}

export interface RetireVouchersOptions {
  companyId: number;
  voucherIds: readonly (number | null | undefined)[];
  /** Why the system removes them, recorded in the audit row (for example "linked-journal-rebuild"). */
  reason: string;
  /** The user whose action removes them; the system otherwise. */
  actor?: VoucherRetirementActor | null;
  /** Extra context for the audit row. */
  metadata?: Record<string, unknown>;
}

export interface RetiredVoucher {
  id: number;
  voucherNumber: string;
  retiredNumber: string;
  alreadyDeleted: boolean;
}

/**
 * Phase 21 (A), AT4: the actor of a retirement — the one the caller passes,
 * else the request's or job's actor (auditActorContext.ts), else the system.
 */
export function retirementActor(options: {
  actor?: VoucherRetirementActor | null;
  reason: string;
}): VoucherRetirementActor {
  if (options.actor) return options.actor;
  return currentAuditActor({ userId: "system", username: `voucher-retirement:${options.reason}` });
}

/** The signed-in user of a request, as the actor of a retirement. */
export function sessionRetirementActor(req: {
  session?: { userId?: string | number | null; username?: string | null } | null;
}): VoucherRetirementActor {
  const userId = req.session?.userId;
  // Phase 21 (A), AT4: no "unknown" when the request context knows the actor.
  if (userId === null || userId === undefined || userId === "") return currentAuditActor();
  return { userId, username: req.session?.username || String(userId) };
}

/** The part of a pg client (pool connection inside BEGIN) the raw-SQL retirement uses. */
export interface RetirementPgClient {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}
