import crypto from "crypto";
import { pool } from "../../db";
import { currentAuditActor } from "../audit/auditActorContext";
import {
  REPLAY_ALGORITHM_VERSION,
  applyHistoricalCostReplay,
  buildHistoricalReplayScopeInternal,
  computeReplayFingerprint,
  normalizeReplayWriteScope,
  previewHistoricalCostReplayWithExecutor,
  replayBaleIdsForScope,
  type ExactReplaySnapshot,
  type ReplayQueryExecutor,
  type ReplayWriteScope,
} from "./historicalCostReplay";

const EXACT_UNDO_KIND = "HISTORICAL_REPLAY_EXACT_V1" as const;

export type PostOffloadHistoricalReplayStatus = "applied" | "no_changes" | "blocked" | "failed";

export interface PostOffloadHistoricalReplayParams {
  companyId: number;
  supplierId: number | null | undefined;
  containerId: number;
  chargeId?: number | null;
  mutationAction: "CREATE" | "EDIT" | "UNDO" | "LEGACY_REBUILD";
  userId: string;
  username?: string | null;
}

export interface PostOffloadHistoricalReplayResult {
  status: PostOffloadHistoricalReplayStatus;
  supplierId: number | null;
  containerId: number;
  chargeId?: number | null;
  reason?: string;
  code?: string;
  blockedReasons?: string[];
  suppliersApplied?: number;
  rawStockRowsUpdated?: number;
  sourcesUpdated?: number;
  batchesUpdated?: number;
  balesUpdated?: number;
  supplierRatesUpdated?: number;
  undoLogCreated?: boolean;
}

