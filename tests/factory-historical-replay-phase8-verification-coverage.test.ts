/**
 * GET /api/factory/raw-stock/recalc/historical-replay/verification
 * (server/routes/factory/raw-stock/historicalReplayPhase8VerificationRoutes.ts).
 *
 * Read-only exact verification of the latest (or a named) exact replay undo
 * record against the live rows. Each refusal is pinned with its code, and the
 * route never changes costs.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import {
  REPLAYED_COSTS,
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
  type ReplayQueryExecutor,
} from "../server/services/factory/historicalCostReplay";

const URL = "/api/factory/raw-stock/recalc/historical-replay/verification";

/** Apply the stale supplier's replay and store the exact undo envelope like the V4 apply route. */
async function appliedReplay(w: FactoryWorld): Promise<{ seeded: StaleReplayWorld; undoLogId: number }> {
  const seeded = await seedStaleReplaySupplier(w.client, w.companyId);
  const executor = w.client as unknown as ReplayQueryExecutor;
  const internal = await buildHistoricalReplayScopeInternal({
    companyId: w.companyId,
    selectedSupplierIds: new Set([seeded.supplierId]),
    includeCompletedBatches: false,
    includeFinalizedBales: false,
    executor,
    lockRows: false,
  });
  const scope = normalizeReplayWriteScope(internal);
  const options = { includeCompletedBatches: false, includeFinalizedBales: false };
  const fingerprint = computeReplayFingerprint(w.companyId, scope.supplierIds, internal._fullPreview, options, scope);
  let undoLogId = 0;
  await applyHistoricalCostReplay({
    companyId: w.companyId,
    supplierIds: scope.supplierIds,
    ...options,
    expectedFingerprint: fingerprint,
    expectedScope: scope,
    algorithmVersion: REPLAY_ALGORITHM_VERSION,
    issuedByUserId: w.userId,
    tokenHash: `verify-${w.tag}`,
    onCommit: async (client, _result, snapshots) => {
      const envelope = {
        kind: "HISTORICAL_REPLAY_EXACT_V1",
        algorithmVersion: REPLAY_ALGORITHM_VERSION,
        fingerprint,
        ...options,
        scope,
        baleIds: [seeded.baleId],
        before: snapshots.before,
        after: snapshots.after,
      };
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO factory_recalc_undo_log (company_id, description, snapshot, operation_type, algorithm_version, scope_fingerprint)
         VALUES ($1, 'verification test', $2, 'HISTORICAL_REPLAY_EXACT', $3, $4) RETURNING id`,
        [w.companyId, JSON.stringify(envelope), REPLAY_ALGORITHM_VERSION, fingerprint]
      );
      undoLogId = Number(inserted.rows[0].id);
    },
  });
  expect(await readStaleReplayCosts(w.client, seeded)).toEqual(REPLAYED_COSTS);
  return { seeded, undoLogId };
}

const rawLog = (w: FactoryWorld, snapshot: unknown, version = REPLAY_ALGORITHM_VERSION, fingerprint = "fp") =>
  w.one(
    `INSERT INTO factory_recalc_undo_log (company_id, description, snapshot, operation_type, algorithm_version, scope_fingerprint)
     VALUES ($1, 'raw', $2, 'HISTORICAL_REPLAY_EXACT', $3, $4) RETURNING id`,
    [w.companyId, JSON.stringify(snapshot), version, fingerprint]
  );

const goodScope = {
  supplierIds: [1],
  containerIdsToUpdate: [],
  rawStockIdsToUpdate: [],
  sourceIdsToUpdate: [],
  batchIdsToUpdate: [],
  availableBaleIdsToUpdate: [],
  finalizedBaleIdsToUpdate: [],
  blockedBatches: [{ batchId: 5, batchCode: "B5", reasons: ["b", "a", "a"] }],
};
const goodEnvelope = {
  kind: "HISTORICAL_REPLAY_EXACT_V1",
  algorithmVersion: REPLAY_ALGORITHM_VERSION,
  fingerprint: "fp",
  scope: goodScope,
  baleIds: [],
  before: {},
  after: {},
};

describe("historical replay verification refusals", () => {
  it("rejects a bad undoLogId, a missing record and a non-admin caller", async () => {
    await withFactoryWorld(async (w) => {
      for (const bad of ["0", "-3", "abc"]) {
        const res = await w.agent.get(URL).query({ undoLogId: bad });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("HISTORICAL_REPLAY_VERIFICATION_ID_INVALID");
      }
      const none = await w.agent.get(URL);
      expect(none.status).toBe(404);
      expect(none.body.code).toBe("HISTORICAL_REPLAY_VERIFICATION_NOT_FOUND");
      const missing = await w.agent.get(URL).query({ undoLogId: "2000000000" });
      expect(missing.status).toBe(404);

      const viewer = await w.agentFor("Manager");
      const denied = await viewer.get(URL);
      expect(denied.status).toBe(403);
    });
  });

  it("refuses malformed envelopes and scopes", async () => {
    await withFactoryWorld(async (w) => {
      const malformed: unknown[] = [
        "not-an-object",
        { ...goodEnvelope, kind: "OTHER" },
        { ...goodEnvelope, scope: null },
        { ...goodEnvelope, baleIds: [0] },
        { ...goodEnvelope, before: null },
        { ...goodEnvelope, after: "x" },
        { ...goodEnvelope, scope: { ...goodScope, supplierIds: "1" } },
        { ...goodEnvelope, scope: { ...goodScope, blockedBatches: "none" } },
        { ...goodEnvelope, scope: { ...goodScope, blockedBatches: [null] } },
        { ...goodEnvelope, scope: { ...goodScope, blockedBatches: [{ batchId: 0, batchCode: "B", reasons: [] }] } },
        { ...goodEnvelope, scope: { ...goodScope, blockedBatches: [{ batchId: 1, batchCode: 2, reasons: [] }] } },
        { ...goodEnvelope, scope: { ...goodScope, blockedBatches: [{ batchId: 1, batchCode: "B", reasons: [1] }] } },
      ];
      for (const snapshot of malformed) {
        const id = await rawLog(w, snapshot);
        const res = await w.agent.get(URL).query({ undoLogId: String(id) });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("HISTORICAL_REPLAY_VERIFICATION_SNAPSHOT_INVALID");
      }
    });
  });

  it("refuses a record from another algorithm or with a different fingerprint", async () => {
    await withFactoryWorld(async (w) => {
      const oldVersion = await rawLog(w, goodEnvelope, "V1");
      const otherPrint = await rawLog(w, goodEnvelope, REPLAY_ALGORITHM_VERSION, "other");
      const envelopeVersion = await rawLog(w, { ...goodEnvelope, algorithmVersion: "V1" });
      for (const id of [oldVersion, otherPrint, envelopeVersion]) {
        const res = await w.agent.get(URL).query({ undoLogId: String(id) });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe("HISTORICAL_REPLAY_VERIFICATION_VERSION_MISMATCH");
      }
    });
  });
});

describe("historical replay verification against live rows", () => {
  it("verifies the latest applied replay and reports a 409 once the costs drift", async () => {
    await withFactoryWorld(async (w) => {
      const { seeded, undoLogId } = await appliedReplay(w);
      const ok = await w.agent.get(URL);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        verified: true,
        readOnly: true,
        undoLogId,
        state: "APPLIED",
        algorithmVersion: REPLAY_ALGORITHM_VERSION,
        counts: { bales: 1, suppliers: 1 },
      });
      const named = await w.agent.get(URL).query({ undoLogId: String(undoLogId) });
      expect(named.status).toBe(200);

      await w.q(`UPDATE factory_bales SET cost_per_kg = cost_per_kg + 1 WHERE id = $1`, [seeded.baleId]);
      const drift = await w.agent.get(URL);
      expect(drift.status).toBe(409);
      expect(drift.body).toMatchObject({ verified: false, readOnly: true });
      expect(["HISTORICAL_REPLAY_UNDO_STALE", "HISTORICAL_REPLAY_INVARIANT_VIOLATION"]).toContain(drift.body.code);
    });
  });

  it("compares an undone record with the pre-apply snapshot", async () => {
    await withFactoryWorld(async (w) => {
      const { undoLogId } = await appliedReplay(w);
      await w.q(`UPDATE factory_recalc_undo_log SET undone_at = NOW() WHERE id = $1`, [undoLogId]);
      // The live rows still hold the replayed costs, so they do not match "before".
      const res = await w.agent.get(URL);
      expect(res.status).toBe(409);
      expect(res.body.verified).toBe(false);
    });
  });
});
