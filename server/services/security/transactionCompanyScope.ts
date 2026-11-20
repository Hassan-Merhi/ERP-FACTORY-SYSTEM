import { sql, type SQL } from "drizzle-orm";

import { getCompanyRequestRuntimeContext } from "./companyRequestRuntimeContext";

/**
 * Minimal structural view of a database transaction handle.
 *
 * The tenant-scoped services only ever issue raw statements through the
 * transaction, so they depend on `execute` alone rather than on the concrete
 * drizzle transaction type. That keeps the boundary testable with a stub while
 * still rejecting values that cannot run a statement.
 */
export interface CompanyScopedTransaction {
  execute(query: SQL): Promise<unknown>;
}

/**
 * The chainable shape the read-only reconciliation adapters need from a select.
 * Every stage returns the same view and the chain is awaited as untyped rows,
 * which each adapter validates field by field before trusting them.
 */
export interface CompanyScopedReadQuery extends PromiseLike<Record<string, unknown>[]> {
  from(table: unknown): CompanyScopedReadQuery;
  innerJoin(table: unknown, on: unknown): CompanyScopedReadQuery;
  leftJoin(table: unknown, on: unknown): CompanyScopedReadQuery;
  where(condition: unknown): CompanyScopedReadQuery;
  groupBy(...columns: unknown[]): CompanyScopedReadQuery;
}

/** A tenant-scoped transaction that also serves company-scoped reads. */
export interface CompanyScopedReadTransaction extends CompanyScopedTransaction {
  select(fields: Record<string, unknown>): CompanyScopedReadQuery;
}

export class TransactionCompanyScopeError extends Error {
  readonly code = "TRANSACTION_COMPANY_SCOPE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "TransactionCompanyScopeError";
  }
}

function positiveCompanyId(value: unknown): number {
  const companyId = Number(value);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new TransactionCompanyScopeError("companyId must be a positive integer");
  }
  return companyId;
}

/**
 * Whether assertTransactionCompanyScope may scope the transaction to this
 * company: always outside an HTTP request, and inside one only for the
 * request's own company or a secondary company the request boundary
 * membership-checked. Changes nothing; callers that may legitimately touch
 * another company's row (an intercompany counterpart) check it first.
 */
export function isCompanyInRequestScope(companyId: number): boolean {
  const requestContext = getCompanyRequestRuntimeContext();
  return (
    !requestContext ||
    requestContext.companyId === companyId ||
    Boolean(requestContext.authorizedCompanyIds?.includes(companyId))
  );
}

/**
 * Assert the authoritative company on the current PostgreSQL transaction.
 *
 * The RLS policies consult app.current_company_id. Central accounting/inventory
 * services call this at the start of their transaction-owned write boundary so
 * reads and writes receive a database-level tenant guard in addition to
 * application ownership checks.
 *
 * For HTTP work, the request boundary already resolved a canonical server-owned
 * company and stored it in AsyncLocalStorage. Refuse to set PostgreSQL scope to
 * a different company unless that company was independently membership-checked
 * as an intentional secondary company by the request boundary. Developer
 * requests are intentionally not exempt from that rule.
 *
 * Background/scheduled work has no request runtime context, so it can continue
 * to assert an explicit validated company before entering its transaction.
 *
 * `set_config(..., true)` is transaction-local: PostgreSQL automatically clears
 * the value at commit/rollback, preventing pooled connections from leaking one
 * company's identity into the next request.
 */
export async function assertTransactionCompanyScope(tx: CompanyScopedTransaction, value: unknown): Promise<number> {
  const companyId = positiveCompanyId(value);
  if (!isCompanyInRequestScope(companyId)) {
    throw new TransactionCompanyScopeError("transaction company scope is not authorized for the active request");
  }

  await tx.execute(sql`SELECT set_config('app.current_company_id', ${String(companyId)}, true)`);
  return companyId;
}
