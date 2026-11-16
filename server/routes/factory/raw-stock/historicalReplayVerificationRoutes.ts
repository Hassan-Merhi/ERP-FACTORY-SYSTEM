import type { Express } from "express";
import { requireAuth, requireRole } from "../../../auth";
import { pool } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import {
  assertExactReplayCurrentCostsMatchApplied,
  assertExactReplayNonCostInvariants,
  captureExactReplaySnapshot,
  normalizeReplayWriteScope,
  REPLAY_ALGORITHM_VERSION,
  type ExactReplaySnapshot,
  type ReplayQueryExecutor,
  type ReplayWriteScope,
} from "../../../services/factory/historicalCostReplay";

const VERIFICATION_PATH = "/api/factory/raw-stock/recalc/historical-replay/verification";
const EXACT_UNDO_KIND = "HISTORICAL_REPLAY_EXACT_V1" as const;
const ADMIN_ROLES = ["Admin", "Developer"] as const;

interface ExactReplayVerificationEnvelope {
  kind: typeof EXACT_UNDO_KIND;
  algorithmVersion: string;
  fingerprint: string;
  scope: ReplayWriteScope;
  baleIds: number[];
  before: ExactReplaySnapshot;
  after: ExactReplaySnapshot;
}

interface VerificationUndoRow {
  id: number;
  snapshot: unknown;
  algorithm_version: string | null;
  scope_fingerprint: string | null;
  applied_at: Date | string;
  undone_at: Date | string | null;
}

function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map((item) => Number(item));
  if (ids.some((item) => !Number.isInteger(item) || item <= 0)) return null;
  return [...new Set(ids)].sort((left, right) => left - right);
}

function parseScope(value: unknown): ReplayWriteScope | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const supplierIds = numberArray(input.supplierIds);
  const containerIdsToUpdate = numberArray(input.containerIdsToUpdate);
  const rawStockIdsToUpdate = numberArray(input.rawStockIdsToUpdate);
  const sourceIdsToUpdate = numberArray(input.sourceIdsToUpdate);
  const batchIdsToUpdate = numberArray(input.batchIdsToUpdate);
  const availableBaleIdsToUpdate = numberArray(input.availableBaleIdsToUpdate);
  const finalizedBaleIdsToUpdate = numberArray(input.finalizedBaleIdsToUpdate);
  if (
    !supplierIds
    || !containerIdsToUpdate
    || !rawStockIdsToUpdate
    || !sourceIdsToUpdate
    || !batchIdsToUpdate
    || !availableBaleIdsToUpdate
    || !finalizedBaleIdsToUpdate
    || !Array.isArray(input.blockedBatches)
  ) {
    return null;
  }

  const blockedBatches: ReplayWriteScope["blockedBatches"] = [];
  for (const rawRow of input.blockedBatches) {
    if (!rawRow || typeof rawRow !== "object") return null;
    const row = rawRow as Record<string, unknown>;
    const batchId = Number(row.batchId);
    if (
      !Number.isInteger(batchId)
      || batchId <= 0
      || typeof row.batchCode !== "string"
      || !Array.isArray(row.reasons)
      || row.reasons.some((reason) => typeof reason !== "string")
    ) {
      return null;
    }
    blockedBatches.push({
      batchId,
      batchCode: row.batchCode,
      reasons: [...new Set(row.reasons as string[])].sort(),
    });
  }

  return normalizeReplayWriteScope({
    supplierIds,
    containerIdsToUpdate,
    rawStockIdsToUpdate,
    sourceIdsToUpdate,
    batchIdsToUpdate,
    availableBaleIdsToUpdate,
    finalizedBaleIdsToUpdate,
    blockedBatches,
  });
}

function parseEnvelope(value: unknown): ExactReplayVerificationEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const scope = parseScope(input.scope);
  const baleIds = numberArray(input.baleIds);
  if (
    input.kind !== EXACT_UNDO_KIND
    || typeof input.algorithmVersion !== "string"
    || typeof input.fingerprint !== "string"
    || !scope
    || !baleIds
    || !input.before
    || typeof input.before !== "object"
    || !input.after
    || typeof input.after !== "object"
  ) {
    return null;
  }
  return {
    kind: EXACT_UNDO_KIND,
    algorithmVersion: input.algorithmVersion,
    fingerprint: input.fingerprint,
    scope,
    baleIds,
    before: input.before as ExactReplaySnapshot,
    after: input.after as ExactReplaySnapshot,
  };
}

