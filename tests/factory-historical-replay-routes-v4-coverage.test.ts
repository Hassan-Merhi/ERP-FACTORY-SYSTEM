import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import {
  REPLAYED_COSTS,
  STALE_COSTS,
  readStaleReplayCosts,
  seedStaleReplaySupplier,
  type StaleReplayWorld,
} from "./helpers/historicalReplayFixture";
import { REPLAY_ALGORITHM_VERSION } from "../server/services/factory/historicalCostReplay";
import { signRepairToken, verifyRepairToken } from "../server/services/factory/repairToken";
import {
  HISTORICAL_REPLAY_APPLY_MODE_ENV,
  HISTORICAL_REPLAY_APPLY_MODE_VALUE,
  HISTORICAL_REPLAY_RELEASE_ID_ENV,
  historicalReplayReadinessVersion,
} from "../server/services/factory/historical-replay/productionReadinessV8";

const APPLY = "/api/factory/raw-stock/recalc/historical-replay/apply";
const UNDO = "/api/factory/raw-stock/recalc/undo";
const RELEASE = "coverage-release-v4";
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of [HISTORICAL_REPLAY_APPLY_MODE_ENV, HISTORICAL_REPLAY_RELEASE_ID_ENV]) saved[key] = process.env[key];
  process.env[HISTORICAL_REPLAY_APPLY_MODE_ENV] = HISTORICAL_REPLAY_APPLY_MODE_VALUE;
  process.env[HISTORICAL_REPLAY_RELEASE_ID_ENV] = RELEASE;
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function authorize(world: FactoryWorld, confirmationToken: string): string {
  const issuedAt = Date.now();
  return signRepairToken({
    kind: "HISTORICAL_REPLAY_V8_APPLY_AUTHORIZATION",
    companyId: world.companyId,
    userId: world.userId,
    releaseId: RELEASE,
    algorithmVersion: REPLAY_ALGORITHM_VERSION,
    readinessVersion: historicalReplayReadinessVersion(),
    confirmationTokenHash: crypto.createHash("sha256").update(confirmationToken).digest("hex"),
    issuedAt,
    expiresAt: issuedAt + 60_000,
  });
}

function applyWith(world: FactoryWorld, confirmationToken: string, extra: Record<string, unknown> = {}) {
  return world.agent.post(APPLY).send({
    confirmationToken,
    applyAuthorizationToken: authorize(world, confirmationToken),
    productionReleaseId: RELEASE,
    ...extra,
  });
}

let undoSeq = 0;

/** The undo path is a destructive privileged write: step-up password plus reason and idempotency key. */
async function undo(world: FactoryWorld, undoLogId: number) {
  const confirm = await world.agent.post("/api/auth/confirm-password").send({ password: "rolledback-pass-123" });
  expect(confirm.status).toBe(200);
  return world.agent.post(UNDO).send({
    undoLogId,
    reason: "coverage undo of historical replay",
    idempotencyKey: `undo-${world.tag}-${++undoSeq}`,
  });
}

async function prepared(world: FactoryWorld, seeded: StaleReplayWorld) {
  const res = await world.agent.post(APPLY).send({ supplierIds: [seeded.supplierId] });
  expect(res.status).toBe(200);
  expect(typeof res.body.confirmationToken).toBe("string");
  return { body: res.body, payload: verifyRepairToken<Record<string, any>>(res.body.confirmationToken) };
}

async function withStaleSupplier(work: (world: FactoryWorld, seeded: StaleReplayWorld) => Promise<void>) {
  await withFactoryWorld(async (world) => {
    await work(world, await seedStaleReplaySupplier(world.client, world.companyId));
  });
}

