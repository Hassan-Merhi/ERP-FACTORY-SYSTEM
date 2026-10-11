import type { DbTransaction } from "../db";

/**
 * Phase 21 (B): a caller's audit, run on the writer's transaction just before
 * it commits, so a failed audit insert rolls the write back and a rolled-back
 * write leaves no audit row. Services that open their own transaction take one
 * as an optional last argument.
 */
export type AuditTxHook<T> = (tx: DbTransaction, result: T) => Promise<void>;

/** Returns `result` after running the hook (when given) on `tx`. */
export function finishWithAudit<T>(tx: DbTransaction, hook?: AuditTxHook<T>) {
  return async (result: T): Promise<T> => {
    if (hook) await hook(tx, result);
    return result;
  };
}
