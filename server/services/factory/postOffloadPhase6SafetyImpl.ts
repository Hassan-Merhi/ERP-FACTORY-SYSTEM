import crypto from "node:crypto";
import Decimal from "decimal.js";
import { pool } from "../../db";
import {
  REPLAY_ALGORITHM_VERSION,
  StaleTokenError,
  applyHistoricalCostReplay,
  buildHistoricalReplayScopeInternal,
  computeReplayFingerprint,
  normalizeReplayWriteScope,
  previewHistoricalCostReplayWithExecutor,
  replayBaleIdsForScope,
  replayWriteScopesEqual,
  type ExactReplaySnapshot,
  type HistoricalReplayPreviewResult,
  type ReplayQueryExecutor,
  type ReplayWriteScope,
} from "./historicalCostReplay";
import {
  ExpiredRepairTokenError,
  InvalidRepairTokenError,
  REPAIR_TOKEN_TTL_MS,
  RepairTokenConfigurationError,
  signRepairToken,
  verifyRepairToken,
} from "./repairToken";
import {
  evaluateHistoricalReplaySafetyReadiness,
  historicalReplayAuthorizationReady,
  historicalReplayReadinessVersion,
  inspectHistoricalReplayProductionSchema,
  readHistoricalReplayProductionControl,
} from "./historical-replay/productionReadinessV8";
import { POST_OFFLOAD_REPORT_QUERY_KEYS } from "./postOffloadReconciliation";
import { inspectPhase5ReplayScopeSafety } from "./historical-replay/downstreamGatePhase5";
const PHASE6_TOKEN_KIND = "POST_OFFLOAD_PHASE6_REPAIR_V1" as const;
const PHASE6_TOKEN_VERSION = 1 as const;
const EXACT_UNDO_KIND = "HISTORICAL_REPLAY_EXACT_V1" as const;
const INCLUDE_COMPLETED_BATCHES = true;
const INCLUDE_FINALIZED_BALES = false;
export type PostOffloadPhase6Status = "ready" | "repair_required" | "blocked";
export interface PostOffloadPhase6Integrity {
  activeCharges: number;
  deletedCharges: number;
  unresolvedFxCharges: number;
  missingDaybookLinks: number;
  missingVoucherLinks: number;
  incompleteVoucherCurrencyRows: number;
  missingReversalLinks: number;
  rawStockCostDriftRows: number;
  maxRawStockCostDriftUsdPerKg: string;
  issueCount: number;
}
export interface PostOffloadPhase6ScopeCounts {
  suppliers: number;
  containers: number;
  rawStockRows: number;
  supplierSources: number;
  batches: number;
  availableBales: number;
  finalizedBalesExcluded: number;
  blockedBatches: number;
  supplierRateChanges: number;
  actualChangeRows: number;
  totalWritableRows: number;
}
export interface PostOffloadPhase6Readiness {
  phase: 6;
  generatedAt: string;
  companyId: number;
  status: PostOffloadPhase6Status;
  algorithmVersion: string;
  readinessVersion: string;
  productionControl: {
    enabled: boolean;
    releaseId: string | null;
    configurationErrors: string[];
  };
  schema: Awaited<ReturnType<typeof inspectHistoricalReplayProductionSchema>>;
  safety: ReturnType<typeof evaluateHistoricalReplaySafetyReadiness>;
  integrity: PostOffloadPhase6Integrity;
  postOffloadSupplierIds: number[];
  selectedSupplierIds: number[];
  scope: PostOffloadPhase6ScopeCounts;
  fingerprint: string | null;
  stateFingerprint: string;
  latestUndo: {
    id: number;
    algorithmVersion: string | null;
    scopeFingerprint: string | null;
    appliedAt: string;
    undoneAt: string | null;
  } | null;
  automaticRepairEligible: boolean;
  blockers: string[];
  reportQueryKeys: readonly string[];
}
export interface PreparedPostOffloadPhase6Repair {
  dryRun: true;
  status: PostOffloadPhase6Status;
  confirmationToken: string | null;
  expiresInMs: number | null;
  readiness: PostOffloadPhase6Readiness;
  frozenScope: ReplayWriteScope;
  frozenOptions: {
    includeCompletedBatches: true;
    includeFinalizedBales: false;
  };
  instructions: string;
}
interface PostOffloadPhase6TokenPayload {
  kind: typeof PHASE6_TOKEN_KIND;
  version: typeof PHASE6_TOKEN_VERSION;
  purpose: "POST_OFFLOAD_HISTORICAL_COST_REPAIR";
  companyId: number;
  userId: string;
  releaseId: string;
  algorithmVersion: string;
  readinessVersion: string;
  supplierIds: number[];
  scope: ReplayWriteScope;
  scopeRowCount: number;
  fingerprint: string;
  stateFingerprint: string;
  includeCompletedBatches: true;
  includeFinalizedBales: false;
  issuedAt: number;
  expiresAt: number;
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
interface IntegrityRow {
  active_charges: string;
  deleted_charges: string;
  unresolved_fx_charges: string;
  missing_daybook_links: string;
  missing_voucher_links: string;
  incomplete_voucher_currency_rows: string;
  missing_reversal_links: string;
  raw_stock_cost_drift_rows: string;
  max_raw_stock_cost_drift: string | null;
}
interface LatestUndoRow {
  id: number;
  algorithm_version: string | null;
  scope_fingerprint: string | null;
  applied_at: Date | string;
  undone_at: Date | string | null;
}
interface Phase6Snapshot {
  readiness: PostOffloadPhase6Readiness;
  preview: HistoricalReplayPreviewResult | null;
  scope: ReplayWriteScope;
}
export class InvalidPostOffloadPhase6TokenError extends Error {
  readonly code = "POST_OFFLOAD_PHASE6_TOKEN_INVALID";
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidPostOffloadPhase6TokenError";
  }
}
export class StalePostOffloadPhase6TokenError extends Error {
  readonly code = "POST_OFFLOAD_PHASE6_TOKEN_STALE";
  readonly statusCode = 409;
  constructor(message = "Post-offload repair state changed after preview. Re-run the dry-run plan.") {
    super(message);
    this.name = "StalePostOffloadPhase6TokenError";
  }
}
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
function stableHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}
function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
function requestedSupplierIds(value: unknown): number[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new InvalidPostOffloadPhase6TokenError("supplierIds must be an array of positive integers.");
  }
  const parsed = value.map((item) => Number(item));
  if (parsed.some((item) => !Number.isInteger(item) || item <= 0)) {
    throw new InvalidPostOffloadPhase6TokenError("supplierIds must contain only positive integers.");
  }
  return uniqueSortedNumbers(parsed);
}
function emptyScope(): ReplayWriteScope {
  return {
    supplierIds: [],
    containerIdsToUpdate: [],
    rawStockIdsToUpdate: [],
    sourceIdsToUpdate: [],
    batchIdsToUpdate: [],
    availableBaleIdsToUpdate: [],
    finalizedBaleIdsToUpdate: [],
    blockedBatches: [],
  };
}
function count(value: string | number | null | undefined): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
function decimal(value: string | number | null | undefined): Decimal {
  try {
    const parsed = new Decimal(value ?? 0);
    return parsed.isFinite() ? parsed : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}
function scopeCounts(scope: ReplayWriteScope, supplierRateChanges = 0): PostOffloadPhase6ScopeCounts {
  const nonSupplierChangeRows =
    scope.containerIdsToUpdate.length +
    scope.rawStockIdsToUpdate.length +
    scope.sourceIdsToUpdate.length +
    scope.batchIdsToUpdate.length +
    scope.availableBaleIdsToUpdate.length;
  const totalWritableRows =
    scope.containerIdsToUpdate.length +
    scope.rawStockIdsToUpdate.length +
    scope.sourceIdsToUpdate.length +
    scope.batchIdsToUpdate.length +
    scope.availableBaleIdsToUpdate.length +
    scope.supplierIds.length;
  return {
    suppliers: scope.supplierIds.length,
    containers: scope.containerIdsToUpdate.length,
    rawStockRows: scope.rawStockIdsToUpdate.length,
    supplierSources: scope.sourceIdsToUpdate.length,
    batches: scope.batchIdsToUpdate.length,
    availableBales: scope.availableBaleIdsToUpdate.length,
    finalizedBalesExcluded: scope.finalizedBaleIdsToUpdate.length,
    blockedBatches: scope.blockedBatches.length,
    supplierRateChanges,
    actualChangeRows: nonSupplierChangeRows + supplierRateChanges,
    totalWritableRows,
  };
}
function parseNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map((item) => Number(item));
  if (values.some((item) => !Number.isInteger(item) || item <= 0)) return null;
  return uniqueSortedNumbers(values);
}
function parseReplayScope(value: unknown): ReplayWriteScope | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const supplierIds = parseNumberArray(input.supplierIds);
  const containerIdsToUpdate = parseNumberArray(input.containerIdsToUpdate);
  const rawStockIdsToUpdate = parseNumberArray(input.rawStockIdsToUpdate);
  const sourceIdsToUpdate = parseNumberArray(input.sourceIdsToUpdate);
  const batchIdsToUpdate = parseNumberArray(input.batchIdsToUpdate);
  const availableBaleIdsToUpdate = parseNumberArray(input.availableBaleIdsToUpdate);
  const finalizedBaleIdsToUpdate = parseNumberArray(input.finalizedBaleIdsToUpdate);
  if (
    !supplierIds ||
    !containerIdsToUpdate ||
    !rawStockIdsToUpdate ||
    !sourceIdsToUpdate ||
    !batchIdsToUpdate ||
    !availableBaleIdsToUpdate ||
    !finalizedBaleIdsToUpdate ||
    !Array.isArray(input.blockedBatches)
  ) {
    return null;
  }
  const blockedBatches: ReplayWriteScope["blockedBatches"] = [];
  for (const raw of input.blockedBatches) {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (
      typeof row.batchId !== "number" ||
      !Number.isInteger(row.batchId) ||
      typeof row.batchCode !== "string" ||
      !Array.isArray(row.reasons) ||
      row.reasons.some((reason) => typeof reason !== "string")
    ) {
      return null;
    }
    blockedBatches.push({
      batchId: Number(row.batchId),
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
async function loadIntegrity(executor: ReplayQueryExecutor, companyId: number): Promise<PostOffloadPhase6Integrity> {
  const result = await executor.query<IntegrityRow>(
    `WITH charge_integrity AS (
       SELECT
         COUNT(*) FILTER (WHERE charge.deleted_at IS NULL)::text AS active_charges,
         COUNT(*) FILTER (WHERE charge.deleted_at IS NOT NULL)::text AS deleted_charges,
         COUNT(*) FILTER (
           WHERE charge.deleted_at IS NULL
             AND UPPER(COALESCE(charge.currency_code, 'USD')) <> 'USD'
             AND COALESCE(charge.fx_rate_to_usd, 0) <= 0
         )::text AS unresolved_fx_charges,
         COUNT(*) FILTER (
           WHERE charge.deleted_at IS NULL
             AND (charge.daybook_entry_id IS NULL OR original_daybook.id IS NULL)
         )::text AS missing_daybook_links,
         COUNT(*) FILTER (
           WHERE charge.deleted_at IS NULL
             AND (charge.ledger_account_id IS NOT NULL OR charge.supplier_id IS NOT NULL)
             AND (charge.voucher_id IS NULL OR voucher.id IS NULL OR voucher.deleted_at IS NOT NULL)
         )::text AS missing_voucher_links,
         COUNT(*) FILTER (
           WHERE charge.deleted_at IS NULL
             AND charge.voucher_id IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM voucher_entries entry
               WHERE entry.voucher_id = charge.voucher_id
                 AND (
                   entry.transaction_currency IS NULL
                   OR entry.transaction_debit_amount IS NULL
                   OR entry.transaction_credit_amount IS NULL
                   OR entry.base_debit_amount IS NULL
                   OR entry.base_credit_amount IS NULL
                   OR entry.historical_exchange_rate IS NULL
                   OR entry.rate_convention IS NULL
                 )
             )
         )::text AS incomplete_voucher_currency_rows,
         COUNT(*) FILTER (
           WHERE charge.deleted_at IS NOT NULL
             AND (charge.daybook_entry_id IS NOT NULL OR charge.voucher_id IS NOT NULL)
             AND (charge.reversal_daybook_entry_id IS NULL OR reversal_daybook.id IS NULL)
         )::text AS missing_reversal_links
       FROM factory_offload_additional_charges charge
       LEFT JOIN vouchers voucher ON voucher.id = charge.voucher_id
       LEFT JOIN factory_daybook_entries original_daybook ON original_daybook.id = charge.daybook_entry_id
       LEFT JOIN factory_daybook_entries reversal_daybook ON reversal_daybook.id = charge.reversal_daybook_entry_id
       WHERE charge.company_id = $1
     ),
     raw_drift AS (
       SELECT
         COUNT(*) FILTER (
           WHERE ABS(COALESCE(raw_stock.cost_per_kg_usd, 0) - COALESCE(container.rate_per_kg_usd, 0)) > 0.000001
         )::text AS raw_stock_cost_drift_rows,
         MAX(ABS(COALESCE(raw_stock.cost_per_kg_usd, 0) - COALESCE(container.rate_per_kg_usd, 0)))::text
           AS max_raw_stock_cost_drift
       FROM factory_raw_stock raw_stock
       JOIN factory_containers container
         ON container.id = raw_stock.container_id
        AND container.company_id = raw_stock.company_id
       WHERE raw_stock.company_id = $1
         AND raw_stock.deleted_at IS NULL
         AND container.deleted_at IS NULL
     )
     SELECT charge_integrity.*, raw_drift.*
     FROM charge_integrity CROSS JOIN raw_drift`,
    [companyId]
  );
  const row = result.rows[0];
  const integrity: PostOffloadPhase6Integrity = {
    activeCharges: count(row?.active_charges),
    deletedCharges: count(row?.deleted_charges),
    unresolvedFxCharges: count(row?.unresolved_fx_charges),
    missingDaybookLinks: count(row?.missing_daybook_links),
    missingVoucherLinks: count(row?.missing_voucher_links),
    incompleteVoucherCurrencyRows: count(row?.incomplete_voucher_currency_rows),
    missingReversalLinks: count(row?.missing_reversal_links),
    rawStockCostDriftRows: count(row?.raw_stock_cost_drift_rows),
    maxRawStockCostDriftUsdPerKg: decimal(row?.max_raw_stock_cost_drift).toFixed(6),
    issueCount: 0,
  };
  integrity.issueCount =
    integrity.unresolvedFxCharges +
    integrity.missingDaybookLinks +
    integrity.missingVoucherLinks +
    integrity.incompleteVoucherCurrencyRows +
    integrity.missingReversalLinks +
    integrity.rawStockCostDriftRows;
  return integrity;
}
async function loadPostOffloadSupplierIds(executor: ReplayQueryExecutor, companyId: number): Promise<number[]> {
  const result = await executor.query<{ supplier_id: number }>(
    `SELECT DISTINCT container.supplier_id
     FROM factory_offload_additional_charges charge
     JOIN factory_containers container
       ON container.id = charge.container_id
      AND container.company_id = charge.company_id
     WHERE charge.company_id = $1
       AND container.supplier_id IS NOT NULL
       AND container.deleted_at IS NULL
     ORDER BY container.supplier_id`,
    [companyId]
  );
  return uniqueSortedNumbers(result.rows.map((row) => Number(row.supplier_id)));
}
async function loadLatestUndo(
  executor: ReplayQueryExecutor,
  companyId: number
): Promise<PostOffloadPhase6Readiness["latestUndo"]> {
  const result = await executor.query<LatestUndoRow>(
    `SELECT id, algorithm_version, scope_fingerprint, applied_at, undone_at
     FROM factory_recalc_undo_log
     WHERE company_id = $1
       AND operation_type = 'HISTORICAL_REPLAY_EXACT'
     ORDER BY applied_at DESC, id DESC
     LIMIT 1`,
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    algorithmVersion: row.algorithm_version,
    scopeFingerprint: row.scope_fingerprint,
    appliedAt: new Date(row.applied_at).toISOString(),
    undoneAt: row.undone_at ? new Date(row.undone_at).toISOString() : null,
  };
}
function buildBlockers(params: {
  control: ReturnType<typeof readHistoricalReplayProductionControl>;
  schema: Awaited<ReturnType<typeof inspectHistoricalReplayProductionSchema>>;
  safety: ReturnType<typeof evaluateHistoricalReplaySafetyReadiness>;
  scope: ReplayWriteScope;
  selectedSupplierIds: number[];
  hasPostOffloadSuppliers: boolean;
  hasHistoricalRepairWork: boolean;
}): string[] {
  const blockers = [
    ...params.schema.missingObjects.map((value) => `schema:${value}`),
    ...(params.hasHistoricalRepairWork
      ? params.control.configurationErrors.map((value) => `production-control:${value}`)
      : []),
    ...(params.hasPostOffloadSuppliers
      ? params.safety.blockers.map((value) => `safety:${value.gate}=${value.count}`)
      : []),
    ...params.scope.blockedBatches.flatMap((batch) =>
      batch.reasons.map((reason) => `batch:${batch.batchId}:${reason}`)
    ),
  ];
  if (params.hasHistoricalRepairWork && params.selectedSupplierIds.length === 0) {
    blockers.push("scope:no-safe-post-offload-suppliers");
  }
  return [...new Set(blockers)].sort();
}
function classifyStatus(params: {
  integrityIssueCount: number;
  actualChangeRows: number;
  blockers: string[];
}): PostOffloadPhase6Status {
  if (params.blockers.length > 0) return "blocked";
  if (params.integrityIssueCount > 0 || params.actualChangeRows > 0) return "repair_required";
  return "ready";
}
async function buildSnapshot(params: { companyId: number; requestedSupplierIds?: unknown }): Promise<Phase6Snapshot> {
  const requestedIds = requestedSupplierIds(params.requestedSupplierIds);
  const control = readHistoricalReplayProductionControl();
  const client = await pool.connect();
  const executor = client as unknown as ReplayQueryExecutor;
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const schema = await inspectHistoricalReplayProductionSchema(executor);
    const integrity = await loadIntegrity(executor, params.companyId);
    const postOffloadSupplierIds = await loadPostOffloadSupplierIds(executor, params.companyId);
    let preview: HistoricalReplayPreviewResult | null = null;
    let scope = emptyScope();
    let safety: ReturnType<typeof evaluateHistoricalReplaySafetyReadiness> = {
      allSafetyGatesPassed: false,
      applicableSupplierCount: 0,
      applicableChangeCount: 0,
      blockers: [{ gate: "schemaNotReady", count: 1 }],
    };
    if (schema.ready) {
      preview = await previewHistoricalCostReplayWithExecutor(executor, params.companyId);
      safety = evaluateHistoricalReplaySafetyReadiness(preview);
      const safePostOffloadIds = preview.supplierRows
        .filter((supplier) => supplier.safeToRepair && postOffloadSupplierIds.includes(supplier.supplierId))
        .map((supplier) => supplier.supplierId);
      const selectedSupplierIds =
        requestedIds.length > 0 ? requestedIds.filter((id) => safePostOffloadIds.includes(id)) : safePostOffloadIds;
      if (selectedSupplierIds.length > 0) {
        const internalScope = await buildHistoricalReplayScopeInternal({
          companyId: params.companyId,
          selectedSupplierIds: new Set(selectedSupplierIds),
          includeCompletedBatches: INCLUDE_COMPLETED_BATCHES,
          includeFinalizedBales: INCLUDE_FINALIZED_BALES,
          executor,
          lockRows: false,
        });
        scope = normalizeReplayWriteScope(internalScope);
        preview = internalScope._fullPreview;
      }
    }
    // Phase 5: include downstream production/GL reconciliation in the
    // preflight, not only the final serializable apply. A report with missing
    // production links must not advertise an automatic-repair token as ready.
    const downstreamSafety = schema.ready
      ? await inspectPhase5ReplayScopeSafety(executor, params.companyId, scope)
      : null;
    if (downstreamSafety && !downstreamSafety.safeToApply) {
      safety = {
        ...safety,
        allSafetyGatesPassed: false,
        blockers: [
          ...safety.blockers,
          { gate: "unreconciledDownstreamCostOrGL", count: downstreamSafety.blockers.length },
        ],
      };
    }

    const selectedSupplierIds = scope.supplierIds;
    const supplierRateChanges = preview
      ? preview.supplierRows.filter(
          (supplier) =>
            selectedSupplierIds.includes(supplier.supplierId) &&
            Math.abs(supplier.endingExpectedRate - supplier.currentStoredRate) > 0.00000001
        ).length
      : 0;
    const counts = scopeCounts(scope, supplierRateChanges);
    const fingerprint =
      preview && selectedSupplierIds.length > 0
        ? computeReplayFingerprint(
            params.companyId,
            selectedSupplierIds,
            preview,
            {
              includeCompletedBatches: INCLUDE_COMPLETED_BATCHES,
              includeFinalizedBales: INCLUDE_FINALIZED_BALES,
            },
            scope
          )
        : null;
    const latestUndo = schema.ready ? await loadLatestUndo(executor, params.companyId) : null;
    const blockers = buildBlockers({
      control,
      schema,
      safety,
      scope,
      selectedSupplierIds,
      hasPostOffloadSuppliers: postOffloadSupplierIds.length > 0,
      hasHistoricalRepairWork: counts.actualChangeRows > 0,
    });
    const automaticRepairEligible =
      historicalReplayAuthorizationReady({ control, schema, safety }) &&
      selectedSupplierIds.length > 0 &&
      counts.actualChangeRows > 0;
    const stateFingerprint = stableHash({
      companyId: params.companyId,
      algorithmVersion: REPLAY_ALGORITHM_VERSION,
      readinessVersion: historicalReplayReadinessVersion(),
      productionReleaseId: control.releaseId,
      integrity,
      selectedSupplierIds,
      scope,
      fingerprint,
      downstreamSafety,
    });
    const status = classifyStatus({
      integrityIssueCount: integrity.issueCount,
      actualChangeRows: counts.actualChangeRows,
      blockers,
    });
    await client.query("COMMIT");
    return {
      preview,
      scope,
      readiness: {
        phase: 6,
        generatedAt: new Date().toISOString(),
        companyId: params.companyId,
        status,
        algorithmVersion: REPLAY_ALGORITHM_VERSION,
        readinessVersion: historicalReplayReadinessVersion(),
        productionControl: {
          enabled: control.enabled,
          releaseId: control.releaseId,
          configurationErrors: control.configurationErrors,
        },
        schema,
        safety,
        integrity,
        postOffloadSupplierIds,
        selectedSupplierIds,
        scope: counts,
        fingerprint,
        stateFingerprint,
        latestUndo,
        automaticRepairEligible,
        blockers,
        reportQueryKeys: POST_OFFLOAD_REPORT_QUERY_KEYS,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
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