describe("historical replay V4 prepare, apply and exact undo over HTTP", () => {
  it("prepares a signed scope, applies it once, and undoes it exactly", async () => {
    await withStaleSupplier(async (world, seeded) => {
      const { body } = await prepared(world, seeded);
      expect(body).toMatchObject({
        dryRun: true,
        safeSupplierIds: [seeded.supplierId],
        fullCompanyScope: true,
        scope: { suppliers: 1, containers: 1, rawStockRows: 1, supplierSources: 1, batches: 1, availableBales: 1 },
        downstreamSafety: { safeToApply: true },
      });
      expect(body.financialImpact.batchImpacts).toEqual([
        expect.objectContaining({ batchId: seeded.batchId, valueDifference: 40 }),
      ]);
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(STALE_COSTS);

      const applied = await applyWith(world, body.confirmationToken);
      expect(applied.status, applied.text).toBe(200);
      expect(applied.body).toMatchObject({ success: true, suppliersApplied: 1, balesUpdated: 1 });
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(REPLAYED_COSTS);

      const [log] = await world.q(
        `SELECT id, operation_type FROM factory_recalc_undo_log WHERE company_id = $1 ORDER BY id DESC LIMIT 1`,
        [world.companyId]
      );
      expect(log.operation_type).toBe("HISTORICAL_REPLAY_EXACT");
      const audit = await world.q(
        `SELECT action FROM audit_log WHERE company_id = $1 AND action LIKE 'historical_cost%'`,
        [world.companyId]
      );
      expect(audit.map((row) => row.action)).toEqual(["historical_cost_replay_applied"]);

      const replayed = await applyWith(world, body.confirmationToken);
      expect(replayed.status).toBe(409);
      expect(replayed.body.code).toBe("STALE_TOKEN");

      const undone = await undo(world, log.id);
      expect(undone.status, undone.text).toBe(200);
      expect(undone.body).toMatchObject({ exactHistoricalReplayUndo: true, balesRestored: 1, suppliersRestored: 1 });
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(STALE_COSTS);

      const again = await undo(world, log.id);
      expect(again.status).toBe(409);
      expect(again.body.message).toMatch(/already been undone/);
    });
  });

  it("refuses an exact undo whose snapshot is malformed or from another engine", async () => {
    await withStaleSupplier(async (world, seeded) => {
      const { body } = await prepared(world, seeded);
      expect((await applyWith(world, body.confirmationToken)).status).toBe(200);
      const [log] = await world.q(`SELECT id, snapshot FROM factory_recalc_undo_log WHERE company_id = $1`, [
        world.companyId,
      ]);

      await world.q(`UPDATE factory_recalc_undo_log SET snapshot = $1 WHERE id = $2`, [
        JSON.stringify({ ...log.snapshot, algorithmVersion: "HISTORICAL_COST_REPLAY_V1" }),
        log.id,
      ]);
      const oldEngine = await undo(world, log.id);
      expect(oldEngine.status).toBe(409);
      expect(oldEngine.body.message).toMatch(/algorithm differs/);

      await world.q(`UPDATE factory_recalc_undo_log SET snapshot = $1 WHERE id = $2`, [
        JSON.stringify({ kind: "HISTORICAL_REPLAY_EXACT_V1" }),
        log.id,
      ]);
      const malformed = await undo(world, log.id);
      expect(malformed.status).toBe(409);
      expect(malformed.body.message).toMatch(/undo snapshot is malformed/);

      await world.q(`UPDATE factory_recalc_undo_log SET snapshot = $1 WHERE id = $2`, [
        JSON.stringify(log.snapshot),
        log.id,
      ]);
      await world.q(`UPDATE factory_bales SET weight_kg = 21 WHERE id = $1`, [seeded.baleId]);
      const drifted = await undo(world, log.id);
      expect(drifted.status).toBe(409);
      expect(await readStaleReplayCosts(world.client, seeded)).toMatchObject({ raw_stock_rate: 2, supplier_rate: 2 });
    });
  });

  it("hands legacy and unknown undo entries to the legacy undo handler", async () => {
    await withFactoryWorld(async (world) => {
      const unknown = await undo(world, 2_000_000_000);
      expect(unknown.status).toBe(404);

      for (const snapshot of [{ containers: [] }, { kind: "RAW_STOCK_RECALC_V2" }]) {
        const id = await world.one(
          `INSERT INTO factory_recalc_undo_log (company_id, description, snapshot, undone_at)
           VALUES ($1, 'legacy recalc', $2, NOW()) RETURNING id`,
          [world.companyId, JSON.stringify(snapshot)]
        );
        const legacy = await undo(world, id);
        expect(legacy.status).toBe(400);
        expect(legacy.body.message).toMatch(/recalculation has already been undone/);
      }
    });
  });

  it("returns a token-less prepare with downstream blockers while a perpetual cutover is active", async () => {
    await withStaleSupplier(async (world, seeded) => {
      await world.q(
        `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, status)
         VALUES ($1, CURRENT_DATE - 1, '{}'::jsonb, 'ACTIVE')`,
        [world.companyId]
      );
      const res = await world.agent.post(APPLY).send({ supplierIds: [seeded.supplierId] });
      expect(res.status).toBe(200);
      expect(res.body.confirmationToken).toBeNull();
      expect(res.body.downstreamSafety.safeToApply).toBe(false);
      expect(res.body.projectionError).toMatch(/Downstream production/);
      expect(res.body.financialImpact).toBeUndefined();
    });
  });
});

