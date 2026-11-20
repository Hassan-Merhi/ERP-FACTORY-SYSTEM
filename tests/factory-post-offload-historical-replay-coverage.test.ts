/**
 * Post-offload historical replay (replayPostOffloadHistoricalCosts) against
 * a rolled-back factory company: no supplier, no replay inputs, a supplier
 * blocked by an unclassified valued adjustment, a supplier whose costs are
 * already current, a stale supplier that is replayed with its undo log and
 * audit row, and a database failure reported as "failed" with its code.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld } from "./helpers/rolledBackFactoryApp";
import { REPLAYED_COSTS, readStaleReplayCosts, seedStaleReplaySupplier } from "./helpers/historicalReplayFixture";
import { replayPostOffloadHistoricalCosts } from "../server/services/factory/postOffloadHistoricalReplay";

const params = (companyId: number, supplierId: number | null | undefined, extra: Record<string, unknown> = {}) => ({
  companyId,
  supplierId,
  containerId: 77,
  chargeId: 5,
  mutationAction: "EDIT" as const,
  userId: "u-1",
  username: "clerk",
  ...extra,
});

describe("replayPostOffloadHistoricalCosts", () => {
  it("does nothing for containers without a supplier", async () => {
    for (const supplierId of [null, undefined, 0, -4]) {
      const result = await replayPostOffloadHistoricalCosts(params(1, supplierId));
      expect(result).toMatchObject({ status: "no_changes", containerId: 77, chargeId: 5 });
      expect(result.supplierId).toBe(supplierId ?? null);
    }
  });

  it("reports no inputs for a supplier without any replay history", () =>
    withFactoryWorld(async (world) => {
      const result = await replayPostOffloadHistoricalCosts(params(world.companyId, 2_000_000_000));
      expect(result).toMatchObject({
        status: "no_changes",
        reason: "No historical replay inputs exist for this supplier.",
      });
    }));

  it("blocks a supplier whose timeline has a legacy unclassified valued adjustment", () =>
    withFactoryWorld(async (world) => {
      const seeded = await seedStaleReplaySupplier(world.client, world.companyId);
      // New rows are classified by trigger; a pre-classification legacy row is
      // reproduced by inserting with triggers off for this one statement.
      await world.q(`SET LOCAL session_replication_role = replica`);
      await world.q(
        `INSERT INTO factory_raw_material_adjustments (company_id, supplier_id, type, kg, cost_per_kg, date)
         VALUES ($1, $2, 'ADD', 10, 3, '2026-01-03')`,
        [world.companyId, seeded.supplierId]
      );
      await world.q(`SET LOCAL session_replication_role = origin`);
      const before = await readStaleReplayCosts(world.client, seeded);
      const result = await replayPostOffloadHistoricalCosts(params(world.companyId, seeded.supplierId));
      expect(result.status).toBe("blocked");
      expect(result.reason).toBe("Historical supplier-cost replay requires admin review.");
      expect(result.blockedReasons).toContain("ADJUSTMENT_VALUATION_UNCLASSIFIED");
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(before);
    }));

  it("refuses with a coded failure when the replay would reprice sold bales", () =>
    withFactoryWorld(async (world) => {
      const seeded = await seedStaleReplaySupplier(world.client, world.companyId, { baleStatus: "SOLD" });
      const before = await readStaleReplayCosts(world.client, seeded);
      const result = await replayPostOffloadHistoricalCosts(params(world.companyId, seeded.supplierId));
      expect(result).toMatchObject({ status: "failed", code: "HISTORICAL_REPLAY_DOWNSTREAM_UNRECONCILED" });
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(before);
    }));

  // BUG (pinned): the audit_log insert passes `userId || null` and the
  // `username = null` default into NOT NULL columns, so a caller without a
  // session username (or user id) gets a rolled-back replay reported as failed.
  it("fails and leaves costs untouched when the caller has no username or user id", () =>
    withFactoryWorld(async (world) => {
      const seeded = await seedStaleReplaySupplier(world.client, world.companyId);
      const before = await readStaleReplayCosts(world.client, seeded);
      for (const who of [{ username: undefined }, { userId: "" }]) {
        const result = await replayPostOffloadHistoricalCosts(params(world.companyId, seeded.supplierId, who));
        expect(result).toMatchObject({ status: "failed", code: "23502" });
        expect(result.reason).toMatch(/audit_log/);
      }
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(before);
    }));

  it("replays a stale supplier, writes the exact undo envelope and audits the mutation", () =>
    withFactoryWorld(async (world) => {
      const seeded = await seedStaleReplaySupplier(world.client, world.companyId, { supplierName: "Kasai Mills" });
      const result = await replayPostOffloadHistoricalCosts(
        params(world.companyId, seeded.supplierId, {
          containerId: seeded.containerId,
          chargeId: null,
          mutationAction: "CREATE",
          userId: world.userId,
        })
      );
      expect(result).toMatchObject({ status: "applied", supplierId: seeded.supplierId, undoLogCreated: true });
      expect(result.suppliersApplied).toBe(1);
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(REPLAYED_COSTS);

      const [undo] = await world.q(
        `SELECT user_id, username, description, operation_type, snapshot FROM factory_recalc_undo_log WHERE company_id = $1`,
        [world.companyId]
      );
      expect(undo).toMatchObject({
        user_id: world.userId,
        username: "clerk",
        description: "Post-offload create historical replay — Kasai Mills",
        operation_type: "HISTORICAL_REPLAY_EXACT",
      });
      const envelope = typeof undo.snapshot === "string" ? JSON.parse(undo.snapshot) : undo.snapshot;
      expect(envelope).toMatchObject({ kind: "HISTORICAL_REPLAY_EXACT_V1", includeCompletedBatches: true });
      expect(envelope.baleIds).toEqual([seeded.baleId]);

      const [audit] = await world.q(
        `SELECT record_id, changes FROM audit_log WHERE company_id = $1 AND action = 'post_offload_historical_replay_applied'`,
        [world.companyId]
      );
      expect(Number(audit.record_id)).toBe(seeded.containerId);
      expect(audit.changes).toMatchObject({ mutationAction: "CREATE", chargeId: null, supplierId: seeded.supplierId });

      // Replaying again is idempotent: the costs stay at the replayed values.
      const again = await replayPostOffloadHistoricalCosts(params(world.companyId, seeded.supplierId));
      expect(again.status).toBe("applied");
      expect(await readStaleReplayCosts(world.client, seeded)).toEqual(REPLAYED_COSTS);
    }));

  it("reports database failures with their code instead of throwing", async () => {
    const result = await replayPostOffloadHistoricalCosts(params(Number.NaN, 3));
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/invalid input syntax|NaN/i);
    expect(typeof result.code).toBe("string");
  });
});
