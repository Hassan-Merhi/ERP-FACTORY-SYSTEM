/**
 * Safe repair service for raw-material rows whose non-USD exchange rate is
 * unresolved (see `fx-diagnostic` route / `resolveStoredFxRate`).
 *
 * This service does ONE thing: it lets an admin supply the real, explicitly-known
 * exchange rate for a specific row and persists it via the `fxRateConfirmed` flag.
 * It never guesses a rate itself, never recalculates downstream cost/kg or cascades
 * to mix batches/bales (that remains the separate, existing `rawStockRecalc`
 * preview/apply flow, which already refuses to touch fx-unresolved containers),
 * and never touches a container whose status is CLOSED/COMPLETED/OFFLOADED —
 * those are reported as MANUAL_REVIEW_REQUIRED instead of repaired automatically.
 *
 * It also refuses to silently overwrite a row that is ALREADY confirmed with a
 * DIFFERENT rate than the one being requested — that is a correction, not a
 * first-time resolution, and must go through an explicit separate workflow (not
 * yet built) rather than this one-shot repair. Re-applying the exact same
 * already-confirmed rate remains a safe idempotent no-op.
 *
 * Every apply is: admin-gated (by the caller), wrapped in a transaction with a
 * Postgres advisory lock PLUS a `SELECT ... FOR UPDATE` row lock, atomic with the
 * caller's audit-log insert (pass `onAudit` — if it throws, the whole transaction,
 * including the FX update, rolls back), idempotent, and rejects a stale token via
 * the caller comparing `versionTag`/`oldFxRateToUsd`/`oldFxRateConfirmed` against a
 * freshly-reloaded plan before calling apply.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { factoryContainers, factoryOffloadAdditionalCharges, factoryContainerCommissions } from "@shared/schema";
import type { DatabaseOrTransaction } from "../../db";
import { syncContainerCommissionJournalTx } from "./containerCommissionJournal";

export type FxResolutionSource = "container" | "offload_additional_charge" | "commission";

const CLOSED_STATUSES = new Set(["CLOSED", "COMPLETED", "OFFLOADED"]);

// Advisory lock keys are scoped by source so the same numeric id across different
// tables can't collide with each other while a repair is in flight.
const LOCK_NAMESPACE: Record<FxResolutionSource, number> = {
  container: 1,
  offload_additional_charge: 2,
  commission: 3,
};

export class ManualReviewRequiredError extends Error {
  constructor(reason: string) {
    super(`MANUAL_REVIEW_REQUIRED: ${reason} Historical costing on this container was not modified.`);
    this.name = "ManualReviewRequiredError";
  }
}

export class AlreadyConfirmedError extends Error {
  constructor(source: string, id: number, oldRate: string | null, requestedRate: number) {
    super(
      `ALREADY_CONFIRMED: ${source} #${id} already has a confirmed exchange rate (${oldRate}) that differs ` +
        `from the requested rate (${requestedRate}). This repair only resolves a FIRST-TIME unconfirmed rate — ` +
        `overwriting an existing confirmed rate requires a separate, explicit correction workflow.`
    );
    this.name = "AlreadyConfirmedError";
  }
}

export interface FxResolutionPlan {
  source: FxResolutionSource;
  id: number;
  companyId: number;
  currencyCode: string;
  oldFxRateToUsd: string | null;
  oldFxRateConfirmed: boolean;
  newFxRateToUsd: string;
  /** Whichever timestamp column this source actually has (containers have
   * updatedAt; offload_additional_charge/commission only have createdAt) —
   * used by callers to detect a stale confirmation token (row changed since
   * the token was issued). */
  versionTag: string | null;
  alreadyResolved: boolean;
  alreadyConfirmedDifferentRate: boolean;
  manualReviewRequired: boolean;
  manualReviewReason: string | null;
  containerId: number | null;
  containerStatus: string | null;
}

async function loadRow(
  dbOrTx: DatabaseOrTransaction,
  source: FxResolutionSource,
  id: number,
  companyId: number,
  forUpdate = false
) {
  if (source === "container") {
    const q = dbOrTx
      .select()
      .from(factoryContainers)
      .where(and(eq(factoryContainers.id, id), eq(factoryContainers.companyId, companyId)));
    const [row] = forUpdate ? await q.for("update") : await q;
    if (!row) return null;
    return {
      currencyCode: row.currencyCode,
      fxRateToUsd: row.fxRateToUsd,
      fxRateConfirmed: !!row.fxRateConfirmed,
      containerId: row.id,
      containerStatus: row.status,
      versionTag: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    };
  }
  if (source === "offload_additional_charge") {
    const q = dbOrTx
      .select()
      .from(factoryOffloadAdditionalCharges)
      .where(and(eq(factoryOffloadAdditionalCharges.id, id), eq(factoryOffloadAdditionalCharges.companyId, companyId)));
    const [row] = forUpdate ? await q.for("update") : await q;
    if (!row) return null;
    const [container] = row.containerId
      ? await dbOrTx.select().from(factoryContainers).where(eq(factoryContainers.id, row.containerId))
      : [null];
    return {
      currencyCode: row.currencyCode,
      fxRateToUsd: row.fxRateToUsd,
      fxRateConfirmed: !!row.fxRateConfirmed,
      containerId: row.containerId,
      containerStatus: container?.status ?? null,
      // This table has no updatedAt column — createdAt is the only stable
      // version signal available (row-level fx fields are only ever written
      // once at creation time by this repair flow anyway).
      versionTag: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    };
  }
  // commission
  const q = dbOrTx
    .select()
    .from(factoryContainerCommissions)
    .where(and(eq(factoryContainerCommissions.id, id), eq(factoryContainerCommissions.companyId, companyId)));
  const [row] = forUpdate ? await q.for("update") : await q;
  if (!row) return null;
  const [container] = row.containerId
    ? await dbOrTx.select().from(factoryContainers).where(eq(factoryContainers.id, row.containerId))
    : [null];
  return {
    currencyCode: row.currencyCode,
    fxRateToUsd: row.fxRateToUsd,
    fxRateConfirmed: !!row.fxRateConfirmed,
    containerId: row.containerId,
    containerStatus: container?.status ?? null,
    versionTag: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };
}

