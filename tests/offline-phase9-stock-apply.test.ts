/**
 * Phase 9 cloud replay of factory LAN stock movements (stock.quick-adjust.v1)
 * against the full application schema: the real handler, the shared
 * quick-adjust implementation, the canonical stock journal and the owner
 * policy that a below-zero result is held for an Admin/Developer decision.
 * Every scenario runs inside a transaction that is rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import { pool } from "../server/db";
import { hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";
import { validatePhase9Event } from "../server/edge/phase9EventProtocol.mjs";
import { Phase9EventConflict } from "../server/edge/phase9CloudEventStore.mjs";
import { phase9StockApplyHandler, type Phase9StockEvent } from "../server/edge/phase9StockApply";
import { phase9StockAdjustEnvelope } from "../server/edge/phase9StockEnvelope.mjs";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p9stock";
let ctx: TestContext;

function stockEvent(
  sequence: number,
  options: { direction: "add" | "subtract"; quantity: string; stockItemId?: number; requestId?: string }
): Phase9StockEvent {
  const requestId = options.requestId ?? `6f1c2d3e-4a5b-4c6d-8e7f-${String(sequence).padStart(12, "0")}`;
  const payload = phase9StockAdjustEnvelope({
    companyId: ctx.companyId,
    localMovementId: 1000 + sequence,
    stockItemId: options.stockItemId ?? ctx.stockItemIds[0],
    locationId: ctx.locationId,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    requestId,
    direction: options.direction,
    quantity: options.quantity,
    occurredAt: "2026-10-31T06:15:00.000Z",
    businessDate: "2026-10-31",
  });
  const event = {
    sequence: String(sequence),
    operationId: requestId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    kind: payload.kind,
    localRef: payload.localMovementId,
    payload,
    payloadSha256: hashEvidence(payload),
  };
  // The handler only ever sees events that passed the stream registry.
  validatePhase9Event("stock", event);
  return event as Phase9StockEvent;
}

async function inRolledBackTx<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(ctx.companyId), async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await run(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
}

async function quantity(client: PoolClient, stockItemId = ctx.stockItemIds[0]): Promise<number> {
  const result = await client.query(
    "SELECT quantity::numeric AS q FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3",
    [ctx.companyId, ctx.locationId, stockItemId]
  );
  return Number(result.rows[0]?.q ?? 0);
}

async function replay(client: PoolClient, event: Phase9StockEvent, overrideConflicts: string[] = []) {
  await phase9StockApplyHandler.authorize(client, event);
  const result = await phase9StockApplyHandler.apply(client, event, { overrideConflicts });
  expect(await phase9StockApplyHandler.verify(client, event, result)).toBe(true);
  return result;
}

async function conflictCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Phase9EventConflict) return error.message;
    throw error;
  }
  throw new Error("expected a Phase 9 conflict");
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
}, 120_000);

afterAll(async () => {
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 9 stock movement cloud replay (POST /api/inventory/quick-adjust)", () => {
  it("applies a LAN addition and subtraction as deltas on the cloud's own balance", async () => {
    await inRolledBackTx(async (client) => {
      expect(await quantity(client)).toBe(100);
      const added = await replay(client, stockEvent(1, { direction: "add", quantity: "7.500" }));
      expect(added).toMatchObject({ outcome: "cloud-applied", businessDate: "2026-10-31" });
      expect(await quantity(client)).toBe(107.5);
      await replay(client, stockEvent(2, { direction: "subtract", quantity: "40.000" }));
      expect(await quantity(client)).toBe(67.5);
      const journal = await client.query(
        `SELECT count(*)::int AS n FROM canonical_stock_movements
          WHERE company_id = $1 AND source_type = 'inventory_quick_adjustment'`,
        [ctx.companyId]
      );
      expect(journal.rows[0].n).toBe(2);
    });
  });

  it("replays a lost acknowledgement as already-present without moving stock twice", async () => {
    await inRolledBackTx(async (client) => {
      const event = stockEvent(3, { direction: "add", quantity: "5" });
      const first = await replay(client, event);
      const again = await replay(client, event);
      expect(again).toEqual({ ...first, outcome: "already-present" });
      expect(await quantity(client)).toBe(105);
    });
  });

  it("holds a movement that would take cloud stock below zero, and applies it only with an override", async () => {
    await inRolledBackTx(async (client) => {
      const event = stockEvent(4, { direction: "subtract", quantity: "150" });
      expect(await conflictCode(replay(client, event))).toBe("PHASE9_STOCK_WOULD_GO_NEGATIVE");
      expect(await quantity(client)).toBe(100);
      // Only the overridable code unlocks it; an unrelated override does not.
      expect(await conflictCode(replay(client, event, ["PHASE9_STOCK_ITEM_MISSING"]))).toBe(
        "PHASE9_STOCK_WOULD_GO_NEGATIVE"
      );
      await replay(client, event, ["PHASE9_STOCK_WOULD_GO_NEGATIVE"]);
      expect(await quantity(client)).toBe(-50);
    });
  });

  it("refuses a replay whose operation id already moved different stock", async () => {
    await inRolledBackTx(async (client) => {
      const requestId = "0d9b8a7c-6e5f-4a3b-9c2d-1e0f9a8b7c6d";
      await replay(client, stockEvent(5, { direction: "add", quantity: "1", requestId }));
      const diverged = stockEvent(6, { direction: "add", quantity: "2", requestId });
      expect(await conflictCode(replay(client, diverged))).toBe("PHASE9_STOCK_REQUEST_ID_DIVERGED");
      expect(await quantity(client)).toBe(101);
    });
  });

  it("refuses items that no longer exist in this company", async () => {
    await inRolledBackTx(async (client) => {
      const event = stockEvent(7, { direction: "add", quantity: "1", stockItemId: 2147480000 });
      expect(await conflictCode(replay(client, event))).toBe("PHASE9_STOCK_ITEM_MISSING");
    });
  });

  it("re-checks the actor's current access and the act_adjust_stock permission", async () => {
    await inRolledBackTx(async (client) => {
      const event = stockEvent(8, { direction: "add", quantity: "1" });
      await client.query("UPDATE user_company_roles SET role = 'Manager' WHERE user_id = $1 AND company_id = $2", [
        ctx.userId,
        ctx.companyId,
      ]);
      await client.query(
        `INSERT INTO role_feature_permissions (company_id, role, feature_key, enabled)
         VALUES ($1, 'Manager', 'act_adjust_stock', false)`,
        [ctx.companyId]
      );
      expect(await conflictCode(phase9StockApplyHandler.authorize(client, event))).toBe(
        "PHASE9_ACTOR_ROLE_NOT_PERMITTED"
      );
      await client.query("UPDATE users SET active = false WHERE id = $1", [ctx.userId]);
      expect(await conflictCode(phase9StockApplyHandler.authorize(client, event))).toBe("PHASE9_ACTOR_ACCESS_REVOKED");
    });
  });
});
