/**
 * Both companies of an intercompany posting in one transaction's scope
 * (accounting audit phase 26, MC-3/MC-4).
 *
 * A request transaction is pinned to the active company: row-level security
 * reads `app.current_company_id` / `app.authorized_company_ids`, and the
 * posting engine's `assertTransactionCompanyScope` refuses a company the
 * request did not authorize. The rental auto-transfer and the POS mirror used
 * to post the other company's leg AFTER the payment / sale committed, in a
 * transaction of their own opened with a widened scope, and swallowed any
 * failure (a payment or a sale with half a transfer, or none, and nothing
 * recorded). They now post inside the payment's / sale's own transaction;
 * this helper widens THAT transaction for the duration of `work`:
 *
 *   - application level: the request context's authorized companies gain the
 *     counterparties, each checked for the user's membership first unless the
 *     caller says the counterparty is authorized by a stored configuration
 *     that only a member of both companies can save (the POS config);
 *   - database level: `app.authorized_company_ids` gains them with
 *     `set_config(..., true)` (transaction-local), and both settings, which
 *     the engine changes while posting the other company's leg, are put back
 *     when `work` returns. On an error the transaction (or its savepoint) is
 *     rolled back, which reverts the settings too.
 *
 * Maintenance scope (scheduler jobs) already sees every company: no change.
 */
import { sql } from "drizzle-orm";

import type { DbTransaction } from "../../../db";
import { HttpError } from "../../../lib/httpError";
import { resultRows } from "../../../lib/queryResult";
import { assertCompanyAccess, CompanyAccessError } from "../../../security/companyAccessBoundary";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../../security/companyRequestRuntimeContext";

export class IntercompanyScopeError extends HttpError {
  readonly code = "INTERCOMPANY_SCOPE_DENIED";
  constructor(message: string) {
    super(403, message);
    this.name = "IntercompanyScopeError";
  }

  get status(): number {
    return this.statusCode;
  }
}

export type IntercompanyAuthorization =
  /** Check the request user's membership of each counterparty (refused when missing). */
  | "verify-membership"
  /** The caller already checked membership (e.g. requireCompanyAccess on both companies). */
  | "membership-checked"
  /** A stored configuration naming both companies, saved only by a member of both. */
  | "stored-configuration";

function positiveIds(ids: readonly number[]): number[] {
  return [...new Set(ids.map(Number))].filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
}

function parseIdList(raw: string | null | undefined): number[] {
  if (!raw) return [];
  return positiveIds(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map(Number)
  );
}

/** Runs `work` in `tx` with `companyIds` added to the transaction's company scope. */
export async function withIntercompanyCompaniesTx<T>(
  tx: DbTransaction,
  companyIds: readonly number[],
  authorization: IntercompanyAuthorization,
  work: () => Promise<T>
): Promise<T> {
  const wanted = positiveIds(companyIds);
  const request = getCompanyRequestRuntimeContext();

  // Application level (the engine's assertTransactionCompanyScope).
  let runWork = work;
  if (request) {
    const known = new Set([request.companyId, ...(request.authorizedCompanyIds ?? [])]);
    const added = wanted.filter((id) => !known.has(id));
    if (added.length > 0) {
      if (authorization === "verify-membership") {
        for (const companyId of added) {
          try {
            await assertCompanyAccess(request.userId, companyId);
          } catch (error) {
            if (error instanceof CompanyAccessError) {
              throw new IntercompanyScopeError(`No access to company ${companyId} for this intercompany posting.`);
            }
            throw error;
          }
        }
      }
      const authorizedCompanyIds = positiveIds([...(request.authorizedCompanyIds ?? []), ...added]);
      runWork = () => runWithCompanyRequestRuntimeContext({ ...request, authorizedCompanyIds }, work);
    }
  }

  // Database level (row-level security).
  const [settings] = resultRows<{ maintenance: string | null; current: string | null; authorized: string | null }>(
    await tx.execute(sql`
      SELECT current_setting('app.company_scope_maintenance', true) AS maintenance,
             current_setting('app.current_company_id', true) AS current,
             current_setting('app.authorized_company_ids', true) AS authorized
    `)
  );
  const maintenance = (settings?.maintenance ?? "").trim().toLowerCase() === "on";
  const current = (settings?.current ?? "").trim();
  const authorized = settings?.authorized ?? "";
  const scopedIds = new Set([...parseIdList(current), ...parseIdList(authorized)]);
  const missing = wanted.filter((id) => !scopedIds.has(id));
  if (maintenance || !current || missing.length === 0) {
    const result = await runWork();
    if (!maintenance && current) {
      await tx.execute(sql`SELECT set_config('app.current_company_id', ${current}, true)`);
    }
    return result;
  }

  const widened = positiveIds([...parseIdList(authorized), ...missing]).join(",");
  await tx.execute(sql`SELECT set_config('app.authorized_company_ids', ${widened}, true)`);
  const result = await runWork();
  await tx.execute(sql`
    SELECT set_config('app.current_company_id', ${current}, true),
           set_config('app.authorized_company_ids', ${authorized}, true)
  `);
  return result;
}
