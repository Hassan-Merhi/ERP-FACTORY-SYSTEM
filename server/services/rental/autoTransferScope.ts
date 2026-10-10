import { and, eq, isNotNull } from "drizzle-orm";
import { interCompanyTransfers, rentalAutoTransferConfigs } from "@shared/schema";

import { db } from "../../db";
import { assertCompanyAccess, CompanyAccessError } from "../../security/companyAccessBoundary";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../security/companyRequestRuntimeContext";
import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "../security/databaseScopeRuntimeContext";

export class RentalAutoTransferScopeError extends Error {
  readonly code = "RENTAL_AUTO_TRANSFER_SCOPE_INVALID";
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.name = "RentalAutoTransferScopeError";
    this.status = status;
  }
}

/**
 * The companies a rental auto-transfer can reach from `companyId`: the
 * destinations of its own saved transfer rules and of the transfers it already
 * posted. Both come from server-side rows the company owns, never from a
 * request body.
 */
export async function autoTransferCounterpartyCompanyIds(companyId: number): Promise<number[]> {
  const [configured, posted] = await Promise.all([
    db
      .select({ id: rentalAutoTransferConfigs.destCompanyId })
      .from(rentalAutoTransferConfigs)
      .where(eq(rentalAutoTransferConfigs.companyId, companyId)),
    db
      .selectDistinct({ id: interCompanyTransfers.toCompanyId })
      .from(interCompanyTransfers)
      .where(and(eq(interCompanyTransfers.fromCompanyId, companyId), isNotNull(interCompanyTransfers.sourcePaymentId))),
  ]);
  return [...new Set([...configured, ...posted].map((row) => row.id))].filter((id) => id !== companyId);
}

/**
 * Run a rental auto-transfer, or its reversal, with the destination companies in
 * the database scope.
 *
 * A request is pinned to its active company, so writing the receiving side of a
 * transfer in another company was refused by row-level security: the lookup of
 * the destination's clearing account found nothing and the fallback insert hit
 * the existing row. Each counterparty is added only after the requesting user's
 * membership in it is checked; a counterparty they cannot access is refused
 * rather than skipped, so a transfer is never posted or reversed on one side.
 *
 * Work outside an HTTP request has no request scope to widen and runs as is.
 */
export async function runWithAutoTransferCounterparties<T>(
  counterpartyCompanyIds: readonly number[],
  run: () => Promise<T>
): Promise<T> {
  const requestContext = getCompanyRequestRuntimeContext();
  const databaseScope = getDatabaseScopeRuntimeContext();
  const counterparties = [...new Set(counterpartyCompanyIds)].filter((id) => id !== requestContext?.companyId);
  if (!requestContext || databaseScope?.kind !== "tenant" || counterparties.length === 0) return run();

  for (const companyId of counterparties) {
    try {
      await assertCompanyAccess(requestContext.userId, companyId);
    } catch (error) {
      if (error instanceof CompanyAccessError) {
        throw new RentalAutoTransferScopeError(`No access to transfer company ${companyId}.`, error.status);
      }
      throw error;
    }
  }

  const authorizedCompanyIds = [...new Set([...(requestContext.authorizedCompanyIds ?? []), ...counterparties])];
  return runWithCompanyRequestRuntimeContext({ ...requestContext, authorizedCompanyIds }, () =>
    runWithDatabaseScopeRuntimeContext(
      createTenantDatabaseScope(requestContext.companyId, authorizedCompanyIds, "authorized-companies"),
      run
    )
  );
}
