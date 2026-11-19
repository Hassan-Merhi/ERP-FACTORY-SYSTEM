import { describe, expect, it, vi } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import {
  REPLAYED_COSTS,
  STALE_COSTS,
  readStaleReplayCosts,
  seedStaleReplaySupplier,
  type StaleReplayWorld,
} from "./helpers/historicalReplayFixture";
import {
  applyHistoricalCostReplay,
  buildHistoricalReplayScopeInternal,
  computeReplayFingerprint,
  normalizeReplayWriteScope,
  REPLAY_ALGORITHM_VERSION,
  StaleTokenError,
  type ReplayQueryExecutor,
  type ReplayWriteScope,
} from "../server/services/factory/historicalCostReplay";

async function prepare(world: FactoryWorld, supplierIds: number[]) {
  const executor = world.client as unknown as ReplayQueryExecutor;
  const internal = await buildHistoricalReplayScopeInternal({
    companyId: world.companyId,
    selectedSupplierIds: new Set(supplierIds),
    includeCompletedBatches: false,
    includeFinalizedBales: false,
    executor,
    lockRows: false,
  });
  const scope = normalizeReplayWriteScope(internal);
  const fingerprint = computeReplayFingerprint(
    world.companyId,
    scope.supplierIds,
    internal._fullPreview,
    { includeCompletedBatches: false, includeFinalizedBales: false },
    scope
  );
  return { scope, fingerprint };
}