interface ExactReplayUndoEnvelope {
  kind: typeof EXACT_UNDO_KIND;
  algorithmVersion: string;
  fingerprint: string;
  includeCompletedBatches: boolean;
  includeFinalizedBales: boolean;
  scope: ReplayWriteScope;
  baleIds: number[];
  before: ExactReplaySnapshot;
  after: ExactReplaySnapshot;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

/**
 * Replay the exact historical supplier-cost timeline after a successful
 * post-offload charge mutation.
 *
 * This is intentionally a post-commit operation. The charge/container/accounting
 * mutation remains atomic in its original transaction; this replay then runs in
 * the historical engine's own SERIALIZABLE, advisory-locked transaction. If the
 * replay is blocked or fails, callers must surface the returned repair status and
 * must not claim that historical production costs were updated.
 */
export async function replayPostOffloadHistoricalCosts(
  params: PostOffloadHistoricalReplayParams
): Promise<PostOffloadHistoricalReplayResult> {
  const { companyId, supplierId, containerId, chargeId, mutationAction } = params;
  // audit_log.user_id and username are NOT NULL. A caller without a user id is
  // the request's / job's actor, else "system" (as writeAuditEvent does); a
  // user without a session username is shown by id.
  const givenUserId = String(params.userId ?? "").trim();
  const actor = givenUserId
    ? { userId: givenUserId, username: String(params.username ?? "").trim() || givenUserId }
    : currentAuditActor({ userId: "system", username: "system" });

  if (!supplierId || supplierId <= 0) {
    return {
      status: "no_changes",
      supplierId: supplierId ?? null,
      containerId,
      chargeId,
      reason: "Container has no supplier-backed historical cost timeline.",
    };
  }

  const includeCompletedBatches = true;
  // Sold/dispatched/finalized bales remain protected. They can still be repaired
  // through the explicit admin replay flow where that option is confirmed.
  const includeFinalizedBales = false;

  try {
    const prepareClient = await pool.connect();
    let normalizedScope: ReplayWriteScope;
    let fingerprint: string;
    let blockedReasons: string[] = [];

    try {
      await prepareClient.query("BEGIN");
      await prepareClient.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const executor = prepareClient as unknown as ReplayQueryExecutor;

      const selectionPreview = await previewHistoricalCostReplayWithExecutor(executor, companyId);
      const supplierPreview = selectionPreview.supplierRows.find((row) => row.supplierId === supplierId);

      if (!supplierPreview) {
        await prepareClient.query("COMMIT");
        return {
          status: "no_changes",
          supplierId,
          containerId,
          chargeId,
          reason: "No historical replay inputs exist for this supplier.",
        };
      }

      if (!supplierPreview.safeToRepair) {
        blockedReasons = Array.isArray(supplierPreview.reasons)
          ? supplierPreview.reasons.map(String)
          : ["Supplier timeline is not safe for automatic historical replay."];
        await prepareClient.query("COMMIT");
        return {
          status: "blocked",
          supplierId,
          containerId,
          chargeId,
          reason: "Historical supplier-cost replay requires admin review.",
          blockedReasons,
        };
      }

      const internalScope = await buildHistoricalReplayScopeInternal({
        companyId,
        selectedSupplierIds: new Set([supplierId]),
        includeCompletedBatches,
        includeFinalizedBales,
        executor,
        lockRows: false,
      });
      normalizedScope = normalizeReplayWriteScope(internalScope);

      if (!normalizedScope.supplierIds.includes(supplierId)) {
        blockedReasons = internalScope.blockedBatches.flatMap((batch) => batch.reasons);
        await prepareClient.query("COMMIT");
        return {
          status: blockedReasons.length > 0 ? "blocked" : "no_changes",
          supplierId,
          containerId,
          chargeId,
          reason:
            blockedReasons.length > 0
              ? "Historical replay closure contains blocked batches."
              : "No historical supplier-priced costs require replay.",
          blockedReasons: blockedReasons.length > 0 ? [...new Set(blockedReasons)] : undefined,
        };
      }

      fingerprint = computeReplayFingerprint(
        companyId,
        normalizedScope.supplierIds,
        internalScope._fullPreview,
        { includeCompletedBatches, includeFinalizedBales },
        normalizedScope
      );

      await prepareClient.query("COMMIT");
    } catch (error) {
      await prepareClient.query("ROLLBACK");
      throw error;
    } finally {
      prepareClient.release();
    }

    const supplierNameResult = await pool.query<{ name: string }>(
      `SELECT name
       FROM factory_suppliers
       WHERE id = $1 AND company_id = $2`,
      [supplierId, companyId]
    );
    const supplierName = supplierNameResult.rows[0]?.name || `Supplier ${supplierId}`;
    const baleIds = replayBaleIdsForScope(normalizedScope, includeFinalizedBales);
    const tokenHash = crypto
      .createHash("sha256")
      .update(
        [
          "post-offload-historical-replay",
          companyId,
          supplierId,
          containerId,
          chargeId ?? "none",
          mutationAction,
          crypto.randomUUID(),
        ].join(":"),
        "utf8"
      )
      .digest("hex");

    let undoLogCreated = false;
    const result = await applyHistoricalCostReplay({
      companyId,
      supplierIds: normalizedScope.supplierIds,
      includeCompletedBatches,
      includeFinalizedBales,
      expectedFingerprint: fingerprint,
      expectedScope: normalizedScope,
      algorithmVersion: REPLAY_ALGORITHM_VERSION,
      issuedByUserId: actor.userId,
      tokenHash,
      onCommit: async (client, applyResult, snapshots) => {
        const undoEnvelope: ExactReplayUndoEnvelope = {
          kind: EXACT_UNDO_KIND,
          algorithmVersion: REPLAY_ALGORITHM_VERSION,
          fingerprint,
          includeCompletedBatches,
          includeFinalizedBales,
          scope: normalizedScope,
          baleIds,
          before: snapshots.before,
          after: snapshots.after,
        };

        await client.query(
          `INSERT INTO factory_recalc_undo_log
             (company_id, user_id, username, description, container_count,
              container_numbers, snapshot, operation_type, algorithm_version,
              scope_fingerprint)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   'HISTORICAL_REPLAY_EXACT', $8, $9)`,
          [
            companyId,
            actor.userId,
            actor.username,
            `Post-offload ${mutationAction.toLowerCase()} historical replay — ${supplierName}`,
            normalizedScope.containerIdsToUpdate.length,
            [],
            JSON.stringify(undoEnvelope),
            REPLAY_ALGORITHM_VERSION,
            fingerprint,
          ]
        );
        undoLogCreated = true;

        await client.query(
          `INSERT INTO audit_log
             (user_id, username, company_id, action, table_name, record_id,
              record_identifier, changes, created_at)
           VALUES ($1, $2, $3, 'post_offload_historical_replay_applied',
                   'factory_offload_additional_charges', $4, $5, $6::jsonb, NOW())`,
          [
            actor.userId,
            actor.username,
            companyId,
            chargeId ?? containerId,
            `post-offload ${mutationAction.toLowerCase()} — container ${containerId}, supplier ${supplierId}`,
            JSON.stringify({
              mutationAction,
              containerId,
              chargeId: chargeId ?? null,
              supplierId,
              applied: applyResult,
              scope: normalizedScope,
              options: { includeCompletedBatches, includeFinalizedBales },
              fingerprint,
            }),
          ]
        );
      },
    });

    return {
      status: "applied",
      supplierId,
      containerId,
      chargeId,
      suppliersApplied: result.suppliersApplied,
      rawStockRowsUpdated: result.rawStockRowsUpdated,
      sourcesUpdated: result.sourcesUpdated,
      batchesUpdated: result.batchesUpdated,
      balesUpdated: result.balesUpdated,
      supplierRatesUpdated: result.supplierRatesUpdated,
      undoLogCreated,
    };
  } catch (error) {
    return {
      status: "failed",
      supplierId,
      containerId,
      chargeId,
      reason: errorMessage(error),
      code: errorCode(error),
    };
  }
}
