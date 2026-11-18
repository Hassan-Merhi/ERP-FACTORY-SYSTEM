// Extracted from ./postOffloadPhase6SafetyImpl.ts to keep that module under the source-size cap.
import { pool } from "../../db";
import {
  buildHistoricalReplayScopeInternal,
  computeReplayFingerprint,
  type HistoricalReplayPreviewResult,
  normalizeReplayWriteScope,
  previewHistoricalCostReplayWithExecutor,
  REPLAY_ALGORITHM_VERSION,
  type ReplayQueryExecutor,
  type ReplayWriteScope,
} from "./historicalCostReplay";
import {
  evaluateHistoricalReplaySafetyReadiness,
  historicalReplayAuthorizationReady,
  historicalReplayReadinessVersion,
  inspectHistoricalReplayProductionSchema,
  readHistoricalReplayProductionControl,
} from "./historical-replay/productionReadinessV8";
import { POST_OFFLOAD_REPORT_QUERY_KEYS } from "./postOffloadReconciliation";
import { inspectPhase5ReplayScopeSafety } from "./historical-replay/downstreamGatePhase5";
import {
  INCLUDE_COMPLETED_BATCHES,
  INCLUDE_FINALIZED_BALES,
  count,
  decimal,
  emptyScope,
  requestedSupplierIds,
  scopeCounts,
  stableHash,
  uniqueSortedNumbers,
  type IntegrityRow,
  type LatestUndoRow,
  type Phase6Snapshot,
  type PostOffloadPhase6Integrity,
  type PostOffloadPhase6Readiness,
  type PostOffloadPhase6Status,
} from "./postOffloadPhase6SafetyImplParseReplayScope";

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

export async function buildSnapshot(params: {
  companyId: number;
  requestedSupplierIds?: unknown;
}): Promise<Phase6Snapshot> {
  const requestedIds = requestedSupplierIds(params.requestedSupplierIds);
  const control = readHistoricalReplayProductionControl();
  const client = await pool.connect();
  const executor = client as unknown as ReplayQueryExecutor;
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(params.companyId)]);
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