function applyParams(
  world: FactoryWorld,
  prepared: { scope: ReplayWriteScope; fingerprint: string },
  overrides: Record<string, unknown> = {}
) {
  return {
    companyId: world.companyId,
    supplierIds: prepared.scope.supplierIds,
    includeCompletedBatches: false,
    includeFinalizedBales: false,
    expectedFingerprint: prepared.fingerprint,
    expectedScope: prepared.scope,
    algorithmVersion: REPLAY_ALGORITHM_VERSION,
    issuedByUserId: world.userId,
    tokenHash: `hash-${world.tag}`,
    onCommit: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function consumedTokens(world: FactoryWorld) {
  const rows = await world.q(`SELECT token_hash FROM factory_replay_consumed_tokens WHERE company_id = $1`, [
    world.companyId,
  ]);
  return rows.map((row) => row.token_hash);
}

async function withStaleSupplier(work: (world: FactoryWorld, seeded: StaleReplayWorld) => Promise<void>) {
  await withFactoryWorld(async (world) => {
    const seeded = await seedStaleReplaySupplier(world.client, world.companyId);
    await work(world, seeded);
  });
}

describe("exact historical replay apply: token preconditions", () => {
  const base = {
    companyId: 1,
    supplierIds: [1],
    includeCompletedBatches: false,
    includeFinalizedBales: false,
    expectedFingerprint: "f",
    algorithmVersion: REPLAY_ALGORITHM_VERSION,
    issuedByUserId: "u",
    tokenHash: "h",
    onCommit: async () => undefined,
  };
  const scope: ReplayWriteScope = {
    supplierIds: [1],
    containerIdsToUpdate: [],
    rawStockIdsToUpdate: [],
    sourceIdsToUpdate: [],
    batchIdsToUpdate: [],
    availableBaleIdsToUpdate: [],
    finalizedBaleIdsToUpdate: [],
    blockedBatches: [],
  };

  it("refuses tokens from another engine version, without a signed scope, without audit hooks or with no suppliers", async () => {
    await expect(applyHistoricalCostReplay({ ...base, expectedScope: scope, algorithmVersion: "V1" })).rejects.toThrow(
      /does not match current engine/
    );
    await expect(applyHistoricalCostReplay({ ...base })).rejects.toThrow(/no exact signed scope/);
    await expect(applyHistoricalCostReplay({ ...base, expectedScope: scope, tokenHash: undefined })).rejects.toThrow(
      /one-use token plus atomic undo/
    );
    await expect(applyHistoricalCostReplay({ ...base, expectedScope: scope, onCommit: undefined })).rejects.toThrow(
      StaleTokenError
    );
    await expect(applyHistoricalCostReplay({ ...base, expectedScope: scope, supplierIds: [] })).rejects.toThrow(
      /empty supplier scope/
    );
  });
});

describe("exact historical replay apply against a stale supplier", () => {
  it("prepares one row of every kind and applies the replayed costs with an atomic commit hook", async () => {
    await withStaleSupplier(async (world, seeded) => {
      const prepared = await prepare(world, [seeded.supplierId]);
      expect(prepared.scope).toMatchObject({
        supplierIds: [seeded.supplierId],
        containerIdsToUpdate: [seeded.containerId],
        rawStockIdsToUpdate: [seeded.rawStockId],
        sourceIdsToUpdate: [seeded.sourceId],
        batchIdsToUpdate: [seeded.batchId],
        availableBaleIdsToUpdate: [seeded.baleId],
        blockedBatches: [],
      });

      const params = applyParams(world, prepared);
      const result = await applyHistoricalCostReplay(params);
      expect(result).toEqual({
        suppliersApplied: 1,
        rawStockRowsUpdated: 1,
        sourcesUpdated: 1,
        batchesUpdated: 1,
        balesUpdated: 1,
        supplierRatesUpdated: 1,
        skippedSupplierIds: [],
      });
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(REPLAYED_COSTS);
      expect(params.onCommit).toHaveBeenCalledTimes(1);
      const [, , snapshots] = params.onCommit.mock.calls[0] as unknown as [
        unknown,
        unknown,
        { before: { bales: unknown[] }; after: { bales: unknown[] } },
      ];
      expect(snapshots.before.bales).toHaveLength(1);
      expect(snapshots.after.bales).toHaveLength(1);
      expect(await consumedTokens(world)).toEqual([params.tokenHash]);
    });
  });

  it("applies a scope with no bales to rewrite", async () => {
    await withFactoryWorld(async (world) => {
      const seeded = await seedStaleReplaySupplier(world.client, world.companyId, { withoutBale: true });
      const prepared = await prepare(world, [seeded.supplierId]);
      expect(prepared.scope.availableBaleIdsToUpdate).toEqual([]);
      const result = await applyHistoricalCostReplay(applyParams(world, prepared));
      expect(result).toMatchObject({ batchesUpdated: 1, balesUpdated: 0, suppliersApplied: 1 });
      const [batch] = await world.q(`SELECT total_cost::float AS total FROM factory_mix_batches WHERE id = $1`, [
        seeded.batchId,
      ]);
      expect(batch.total).toBe(80);
    });
  });

  it("rolls back every cost write and the consumed token when the commit hook fails", async () => {
    await withStaleSupplier(async (world, seeded) => {
      const prepared = await prepare(world, [seeded.supplierId]);
      const params = applyParams(world, prepared, {
        onCommit: async () => {
          throw new Error("audit insert failed");
        },
      });
      await expect(applyHistoricalCostReplay(params)).rejects.toThrow("audit insert failed");
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(STALE_COSTS);
      expect(await consumedTokens(world)).toEqual([]);
    });
  });

  it("refuses a signed scope that no longer matches the locked scope", async () => {
    await withStaleSupplier(async (world, seeded) => {
      const prepared = await prepare(world, [seeded.supplierId]);
      const tampered = { ...prepared, scope: { ...prepared.scope, availableBaleIdsToUpdate: [] } };
      await expect(applyHistoricalCostReplay(applyParams(world, tampered))).rejects.toThrow(
        /scope changed since Prepare/
      );
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(STALE_COSTS);
    });
  });

  it("refuses a stale fingerprint after authoritative inputs change", async () => {
    await withStaleSupplier(async (world, seeded) => {
      const prepared = await prepare(world, [seeded.supplierId]);
      await expect(
        applyHistoricalCostReplay(applyParams(world, { ...prepared, fingerprint: "0".repeat(64) }))
      ).rejects.toThrow(/authoritative replay inputs changed/);
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(STALE_COSTS);
      expect(await consumedTokens(world)).toEqual([]);
    });
  });

  it("refuses to reuse a confirmation token that was already consumed", async () => {
    await withStaleSupplier(async (world, seeded) => {
      const prepared = await prepare(world, [seeded.supplierId]);
      const params = applyParams(world, prepared);
      await world.q(
        `INSERT INTO factory_replay_consumed_tokens
           (token_hash, company_id, user_id, replay_algorithm_version, scope_fingerprint)
         VALUES ($1, $2, $3, $4, $5)`,
        [params.tokenHash, world.companyId, world.userId, REPLAY_ALGORITHM_VERSION, prepared.fingerprint]
      );
      await expect(applyHistoricalCostReplay(params)).rejects.toThrow(/already been used/);
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(STALE_COSTS);
      expect(params.onCommit).not.toHaveBeenCalled();
    });
  });

  it("refuses when an active perpetual-inventory cutover would need a GL revaluation", async () => {
    await withStaleSupplier(async (world, seeded) => {
      const prepared = await prepare(world, [seeded.supplierId]);
      await world.q(
        `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, status)
         VALUES ($1, CURRENT_DATE - 1, '{}'::jsonb, 'ACTIVE')`,
        [world.companyId]
      );
      const error = await applyHistoricalCostReplay(applyParams(world, prepared)).catch((caught) => caught);
      expect(error).toMatchObject({ code: "HISTORICAL_REPLAY_DOWNSTREAM_UNRECONCILED" });
      expect(error.message).toMatch(/perpetual-inventory cutover/);
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(STALE_COSTS);
      expect(await consumedTokens(world)).toEqual([]);
    });
  });

  it("rolls back when an apply names a supplier outside the safe connected scope", async () => {
    await withStaleSupplier(async (world, seeded) => {
      const prepared = await prepare(world, [seeded.supplierId]);
      const ghostSupplierId = seeded.supplierId + 100000;
      const error = await applyHistoricalCostReplay(
        applyParams(world, prepared, { supplierIds: [seeded.supplierId, ghostSupplierId] })
      ).catch((caught) => caught);
      expect(error).toMatchObject({ code: "HISTORICAL_REPLAY_SCOPE_VIOLATION" });
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(STALE_COSTS);
      expect(await consumedTokens(world)).toEqual([]);
    });
  });
});
