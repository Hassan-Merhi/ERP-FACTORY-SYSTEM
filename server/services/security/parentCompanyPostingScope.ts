import { and, eq } from "drizzle-orm";
import { companies } from "@shared/schema";

import { db } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { assertCompanyAccess, CompanyAccessError } from "../../security/companyAccessBoundary";
import { getCompanyRequestRuntimeContext, runWithCompanyRequestRuntimeContext } from "./companyRequestRuntimeContext";
import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "./databaseScopeRuntimeContext";

export class ParentCompanyPostingScopeError extends HttpError {
  readonly code = "PARENT_COMPANY_POSTING_SCOPE_INVALID";
  readonly status: number;

  constructor(message: string, status = 403) {
    super(status, message);
    this.name = "ParentCompanyPostingScopeError";
    this.status = status;
  }
}

/**
 * Runs the parent-company half of an intercompany posting under the parent's tenant scope.
 *
 * A request is pinned to one company, so a posting that must also write in the parent company is
 * refused by the transaction scope guard unless the parent was independently membership-checked.
 * This helper is that independent check, and it is deliberately narrow:
 *
 *  - it only runs inside an HTTP request that already holds a tenant scope, so background work
 *    cannot use it to widen itself;
 *  - the parent is not taken from the caller's argument on trust - it must be the active
 *    company's own `parent_company_id` in the database;
 *  - the requesting user must hold membership in that parent company.
 *
 * Only then is the parent added to the request's authorized companies and the database scope
 * re-pinned to the parent for the duration of `run`. Nothing here reads client-supplied company
 * IDs, so a request body cannot steer which company the posting lands in.
 */
export async function runWithVerifiedParentCompanyScope<T>(parentCompanyId: number, run: () => Promise<T>): Promise<T> {
  const requestContext = getCompanyRequestRuntimeContext();
  const databaseScope = getDatabaseScopeRuntimeContext();

  if (!requestContext || databaseScope?.kind !== "tenant") {
    throw new ParentCompanyPostingScopeError("Parent company posting requires an active tenant request scope.", 500);
  }

  const activeCompanyId = requestContext.companyId;
  if (!Number.isInteger(parentCompanyId) || parentCompanyId <= 0 || parentCompanyId === activeCompanyId) {
    throw new ParentCompanyPostingScopeError("Parent company posting requires a distinct parent company.");
  }

  const [link] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, activeCompanyId), eq(companies.parentCompanyId, parentCompanyId)))
    .limit(1);

  if (!link) {
    throw new ParentCompanyPostingScopeError(
      `Company ${parentCompanyId} is not the parent of the active company ${activeCompanyId}.`
    );
  }

  try {
    await assertCompanyAccess(requestContext.userId, parentCompanyId);
  } catch (error) {
    // A membership denial is an expected authorization outcome, not a fault. Callers catch this
    // helper's own error type, so translate rather than let CompanyAccessError escape and be
    // reported as an unhandled 500.
    if (error instanceof CompanyAccessError) {
      throw new ParentCompanyPostingScopeError(`No access to parent company ${parentCompanyId}.`, error.status);
    }
    throw error;
  }

  const authorizedCompanyIds = [...new Set([...(requestContext.authorizedCompanyIds ?? []), parentCompanyId])];

  return runWithCompanyRequestRuntimeContext({ ...requestContext, authorizedCompanyIds }, () =>
    runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(parentCompanyId, [], "active-company"), run)
  );
}

/**
 * PO edits must update the subsidiary purchase voucher and the matching parent
 * receivable/payable voucher in ONE transaction. Unlike posting only to the
 * parent, this scope permits BOTH verified tenants while retaining RLS.
 *
 * The parent link comes from companies.parent_company_id, never the legacy
 * global parentCompanyId setting or the request payload.
 */
export async function runWithVerifiedPoParentScope<T>(
  subsidiaryCompanyId: number,
  run: (parentCompanyId: number | null) => Promise<T>
): Promise<T> {
  const requestContext = getCompanyRequestRuntimeContext();
  const databaseScope = getDatabaseScopeRuntimeContext();
  if (
    !requestContext ||
    databaseScope?.kind !== "tenant" ||
    requestContext.companyId !== subsidiaryCompanyId ||
    databaseScope.companyId !== subsidiaryCompanyId
  ) {
    throw new ParentCompanyPostingScopeError("Purchase order edit requires the active subsidiary tenant scope.", 403);
  }

  const [subsidiary] = await db
    .select({ parentCompanyId: companies.parentCompanyId })
    .from(companies)
    .where(eq(companies.id, subsidiaryCompanyId))
    .limit(1);
  if (!subsidiary) {
    throw new ParentCompanyPostingScopeError("Purchase order company not found.", 404);
  }

  const parentCompanyId = subsidiary.parentCompanyId ?? null;
  if (parentCompanyId === null) return run(null);
  if (parentCompanyId === subsidiaryCompanyId) {
    throw new ParentCompanyPostingScopeError("A company cannot be its own parent.");
  }
  try {
    await assertCompanyAccess(requestContext.userId, parentCompanyId);
  } catch (error) {
    if (error instanceof CompanyAccessError) {
      throw new ParentCompanyPostingScopeError("No access to the linked parent company.", error.status);
    }
    throw error;
  }

  const authorizedCompanyIds = [...new Set([...(requestContext.authorizedCompanyIds ?? []), parentCompanyId])];
  return runWithCompanyRequestRuntimeContext({ ...requestContext, authorizedCompanyIds }, () =>
    runWithDatabaseScopeRuntimeContext(
      createTenantDatabaseScope(subsidiaryCompanyId, authorizedCompanyIds, "authorized-companies"),
      () => run(parentCompanyId)
    )
  );
}
