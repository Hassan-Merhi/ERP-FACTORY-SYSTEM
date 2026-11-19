import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { seedStaleReplaySupplier, type StaleReplayOptions } from "./helpers/historicalReplayFixture";
import { buildExactHistoricalReplayScopeInternalV6 } from "../server/services/factory/historical-replay/exactScopeV6";
import {
  buildHistoricalReplayScope,
  buildHistoricalReplayScopeInternal as buildLegacySelectedScopeInternal,
  computeReplayFingerprint as computeSelectedFingerprint,
  computeReplayWriteScope,
} from "../server/services/factory/historical-replay/selectedScope";
import type { ReplayQueryExecutor } from "../server/services/factory/historicalCostReplay";

let seq = 0;

async function world(client: PoolClient, options: StaleReplayOptions = {}) {
  const code = `HRSB${process.pid}${++seq}`.slice(0, 18);
  const companyId = Number(
    (
      await client.query(
        `INSERT INTO companies (code, name, company_type, base_currency)
         VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [code]
      )
    ).rows[0].id
  );
  const seeded = await seedStaleReplaySupplier(client, companyId, options);
  return { companyId, seeded, executor: client as unknown as ReplayQueryExecutor };
}

/** A downstream batch fed only by the seeded batch (BATCH-priced source). */
async function addDownstreamBatch(client: PoolClient, companyId: number, upstreamBatchId: number) {
  const batchId = Number(
    (
      await client.query(
        `INSERT INTO factory_mix_batches
           (company_id, batch_code, batch_number, status, total_weight_kg, cost_per_kg, total_cost, batch_date)
         VALUES ($1, $2::text, $2::text, 'OPEN', 10, 1, 10, '2026-01-06') RETURNING id`,
        [companyId, `DS${upstreamBatchId}`]
      )
    ).rows[0].id
  );
  await client.query(
    `INSERT INTO factory_mix_batch_sources (mix_batch_id, source_batch_id, weight_kg, cost_per_kg, total_cost)
     VALUES ($1, $2, 10, 1, 10)`,
    [batchId, upstreamBatchId]
  );
  return batchId;
}

const options = (includeCompletedBatches: boolean, includeFinalizedBales: boolean) => ({
  includeCompletedBatches,
  includeFinalizedBales,
});

describe("exact replay scope V6", () => {
  it("returns an empty scope for no suppliers and for suppliers that are not safe in the preview", async () => {
    await withRolledBackPool(async (client) => {
      const { companyId, seeded, executor } = await world(client);
      const none = await buildExactHistoricalReplayScopeInternalV6({
        companyId,
        selectedSupplierIds: new Set(),
        ...options(false, false),
        executor,
      });
      expect(none.supplierIds).toEqual([]);
      expect(none.containerIdsToUpdate).toEqual([]);

      const ghost = await buildExactHistoricalReplayScopeInternalV6({
        companyId,
        selectedSupplierIds: new Set([seeded.supplierId + 100000]),
        ...options(false, false),
        executor,
        lockRows: true,
      });
      expect(ghost.supplierIds).toEqual([]);
      expect(ghost._fullPreview.supplierRows.map((row) => row.supplierId)).toEqual([seeded.supplierId]);
    });
  });

  it("locks and returns every stale row for an open batch", async () => {
    await withRolledBackPool(async (client) => {
      const { companyId, seeded, executor } = await world(client);
      const scope = await buildExactHistoricalReplayScopeInternalV6({
        companyId,
        selectedSupplierIds: new Set([seeded.supplierId]),
        ...options(false, false),
        executor,
        lockRows: true,
      });
      expect(scope).toMatchObject({
        supplierIds: [seeded.supplierId],
        containerIdsToUpdate: [seeded.containerId],
        rawStockIdsToUpdate: [seeded.rawStockId],
        sourceIdsToUpdate: [seeded.sourceId],
        batchIdsToUpdate: [seeded.batchId],
        availableBaleIdsToUpdate: [seeded.baleId],
        finalizedBaleIdsToUpdate: [],
        blockedBatches: [],
      });
      expect(scope._rawStockIdToContainer.get(seeded.rawStockId)).toBe(seeded.containerId);
      expect(scope._canonicalRateByContainer.get(seeded.containerId)).toBe(2);
    });
  });

  it("blocks a completed batch and its downstream consumers unless completed batches are included", async () => {
    await withRolledBackPool(async (client) => {
      const { companyId, seeded, executor } = await world(client, { batchStatus: "COMPLETED" });
      const downstreamId = await addDownstreamBatch(client, companyId, seeded.batchId);
      const excluded = await buildExactHistoricalReplayScopeInternalV6({
        companyId,
        selectedSupplierIds: new Set([seeded.supplierId]),
        ...options(false, false),
        executor,
        lockRows: true,
      });
      expect(excluded.batchIdsToUpdate).toEqual([]);
      expect(excluded.sourceIdsToUpdate).toEqual([]);
      expect(excluded.availableBaleIdsToUpdate).toEqual([]);
      expect(excluded.containerIdsToUpdate).toEqual([seeded.containerId]);
      expect(excluded.blockedBatches).toEqual([
        {
          batchId: seeded.batchId,
          batchCode: `RB${seeded.supplierId}`,
          reasons: ["COMPLETED_BATCH_REQUIRES_INCLUDE_COMPLETED"],
        },
        { batchId: downstreamId, batchCode: `DS${seeded.batchId}`, reasons: ["UPSTREAM_COMPLETED_BATCH_EXCLUDED"] },
      ]);

      const included = await buildExactHistoricalReplayScopeInternalV6({
        companyId,
        selectedSupplierIds: new Set([seeded.supplierId]),
        ...options(true, false),
        executor,
        lockRows: true,
      });
      expect(included.batchIdsToUpdate).toEqual([seeded.batchId, downstreamId]);
      expect(included.blockedBatches).toEqual([]);
    });
  });

  it("separates finalized bales and locks them only when finalized bales are included", async () => {
    await withRolledBackPool(async (client) => {
      const { companyId, seeded, executor } = await world(client, { baleStatus: "SOLD" });
      for (const includeFinalizedBales of [false, true]) {
        const scope = await buildExactHistoricalReplayScopeInternalV6({
          companyId,
          selectedSupplierIds: new Set([seeded.supplierId]),
          ...options(false, includeFinalizedBales),
          executor,
          lockRows: true,
        });
        expect(scope.availableBaleIdsToUpdate).toEqual([]);
        expect(scope.finalizedBaleIdsToUpdate).toEqual([seeded.baleId]);
      }
    });
  });
});

describe("legacy selected replay scope", () => {
  it("returns empty scopes for no supplier and for an unknown supplier", async () => {
    await withRolledBackPool(async (client) => {
      const { companyId, seeded, executor } = await world(client);
      const none = await buildLegacySelectedScopeInternal({
        companyId,
        selectedSupplierIds: new Set(),
        ...options(false, false),
        executor,
      });
      expect(none.supplierIds).toEqual([]);
      const ghost = await buildHistoricalReplayScope({
        companyId,
        selectedSupplierIds: new Set([seeded.supplierId + 100000]),
        ...options(false, false),
        executor,
      });
      expect(ghost.batchIdsToUpdate).toEqual([]);
    });
  });

  it("excludes a completed batch and locks only the container and raw-stock rows", async () => {
    await withRolledBackPool(async (client) => {
      const { companyId, seeded, executor } = await world(client, { batchStatus: "COMPLETED" });
      const scope = await buildLegacySelectedScopeInternal({
        companyId,
        selectedSupplierIds: new Set([seeded.supplierId]),
        ...options(false, false),
        executor,
        lockRows: true,
      });
      expect(scope).toMatchObject({
        supplierIds: [seeded.supplierId],
        containerIdsToUpdate: [seeded.containerId],
        rawStockIdsToUpdate: [seeded.rawStockId],
        sourceIdsToUpdate: [],
        batchIdsToUpdate: [],
        availableBaleIdsToUpdate: [],
        finalizedBaleIdsToUpdate: [],
      });
      const summary = await computeReplayWriteScope(
        companyId,
        [seeded.supplierId],
        scope._fullPreview,
        options(false, false),
        executor
      );
      expect([...summary.safeSupplierIds]).toEqual([seeded.supplierId]);
      expect([...summary.containerIds]).toEqual([seeded.containerId]);
      expect(summary.baleCount).toBe(0);
    });
  });

  it("fingerprints the preview rows with or without an explicit signed scope", async () => {
    await withRolledBackPool(async (client) => {
      const { companyId, seeded, executor } = await world(client);
      const internal = await buildExactHistoricalReplayScopeInternalV6({
        companyId,
        selectedSupplierIds: new Set([seeded.supplierId]),
        ...options(false, false),
        executor,
      });
      const opts = options(false, false);
      const implicit = computeSelectedFingerprint(companyId, [seeded.supplierId], internal._fullPreview, opts);
      expect(implicit).toMatch(/^[0-9a-f]{64}$/);
      expect(computeSelectedFingerprint(companyId, [seeded.supplierId], internal._fullPreview, opts)).toBe(implicit);
      const scoped = computeSelectedFingerprint(companyId, [seeded.supplierId], internal._fullPreview, opts, internal);
      expect(scoped).not.toBe(implicit);
      expect(computeSelectedFingerprint(companyId, [], internal._fullPreview, opts)).not.toBe(implicit);
    });
  });

  // Known bug, pinned: the legacy bale query reads factory_bales.dispatch_batch_id,
  // a column the schema does not have, so any legacy scope with a batch to update
  // fails. Only the exact (V7) builder is wired into Prepare/Apply today.
  it("fails on the missing dispatch_batch_id column once a batch needs updating", async () => {
    await withRolledBackPool(async (client) => {
      const { companyId, seeded, executor } = await world(client);
      await client.query("SAVEPOINT legacy_scope");
      await expect(
        buildLegacySelectedScopeInternal({
          companyId,
          selectedSupplierIds: new Set([seeded.supplierId]),
          ...options(true, true),
          executor,
          lockRows: true,
        })
      ).rejects.toThrow(/dispatch_batch_id/);
      await client.query("ROLLBACK TO SAVEPOINT legacy_scope");
    });
  });
});
