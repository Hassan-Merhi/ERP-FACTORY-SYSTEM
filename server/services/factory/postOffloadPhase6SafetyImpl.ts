import {
  REPLAY_ALGORITHM_VERSION,
  StaleTokenError,
  applyHistoricalCostReplay,
  replayBaleIdsForScope,
  replayWriteScopesEqual,
} from "./historicalCostReplay";
import {
  ExpiredRepairTokenError,
  InvalidRepairTokenError,
  REPAIR_TOKEN_TTL_MS,
  RepairTokenConfigurationError,
  signRepairToken,
  verifyRepairToken,
} from "./repairToken";
import { historicalReplayReadinessVersion } from "./historical-replay/productionReadinessV8";
import { POST_OFFLOAD_REPORT_QUERY_KEYS } from "./postOffloadReconciliation";
import {
  EXACT_UNDO_KIND,
  InvalidPostOffloadPhase6TokenError,
  PHASE6_TOKEN_KIND,
  PHASE6_TOKEN_VERSION,
  StalePostOffloadPhase6TokenError,
  parseReplayScope,
  scopeCounts,
  sha256,
  uniqueSortedNumbers,
  type ExactReplayUndoEnvelope,
  type PostOffloadPhase6Readiness,
  type PostOffloadPhase6Status,
  type PostOffloadPhase6TokenPayload,
  type PreparedPostOffloadPhase6Repair,
} from "./postOffloadPhase6SafetyImplParseReplayScope";
import { buildSnapshot } from "./postOffloadPhase6SafetyImplBuildSnapshot";
export {
  InvalidPostOffloadPhase6TokenError,
  StalePostOffloadPhase6TokenError,
} from "./postOffloadPhase6SafetyImplParseReplayScope";
export type {
  PostOffloadPhase6Integrity,
  PostOffloadPhase6Readiness,
  PostOffloadPhase6ScopeCounts,
  PostOffloadPhase6Status,
  PreparedPostOffloadPhase6Repair,
} from "./postOffloadPhase6SafetyImplParseReplayScope";
export async function inspectPostOffloadPhase6Readiness(params: {
  companyId: number;
  supplierIds?: unknown;
}): Promise<PostOffloadPhase6Readiness> {
  return (
    await buildSnapshot({
      companyId: params.companyId,
      requestedSupplierIds: params.supplierIds,
    })
  ).readiness;
}
export async function preparePostOffloadPhase6Repair(params: {
  companyId: number;
  userId: string;
  supplierIds?: unknown;
}): Promise<PreparedPostOffloadPhase6Repair> {
  const snapshot = await buildSnapshot({
    companyId: params.companyId,
    requestedSupplierIds: params.supplierIds,
  });
  const readiness = snapshot.readiness;
  if (!readiness.automaticRepairEligible || !readiness.productionControl.releaseId || !readiness.fingerprint) {
    return {
      dryRun: true,
      status: readiness.status,
      confirmationToken: null,
      expiresInMs: null,
      readiness,
      frozenScope: snapshot.scope,
      frozenOptions: {
        includeCompletedBatches: true,
        includeFinalizedBales: false,
      },
      instructions:
        readiness.status === "ready"
          ? "No post-offload historical cost repair is required."
          : readiness.status === "blocked"
            ? "Apply is blocked. Resolve every production-control, schema, safety, FX, or scope blocker and run the dry-run again."
            : "Repair is still required, but no automatic historical cost scope is eligible. Repair the reported charge, accounting, reversal, or raw-stock integrity issues and run readiness again.",
    };
  }
  const issuedAt = Date.now();
  const payload: PostOffloadPhase6TokenPayload = {
    kind: PHASE6_TOKEN_KIND,
    version: PHASE6_TOKEN_VERSION,
    purpose: "POST_OFFLOAD_HISTORICAL_COST_REPAIR",
    companyId: params.companyId,
    userId: params.userId,
    releaseId: readiness.productionControl.releaseId,
    algorithmVersion: REPLAY_ALGORITHM_VERSION,
    readinessVersion: readiness.readinessVersion,
    supplierIds: readiness.selectedSupplierIds,
    scope: snapshot.scope,
    scopeRowCount: readiness.scope.totalWritableRows,
    fingerprint: readiness.fingerprint,
    stateFingerprint: readiness.stateFingerprint,
    includeCompletedBatches: true,
    includeFinalizedBales: false,
    issuedAt,
    expiresAt: issuedAt + REPAIR_TOKEN_TTL_MS,
  };
  return {
    dryRun: true,
    status: readiness.status,
    confirmationToken: signRepairToken(payload),
    expiresInMs: REPAIR_TOKEN_TTL_MS,
    readiness,
    frozenScope: snapshot.scope,
    frozenOptions: {
      includeCompletedBatches: true,
      includeFinalizedBales: false,
    },
    instructions:
      "Review the exact supplier/container/raw-stock/source/batch/bale scope, then apply before the token expires. Finalized or sold bales remain excluded.",
  };
}
function parseToken(value: unknown): PostOffloadPhase6TokenPayload {
  let payload: PostOffloadPhase6TokenPayload;
  try {
    payload = verifyRepairToken<PostOffloadPhase6TokenPayload>(String(value ?? ""));
  } catch (error) {
    if (error instanceof ExpiredRepairTokenError) {
      throw new StalePostOffloadPhase6TokenError("Post-offload repair approval expired. Re-run the dry-run plan.");
    }
    if (error instanceof InvalidRepairTokenError) {
      throw new InvalidPostOffloadPhase6TokenError(error.message);
    }
    throw error;
  }
  if (
    payload.kind !== PHASE6_TOKEN_KIND ||
    payload.version !== PHASE6_TOKEN_VERSION ||
    payload.purpose !== "POST_OFFLOAD_HISTORICAL_COST_REPAIR"
  ) {
    throw new InvalidPostOffloadPhase6TokenError("Unsupported post-offload Phase 6 token.");
  }
  return payload;
}
export async function applyPostOffloadPhase6Repair(params: {
  companyId: number;
  userId: string;
  username?: string | null;
  confirmationToken: unknown;
}): Promise<{
  success: true;
  status: PostOffloadPhase6Status;
  applied: Awaited<ReturnType<typeof applyHistoricalCostReplay>>;
  undoLogId: number;
  readiness: PostOffloadPhase6Readiness;
  reportQueryKeys: readonly string[];
}> {
  const payload = parseToken(params.confirmationToken);
  const signedScope = parseReplayScope(payload.scope);
  if (!signedScope) {
    throw new InvalidPostOffloadPhase6TokenError("Signed repair scope is malformed.");
  }
  if (
    payload.companyId !== params.companyId ||
    payload.userId !== params.userId ||
    payload.algorithmVersion !== REPLAY_ALGORITHM_VERSION ||
    payload.readinessVersion !== historicalReplayReadinessVersion() ||
    payload.includeCompletedBatches !== true ||
    payload.includeFinalizedBales !== false ||
    JSON.stringify(uniqueSortedNumbers(payload.supplierIds)) !== JSON.stringify(signedScope.supplierIds) ||
    payload.scopeRowCount !== scopeCounts(signedScope).totalWritableRows
  ) {
    throw new InvalidPostOffloadPhase6TokenError(
      "Repair approval does not match this user, company, algorithm, options, or exact scope."
    );
  }
  const fresh = await buildSnapshot({
    companyId: params.companyId,
    requestedSupplierIds: payload.supplierIds,
  });
  if (
    !fresh.readiness.productionControl.enabled ||
    fresh.readiness.productionControl.releaseId !== payload.releaseId ||
    !fresh.readiness.schema.ready ||
    !fresh.readiness.safety.allSafetyGatesPassed ||
    fresh.readiness.fingerprint !== payload.fingerprint ||
    fresh.readiness.stateFingerprint !== payload.stateFingerprint ||
    !replayWriteScopesEqual(signedScope, fresh.scope)
  ) {
    throw new StalePostOffloadPhase6TokenError();
  }
  const tokenHash = sha256(String(params.confirmationToken));
  const baleIds = replayBaleIdsForScope(signedScope, false);
  let undoLogId = 0;
  const applied = await applyHistoricalCostReplay({
    companyId: params.companyId,
    supplierIds: signedScope.supplierIds,
    includeCompletedBatches: true,
    includeFinalizedBales: false,
    expectedFingerprint: payload.fingerprint,
    expectedScope: signedScope,
    algorithmVersion: payload.algorithmVersion,
    issuedByUserId: params.userId,
    tokenHash,
    onCommit: async (executor, applyResult, snapshots) => {
      const undoEnvelope: ExactReplayUndoEnvelope = {
        kind: EXACT_UNDO_KIND,
        algorithmVersion: payload.algorithmVersion,
        fingerprint: payload.fingerprint,
        includeCompletedBatches: true,
        includeFinalizedBales: false,
        scope: signedScope,
        baleIds,
        before: snapshots.before,
        after: snapshots.after,
      };
      const undo = await executor.query<{ id: number }>(
        `INSERT INTO factory_recalc_undo_log
           (company_id, user_id, username, description, container_count,
            container_numbers, snapshot, operation_type, algorithm_version,
            scope_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 'HISTORICAL_REPLAY_EXACT', $8, $9)
         RETURNING id`,
        [
          params.companyId,
          params.userId || null,
          params.username ?? null,
          `Post-offload Phase 6 controlled repair — ${signedScope.supplierIds.length} supplier(s)`,
          signedScope.containerIdsToUpdate.length,
          [],
          JSON.stringify(undoEnvelope),
          payload.algorithmVersion,
          payload.fingerprint,
        ]
      );
      undoLogId = undo.rows[0]?.id ?? 0;
      if (!undoLogId) {
        throw new Error("Phase 6 repair could not persist its exact undo log. Rolling back.");
      }
      await executor.query(
        `INSERT INTO audit_log
           (user_id, username, company_id, action, table_name, record_id,
            record_identifier, changes, created_at)
         VALUES ($1, $2, $3, 'post_offload_phase6_applied',
                 'factory_recalc_undo_log', $4, $5, $6::jsonb, NOW())`,
        [
          params.userId || null,
          params.username ?? null,
          params.companyId,
          undoLogId,
          `post-offload phase 6 repair — undo ${undoLogId}`,
          JSON.stringify({
            releaseId: payload.releaseId,
            algorithmVersion: payload.algorithmVersion,
            readinessVersion: payload.readinessVersion,
            fingerprint: payload.fingerprint,
            stateFingerprint: payload.stateFingerprint,
            scope: signedScope,
            applied: applyResult,
            finalizedBalesExcluded: signedScope.finalizedBaleIdsToUpdate.length,
            reportQueryKeys: POST_OFFLOAD_REPORT_QUERY_KEYS,
          }),
        ]
      );
    },
  });
  if (!undoLogId) {
    throw new Error("Phase 6 repair completed without an exact undo identifier.");
  }
  let readiness: PostOffloadPhase6Readiness;
  try {
    readiness = await inspectPostOffloadPhase6Readiness({
      companyId: params.companyId,
      supplierIds: payload.supplierIds,
    });
  } catch (error) {
    const verificationError = new Error(
      `Phase 6 repair committed with undo log ${undoLogId}, but post-commit verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    ) as Error & {
      code: string;
      repairCommitted: boolean;
      undoLogId: number;
      applied: typeof applied;
      cause: unknown;
    };
    verificationError.code = "POST_OFFLOAD_PHASE6_POST_COMMIT_VERIFICATION_FAILED";
    verificationError.repairCommitted = true;
    verificationError.undoLogId = undoLogId;
    verificationError.applied = applied;
    verificationError.cause = error;
    throw verificationError;
  }
  return {
    success: true,
    status: readiness.status,
    applied,
    undoLogId,
    readiness,
    reportQueryKeys: POST_OFFLOAD_REPORT_QUERY_KEYS,
  };
}
export function phase6ErrorStatus(error: unknown): number {
  if (
    error instanceof StalePostOffloadPhase6TokenError ||
    error instanceof StaleTokenError ||
    (error as { code?: string })?.code === "STALE_TOKEN" ||
    (error as { code?: string })?.code === "HISTORICAL_REPLAY_SCOPE_VIOLATION" ||
    (error as { code?: string })?.code === "HISTORICAL_REPLAY_INVARIANT_VIOLATION"
  ) {
    return 409;
  }
  if (error instanceof InvalidPostOffloadPhase6TokenError) return 400;
  if (error instanceof RepairTokenConfigurationError) return 503;
  return 500;
}