function verificationCounts(snapshot: ExactReplaySnapshot) {
  return {
    containers: snapshot.containers.length,
    rawStockRows: snapshot.rawStockRows.length,
    sources: snapshot.mixBatchSources.length,
    batches: snapshot.mixBatches.length,
    bales: snapshot.bales.length,
    suppliers: snapshot.suppliers.length,
  };
}

/** Read-only exact verification of the latest or requested replay/undo state. */
export function registerHistoricalReplayPhase8VerificationRoutes(app: Express): void {
  app.get(
    VERIFICATION_PATH,
    requireAuth,
    requireRole(...ADMIN_ROLES),
    async (req: import("express").Request, res: import("express").Response) => {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const requestedId = req.query?.undoLogId == null
        ? null
        : Number.parseInt(String(req.query.undoLogId), 10);
      if (requestedId != null && (!Number.isInteger(requestedId) || requestedId <= 0)) {
        return res.status(400).json({
          message: "undoLogId must be a positive integer",
          code: "HISTORICAL_REPLAY_VERIFICATION_ID_INVALID",
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const rowResult = requestedId == null
          ? await client.query<VerificationUndoRow>(
              `SELECT id, snapshot, algorithm_version, scope_fingerprint, applied_at, undone_at
               FROM factory_recalc_undo_log
               WHERE company_id = $1
                 AND operation_type = 'HISTORICAL_REPLAY_EXACT'
               ORDER BY applied_at DESC, id DESC
               LIMIT 1`,
              [companyId]
            )
          : await client.query<VerificationUndoRow>(
              `SELECT id, snapshot, algorithm_version, scope_fingerprint, applied_at, undone_at
               FROM factory_recalc_undo_log
               WHERE id = $1
                 AND company_id = $2
                 AND operation_type = 'HISTORICAL_REPLAY_EXACT'`,
              [requestedId, companyId]
            );
        const row = rowResult.rows[0];
        if (!row) {
          await client.query("ROLLBACK");
          return res.status(404).json({
            message: "No exact Historical Replay undo record was found for this company.",
            code: "HISTORICAL_REPLAY_VERIFICATION_NOT_FOUND",
          });
        }

        const envelope = parseEnvelope(row.snapshot);
        if (!envelope) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            message: "Historical Replay verification snapshot is malformed.",
            code: "HISTORICAL_REPLAY_VERIFICATION_SNAPSHOT_INVALID",
          });
        }
        if (
          envelope.algorithmVersion !== REPLAY_ALGORITHM_VERSION
          || row.algorithm_version !== REPLAY_ALGORITHM_VERSION
          || row.scope_fingerprint !== envelope.fingerprint
        ) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            message: "Historical Replay verification record does not match the current algorithm and stored fingerprint.",
            code: "HISTORICAL_REPLAY_VERIFICATION_VERSION_MISMATCH",
          });
        }

        const expected = row.undone_at ? envelope.before : envelope.after;
        const current = await captureExactReplaySnapshot(
          client as unknown as ReplayQueryExecutor,
          companyId,
          envelope.scope,
          envelope.baleIds
        );
        assertExactReplayNonCostInvariants(expected, current);
        assertExactReplayCurrentCostsMatchApplied(expected, current);
        await client.query("COMMIT");

        return res.json({
          verified: true,
          readOnly: true,
          companyId,
          undoLogId: row.id,
          state: row.undone_at ? "UNDONE" : "APPLIED",
          algorithmVersion: envelope.algorithmVersion,
          scopeFingerprint: envelope.fingerprint,
          appliedAt: row.applied_at,
          undoneAt: row.undone_at,
          counts: verificationCounts(expected),
          message: row.undone_at
            ? "Current costs and non-cost fields exactly match the stored pre-apply snapshot."
            : "Current costs and non-cost fields exactly match the stored post-apply snapshot.",
        });
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        const code = (error as { code?: string }).code;
        const mismatch = [
          "HISTORICAL_REPLAY_UNDO_STALE",
          "HISTORICAL_REPLAY_INVARIANT_VIOLATION",
        ].includes(code ?? "");
        return res.status(mismatch ? 409 : 500).json({
          verified: false,
          readOnly: true,
          message: getErrorMessage(error) || "Historical Replay exact verification failed",
          code: code ?? "HISTORICAL_REPLAY_VERIFICATION_FAILED",
        });
      } finally {
        client.release();
      }
    }
  );
}