function buildPlan(
  source: FxResolutionSource,
  id: number,
  companyId: number,
  newFxRateToUsd: number,
  row: NonNullable<Awaited<ReturnType<typeof loadRow>>>
): FxResolutionPlan {
  const manualReviewRequired = !!(row.containerStatus && CLOSED_STATUSES.has(row.containerStatus));
  const oldRateNum = parseFloat(row.fxRateToUsd || "0");
  const EPS = 1e-9;
  const sameRate = Math.abs(oldRateNum - newFxRateToUsd) < EPS;
  const alreadyResolved = row.fxRateConfirmed && sameRate;
  const alreadyConfirmedDifferentRate = row.fxRateConfirmed && !sameRate;

  return {
    source,
    id,
    companyId,
    currencyCode: row.currencyCode || "USD",
    oldFxRateToUsd: row.fxRateToUsd,
    oldFxRateConfirmed: row.fxRateConfirmed,
    newFxRateToUsd: String(newFxRateToUsd),
    versionTag: row.versionTag,
    alreadyResolved,
    alreadyConfirmedDifferentRate,
    manualReviewRequired,
    manualReviewReason: manualReviewRequired
      ? `Container status is ${row.containerStatus} — historical costing on closed containers is never auto-rewritten. Resolve manually.`
      : null,
    containerId: row.containerId,
    containerStatus: row.containerStatus,
  };
}

/** Read-only: compute what a repair WOULD do, without writing anything. */
export async function planFxResolutionRepair(
  source: FxResolutionSource,
  id: number,
  companyId: number,
  newFxRateToUsd: number
): Promise<FxResolutionPlan | null> {
  const row = await loadRow(db, source, id, companyId, false);
  if (!row) return null;
  return buildPlan(source, id, companyId, newFxRateToUsd, row);
}

export interface FxResolutionApplyResult extends FxResolutionPlan {
  applied: boolean;
}

export interface ApplyFxResolutionRepairOptions {
  /** Called with the transaction handle AFTER the FX row update but BEFORE
   * commit, so an audit-log insert here is atomic with the update: if this
   * throws, the entire transaction (including the FX update) rolls back. */
  onAudit?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], result: FxResolutionApplyResult) => Promise<void>;
}

/**
 * Apply the repair: sets fxRateToUsd + fxRateConfirmed=true on the target row.
 * Refuses (throws) if the container is CLOSED/COMPLETED/OFFLOADED, if the currency
 * is USD (nothing to resolve), if the row is already confirmed with a DIFFERENT
 * rate, or if the rate is not a positive number. Idempotent: re-applying the
 * exact same already-confirmed rate is a no-op (applied=false, onAudit NOT called).
 */
export async function applyFxResolutionRepair(
  source: FxResolutionSource,
  id: number,
  companyId: number,
  newFxRateToUsd: number,
  opts: ApplyFxResolutionRepairOptions = {}
): Promise<FxResolutionApplyResult> {
  if (!(newFxRateToUsd > 0)) {
    throw new Error("newFxRateToUsd must be a positive number");
  }

  return await db.transaction(async (tx) => {
    // Advisory lock scoped to (namespace, id) so concurrent repairs on the same row
    // serialize instead of racing; released automatically at transaction end.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_NAMESPACE[source]}, ${id})`);

    // Row-level lock (in addition to the advisory lock) so a concurrent
    // transaction touching this exact row via a different path blocks until we
    // commit/rollback, rather than only serializing against other repairs.
    const row = await loadRow(tx, source, id, companyId, true);
    if (!row) throw new Error(`${source} #${id} not found for company ${companyId}`);
    const plan = buildPlan(source, id, companyId, newFxRateToUsd, row);

    if (plan.currencyCode === "USD") {
      throw new Error("Row is already in USD — there is no exchange rate to resolve");
    }
    if (plan.manualReviewRequired) {
      throw new ManualReviewRequiredError(plan.manualReviewReason!);
    }
    if (plan.alreadyConfirmedDifferentRate) {
      throw new AlreadyConfirmedError(source, id, plan.oldFxRateToUsd, newFxRateToUsd);
    }
    if (plan.alreadyResolved) {
      return { ...plan, applied: false };
    }

    const values = { fxRateToUsd: String(newFxRateToUsd), fxRateConfirmed: true };
    if (source === "container") {
      await tx.update(factoryContainers).set(values).where(eq(factoryContainers.id, id));
      // Wave 14: a commission in the container's currency posts at this rate
      // now (FACTORY-COMM-{container}, same transaction).
      await syncContainerCommissionJournalTx(tx, companyId, id);
    } else if (source === "offload_additional_charge") {
      await tx.update(factoryOffloadAdditionalCharges).set(values).where(eq(factoryOffloadAdditionalCharges.id, id));
    } else {
      await tx.update(factoryContainerCommissions).set(values).where(eq(factoryContainerCommissions.id, id));
    }

    const result: FxResolutionApplyResult = { ...plan, applied: true };

    // Atomic with the update above: if this throws, the whole transaction
    // (including the FX write just made) rolls back — no financial change is
    // ever persisted without its audit trail.
    if (opts.onAudit) {
      await opts.onAudit(tx, result);
    }

    return result;
  });
}
