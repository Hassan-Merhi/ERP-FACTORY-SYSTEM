import { sql } from "drizzle-orm";
import type { ProformaCapacityExecutor } from "./proformaCapacity";

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
