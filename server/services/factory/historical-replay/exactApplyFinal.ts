import Decimal from "decimal.js";
import { pool } from "../../../db";
import {
  REPLAY_ALGORITHM_VERSION,
  StaleTokenError,
  type ReplayApplyParams,
  type ReplayApplyResult,
  type ReplayQueryExecutor,
} from "./types";
import { buildExactHistoricalReplayScopeInternal } from "./exactScope";
import { normalizeReplayWriteScope, replayWriteScopesEqual } from "./selectedScope";
import { computeReplayFingerprint, loadReplayAuthoritativeInputDigest } from "./fingerprint";
import {
  captureExactReplaySnapshot,
  lockExactReplayScopeRows,
  replayBaleIdsForScope,
  type ExactReplaySnapshot,
} from "./exactSnapshot";
import { assertPhase5ReplayScopeSafe } from "./downstreamGatePhase5";
import {
  assertExactReplayNonCostInvariants,
  assertPersistedReplaySourceTotals,
} from "./exactInvariants";

function sortNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function scopeViolation(message: string): Error & { code: string } {
  return Object.assign(
    new Error(`HISTORICAL_REPLAY_SCOPE_VIOLATION: ${message}. Rolling back.`),
    { code: "HISTORICAL_REPLAY_SCOPE_VIOLATION" }
  );
}

function assertOne(rowCount: number | null | undefined, label: string): void {
  if (rowCount !== 1) {
    throw scopeViolation(`expected exactly one ${label} row, updated ${rowCount ?? 0}`);
  }
}

function assertSameIds(expected: number[], actual: number[], label: string): void {
  if (JSON.stringify(sortNumbers(expected)) !== JSON.stringify(sortNumbers(actual))) {
    throw scopeViolation(`${label} rows no longer match the signed scope`);
  }
}

export interface ExactReplayCommitContext {
  before: ExactReplaySnapshot;
  after: ExactReplaySnapshot;
}

