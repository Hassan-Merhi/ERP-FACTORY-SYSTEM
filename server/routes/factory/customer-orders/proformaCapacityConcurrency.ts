import { sql } from "drizzle-orm";
import {
  getProformaCapacitySnapshot,
  type ProformaCapacityExecutor,
  type ProformaCapacityOptions,
  type ProformaCapacitySnapshot,
} from "./proformaCapacity";

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

export interface ProformaCapacityLockOptions {
  companyId: number;
  proformaId: number;
}

function assertPgInt32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < INT32_MIN || value > INT32_MAX) {
    throw new Error(`${label} must be a signed 32-bit integer`);
  }
}

/**
 * Serialize all capacity-changing work for one company/proforma pair.
 *
 * IMPORTANT: this uses pg_advisory_xact_lock and therefore MUST be called with
 * a Drizzle transaction handle. The lock is automatically released when that
 * transaction commits or rolls back. Call it before taking bale/order row locks
 * so every protected path follows the same lock ordering and cannot deadlock by
 * acquiring the same resources in reverse order.
 *
 * PostgreSQL's two-int advisory-lock form gives us an exact (company, proforma)
 * namespace without hash collisions between unrelated proformas.
 */
export async function acquireProformaCapacityTransactionLock(
  executor: ProformaCapacityExecutor,
  options: ProformaCapacityLockOptions
): Promise<void> {
  assertPgInt32(options.companyId, "companyId");
  assertPgInt32(options.proformaId, "proformaId");

  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(${options.companyId}::integer, ${options.proformaId}::integer)`
  );
}

/**
 * Lock several proformas in ascending id order. Relinking an order moves its
 * bale consumption from one proforma to another, so both namespaces must be
 * protected. Sorting prevents two opposing relinks from taking the same pair
 * of locks in reverse order and deadlocking.
 */
export async function acquireProformaCapacityTransactionLocks(
  executor: ProformaCapacityExecutor,
  companyId: number,
  proformaIds: Array<number | null | undefined>
): Promise<void> {
  const ids = [...new Set(proformaIds.filter((value): value is number => value != null))].sort((a, b) => a - b);
  for (const proformaId of ids) {
    await acquireProformaCapacityTransactionLock(executor, { companyId, proformaId });
  }
}

/**
 * Acquire the transaction lock and then read the authoritative snapshot while
 * no competing protected writer for this proforma can change capacity.
 */
export async function getLockedProformaCapacitySnapshot(
  executor: ProformaCapacityExecutor,
  options: ProformaCapacityOptions
): Promise<ProformaCapacitySnapshot | null> {
  await acquireProformaCapacityTransactionLock(executor, options);
  return getProformaCapacitySnapshot(executor, options);
}