describe("historical replay V4 apply token refusals", () => {
  it("rejects tampered, expired, foreign and pre-scope tokens without writing", async () => {
    await withStaleSupplier(async (world, seeded) => {
      const { payload } = await prepared(world, seeded);
      const sign = (overrides: Record<string, unknown>) => signRepairToken({ ...payload, ...overrides });
      const cases: Array<[string, number, RegExp]> = [
        ["not-a-token", 400, /Invalid confirmation token/],
        [sign({ expiresAt: Date.now() - 1000 }), 400, /expired/],
        [sign({ companyId: world.companyId + 1 }), 400, /company mismatch/],
        [sign({ userId: "someone-else" }), 400, /user mismatch/],
        [sign({ algorithmVersion: "OLD" }), 400, /algorithm changed/],
        [sign({ scope: undefined }), 400, /predates exact signed replay scopes/],
        [sign({ supplierIds: [seeded.supplierId, seeded.supplierId + 1] }), 400, /inconsistent/],
        [sign({ scope: { ...payload.scope, availableBaleIdsToUpdate: [] } }), 409, /scope changed since Prepare/],
      ];
      for (const [token, status, message] of cases) {
        const res = await applyWith(world, token);
        expect(res.status, `${message}: ${res.text}`).toBe(status);
        expect(res.body.message).toMatch(message);
      }
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(STALE_COSTS);
      const consumed = await world.q(`SELECT 1 FROM factory_replay_consumed_tokens WHERE company_id = $1`, [
        world.companyId,
      ]);
      expect(consumed).toHaveLength(0);
    });
  });

  it("guards finalized-bale writes, conflicting modes and non-admin callers", async () => {
    await withStaleSupplier(async (world, seeded) => {
      const { body } = await prepared(world, seeded);
      const finalized = await applyWith(world, body.confirmationToken, { includeFinalizedBales: true });
      expect(finalized.status).toBe(409);
      expect(finalized.body.code).toBe("HISTORICAL_REPLAY_FINALIZED_BALES_FORBIDDEN");

      const conflicting = await applyWith(world, body.confirmationToken, { dryRun: true });
      expect(conflicting.status).toBe(400);
      expect(conflicting.body.code).toBe("HISTORICAL_REPLAY_CONFLICTING_MODE");

      const manager = await world.agentFor("Manager");
      const denied = await manager.post(APPLY).send({ supplierIds: [seeded.supplierId] });
      expect(denied.status).toBe(403);
      expect((await manager.post(UNDO).send({ undoLogId: 1 })).status).toBe(403);
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(STALE_COSTS);
    });
  });
});