export async function applyExactHistoricalCostReplayV6(
  params: ReplayApplyParams & {
    tokenHash?: string;
    onCommit?: (
      client: ReplayQueryExecutor,
      result: ReplayApplyResult,
      snapshots: ExactReplayCommitContext
    ) => Promise<void>;
  }
): Promise<ReplayApplyResult> {
  const {
    companyId,
    supplierIds,
    includeCompletedBatches,
    includeFinalizedBales,
    expectedFingerprint,
    expectedScope,
    algorithmVersion,
    issuedByUserId,
    tokenHash,
    onCommit,
  } = params;

  if (algorithmVersion !== REPLAY_ALGORITHM_VERSION) {
    throw new StaleTokenError(
      `Token algorithm version "${algorithmVersion}" does not match current engine "${REPLAY_ALGORITHM_VERSION}". Re-run Prepare.`
    );
  }
  if (!expectedScope) {
    throw new StaleTokenError("This token has no exact signed scope. Re-run Prepare Historical Replay.");
  }
  if (!tokenHash || !issuedByUserId || !onCommit) {
    throw new StaleTokenError(
      "Historical Replay requires a one-use token plus atomic undo and audit persistence. Re-run Prepare through the protected route."
    );
  }
  if (supplierIds.length === 0) {
    throw new StaleTokenError("Historical Replay cannot apply an empty supplier scope. Re-run Prepare.");
  }

  const result: ReplayApplyResult = {
    suppliersApplied: 0,
    rawStockRowsUpdated: 0,
    sourcesUpdated: 0,
    batchesUpdated: 0,
    balesUpdated: 0,
    supplierRatesUpdated: 0,
    skippedSupplierIds: [],
  };

  const client = await pool.connect();
  const executor = client as unknown as ReplayQueryExecutor;
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [String(companyId)]);
    await client.query(`SELECT pg_advisory_xact_lock(9003, $1)`, [companyId]);

    const scope = await buildExactHistoricalReplayScopeInternal({
      companyId,
      selectedSupplierIds: new Set(supplierIds),
      includeCompletedBatches,
      includeFinalizedBales,
      executor,
      lockRows: true,
    });
    const publicScope = normalizeReplayWriteScope(scope);
    const signedScope = normalizeReplayWriteScope(expectedScope);
    if (!replayWriteScopesEqual(signedScope, publicScope)) {
      throw new StaleTokenError(
        "Stale token — exact supplier/container/raw-stock/source/batch/bale scope changed since Prepare."
      );
    }

    const authoritative = await loadReplayAuthoritativeInputDigest(executor, companyId);
    Object.assign(scope._fullPreview, {
      authoritativeInputDigest: authoritative.digest,
      authoritativeInputCounts: authoritative.counts,
    });
    const freshFingerprint = computeReplayFingerprint(
      companyId,
      supplierIds,
      scope._fullPreview,
      { includeCompletedBatches, includeFinalizedBales },
      publicScope
    );
    if (freshFingerprint !== expectedFingerprint) {
      throw new StaleTokenError(
        "Stale token — authoritative replay inputs changed since Prepare. Re-run the preview."
      );
    }

    result.skippedSupplierIds = supplierIds.filter((id) => !publicScope.supplierIds.includes(id));
    if (publicScope.supplierIds.length === 0) {
      throw new StaleTokenError("No selected supplier remains safe under the locked replay snapshot. Re-run Prepare.");
    }

    // Phase 5: hard fail closed on unlinked consumed mixes, protected sales,
    // and perpetual inventory GL changes with no atomic matching journal.
    // Evaluate under SERIALIZABLE and before token consumption or any write.
    await assertPhase5ReplayScopeSafe(executor, companyId, publicScope);

    const consumed = await client.query(
      `INSERT INTO factory_replay_consumed_tokens
         (token_hash, company_id, user_id, replay_algorithm_version, scope_fingerprint)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_hash) DO NOTHING`,
      [tokenHash, companyId, issuedByUserId, algorithmVersion, expectedFingerprint]
    );
    if (consumed.rowCount !== 1) {
      throw new StaleTokenError(
        "This confirmation token has already been used. Re-run Prepare Historical Replay."
      );
    }

    const approvedSupplierIds = new Set(publicScope.supplierIds);
    const approvedContainerIds = new Set(publicScope.containerIdsToUpdate);
    const approvedRawStockIds = new Set(publicScope.rawStockIdsToUpdate);
    const approvedSourceIds = new Set(publicScope.sourceIdsToUpdate);
    const approvedBatchIds = new Set(publicScope.batchIdsToUpdate);
    const approvedBaleIds = replayBaleIdsForScope(publicScope, includeFinalizedBales);

    await lockExactReplayScopeRows(executor, companyId, publicScope, approvedBaleIds);
    const before = await captureExactReplaySnapshot(executor, companyId, publicScope, approvedBaleIds);
    assertSameIds(publicScope.containerIdsToUpdate, before.containers.map((row) => row.id), "container snapshot");
    assertSameIds(publicScope.rawStockIdsToUpdate, before.rawStockRows.map((row) => row.id), "raw-stock snapshot");
    assertSameIds(publicScope.sourceIdsToUpdate, before.mixBatchSources.map((row) => row.id), "source snapshot");
    assertSameIds(publicScope.batchIdsToUpdate, before.mixBatches.map((row) => row.id), "batch snapshot");
    assertSameIds(approvedBaleIds, before.bales.map((row) => row.id), "bale snapshot");
    assertSameIds(publicScope.supplierIds, before.suppliers.map((row) => row.id), "supplier snapshot");

    for (const rawStockId of publicScope.rawStockIdsToUpdate) {
      if (!approvedRawStockIds.has(rawStockId)) throw scopeViolation(`unapproved raw-stock ${rawStockId}`);
      const containerId = scope._rawStockIdToContainer.get(rawStockId);
      const canonicalRate = containerId == null ? undefined : scope._canonicalRateByContainer.get(containerId);
      if (containerId == null || canonicalRate == null) {
        throw scopeViolation(`raw-stock ${rawStockId} has no approved canonical rate`);
      }
      const update = await client.query(
        `UPDATE factory_raw_stock
         SET cost_per_kg_usd = $1
         WHERE id = $2
           AND company_id = $3
           AND container_id = $4
           AND deleted_at IS NULL`,
        [new Decimal(canonicalRate).toDecimalPlaces(6).toFixed(6), rawStockId, companyId, containerId]
      );
      assertOne(update.rowCount, `raw-stock ${rawStockId}`);
      result.rawStockRowsUpdated += 1;
    }

    for (const containerId of publicScope.containerIdsToUpdate) {
      const canonicalRate = scope._canonicalRateByContainer.get(containerId);
      const canonicalTotalUsd = scope._canonicalTotalUsdByContainer.get(containerId);
      if (
        !approvedContainerIds.has(containerId)
        || canonicalRate == null
        || canonicalTotalUsd == null
      ) {
        throw scopeViolation(`container ${containerId} has no approved canonical result`);
      }
      const update = await client.query(
        `UPDATE factory_containers
         SET rate_per_kg_usd = $1,
             final_payable_amount_usd = $2,
             updated_at = NOW()
         WHERE id = $3
           AND company_id = $4
           AND supplier_id = ANY($5)
           AND deleted_at IS NULL`,
        [
          new Decimal(canonicalRate).toDecimalPlaces(6).toFixed(6),
          new Decimal(canonicalTotalUsd).toDecimalPlaces(6).toFixed(6),
          containerId,
          companyId,
          sortNumbers([...approvedSupplierIds]),
        ]
      );
      assertOne(update.rowCount, `container ${containerId}`);
    }

    const sourceCorrections = scope._sourceCorrections ?? new Map();
    for (const sourceId of publicScope.sourceIdsToUpdate) {
      const correction = sourceCorrections.get(sourceId);
      if (!approvedSourceIds.has(sourceId) || !correction || !approvedBatchIds.has(correction.batchId)) {
        throw scopeViolation(`source ${sourceId} has no approved correction`);
      }
      const update = await client.query(
        `UPDATE factory_mix_batch_sources mbs
         SET cost_per_kg = $1,
             total_cost = $2
         FROM factory_mix_batches mb
         WHERE mbs.id = $3
           AND mbs.mix_batch_id = $4
           AND mb.id = mbs.mix_batch_id
           AND mb.company_id = $5`,
        [
          new Decimal(correction.expectedCostPerKg).toDecimalPlaces(6).toFixed(6),
          new Decimal(correction.expectedTotalCost).toDecimalPlaces(6).toFixed(6),
          sourceId,
          correction.batchId,
          companyId,
        ]
      );
      assertOne(update.rowCount, `source ${sourceId}`);
      result.sourcesUpdated += 1;
    }

    const correctionByBatchId = new Map(
      scope._batchCorrections.map((correction) => [correction.batchId, correction])
    );
    for (const batchId of publicScope.batchIdsToUpdate) {
      const correction = correctionByBatchId.get(batchId);
      if (!approvedBatchIds.has(batchId) || !correction) {
        throw scopeViolation(`batch ${batchId} has no approved correction`);
      }
      const update = await client.query(
        `UPDATE factory_mix_batches
         SET cost_per_kg = $1,
             total_cost = $2,
             updated_at = NOW()
         WHERE id = $3
           AND company_id = $4
           AND deleted_at IS NULL`,
        [
          new Decimal(correction.expectedCostPerKg).toDecimalPlaces(6).toFixed(6),
          new Decimal(correction.expectedTotalCost).toDecimalPlaces(6).toFixed(6),
          batchId,
          companyId,
        ]
      );
      assertOne(update.rowCount, `batch ${batchId}`);
      result.batchesUpdated += 1;
    }

    if (approvedBaleIds.length > 0) {
      const baleRows = await client.query<{
        id: number;
        mix_batch_id: number | null;
        weight_kg: string;
      }>(
        `SELECT id, mix_batch_id, weight_kg
         FROM factory_bales
         WHERE id = ANY($1)
           AND company_id = $2
           AND deleted_at IS NULL
         ORDER BY id`,
        [approvedBaleIds, companyId]
      );
      assertSameIds(approvedBaleIds, baleRows.rows.map((row) => row.id), "approved bale");

      for (const bale of baleRows.rows) {
        if (bale.mix_batch_id == null || !approvedBatchIds.has(bale.mix_batch_id)) {
          throw scopeViolation(`bale ${bale.id} no longer belongs to an approved batch`);
        }
        const correction = correctionByBatchId.get(bale.mix_batch_id);
        if (!correction) throw scopeViolation(`missing correction for bale ${bale.id}`);
        const cost = new Decimal(correction.expectedCostPerKg);
        const update = await client.query(
          `UPDATE factory_bales
           SET cost_per_kg = $1,
               total_cost = $2,
               updated_at = NOW()
           WHERE id = $3
             AND company_id = $4
             AND mix_batch_id = $5
             AND deleted_at IS NULL`,
          [
            cost.toDecimalPlaces(6).toFixed(6),
            new Decimal(bale.weight_kg || "0").times(cost).toDecimalPlaces(6).toFixed(6),
            bale.id,
            companyId,
            bale.mix_batch_id,
          ]
        );
        assertOne(update.rowCount, `bale ${bale.id}`);
        result.balesUpdated += 1;
      }
    }

    const supplierById = new Map(
      scope._safeSupplierRows.map((supplier) => [supplier.supplierId, supplier])
    );
    for (const supplierId of publicScope.supplierIds) {
      const supplier = supplierById.get(supplierId);
      if (!approvedSupplierIds.has(supplierId) || !supplier) {
        throw scopeViolation(`supplier ${supplierId} has no approved replay result`);
      }

      // Always persist the exact replay result — even a zero ending rate is a valid
      // approved outcome (supplier's stock is fully consumed). Only negative rates
      // indicate a calculation error.
      const expectedRate = new Decimal(supplier.endingExpectedRate).toDecimalPlaces(8);
      if (expectedRate.lt(0)) {
        throw scopeViolation(`supplier ${supplierId} produced a negative replay rate`);
      }
      const update = await client.query(
        `UPDATE factory_suppliers
         SET current_raw_material_cost_per_kg_usd = $1,
             updated_at = NOW()
         WHERE id = $2 AND company_id = $3`,
        [expectedRate.toFixed(8), supplierId, companyId]
      );
      assertOne(update.rowCount, `supplier ${supplierId}`);
      result.supplierRatesUpdated += 1;
      result.suppliersApplied += 1;
    }

    const after = await captureExactReplaySnapshot(executor, companyId, publicScope, approvedBaleIds);
    assertExactReplayNonCostInvariants(before, after);
    await assertPersistedReplaySourceTotals(executor, companyId, publicScope);

    await onCommit(executor, result, { before, after });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return result;
}
