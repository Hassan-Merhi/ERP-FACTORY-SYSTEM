/**
 * Plan batch 2 (owner-approved 2026-11-05): stock items created or deleted on
 * the factory LAN server, on the full application schema.
 *
 * LAN: POST /api/stock-items takes an id from the reserved LAN range and
 * records stock.item-create.v1; DELETE /api/stock-items/:id records
 * stock.item-delete.v1 and is refused offline for an item with movements.
 * Cloud: the create replays once and maps the LAN id to the cloud item; every
 * later record naming the LAN id is translated (or waits until the create has
 * applied); a taken code is reject-only, a same-name item is held; a delete
 * applies only to an item with no inventory and no movements.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import request from "supertest";

const edge = vi.hoisted(() => ({
  config: { mode: "cloud", primary: false, siteId: null } as Record<string, unknown>,
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { pool } from "../server/db";
import { ensurePhase9StockOutboxSchema } from "../server/edge/phase9StockOutbox";
import { hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";
import { validatePhase9Event } from "../server/edge/phase9EventProtocol.mjs";
import {
  ensurePhase9CloudEventSchema,
  Phase9EventConflict,
  stagePhase9Events,
} from "../server/edge/phase9CloudEventStore.mjs";
import { EDGE_EVENT_STAGE_PROTOCOL } from "../server/edge/phase9EventProtocol.mjs";
import {
  PHASE9_LAN_ITEM_ID_BASE,
  phase9StockItemCreateEnvelope,
  phase9StockItemDeleteEnvelope,
} from "../server/edge/phase9StockItemLifecycleEnvelope.mjs";
import { ensurePhase9StockItemMapSchema, translatePhase9LanStockItems } from "../server/edge/phase9StockItemMap.mjs";
import {
  phase9StockItemCreateApplyHandler,
  phase9StockItemDeleteApplyHandler,
  type Phase9StockItemCreateEvent,
  type Phase9StockItemDeleteEvent,
} from "../server/edge/phase9StockItemLifecycleApply";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, setupTestApp, type TestContext } from "./setup";

const PREFIX = "p9itemlc";
const SITE = randomUUID();
const LAN = { mode: "lan", primary: true, siteId: SITE, writeMode: "lan-primary" };
const CLOUD = { mode: "cloud", primary: false, siteId: null, writeMode: "cloud" };
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let lanSeq = 0;

function wrap<T extends { kind: string; requestId: string }>(sequence: number, payload: T, localRef: number) {
  const event = {
    sequence: String(sequence),
    operationId: payload.requestId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    kind: payload.kind,
    localRef,
    payload,
    payloadSha256: hashEvidence(payload),
  };
  validatePhase9Event("stock", event);
  return event;
}

function actor() {
  return {
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    requestId: randomUUID(),
    businessDate: "2026-11-05",
  };
}

function createEvent(code: string, name: string): Phase9StockItemCreateEvent {
  lanSeq += 1;
  const payload = phase9StockItemCreateEnvelope({
    ...actor(),
    localStockItemId: PHASE9_LAN_ITEM_ID_BASE + 900_000_000 + lanSeq,
    item: {
      code,
      name,
      uom: "PCS",
      stockGroupId: ctx.stockGroupId,
      categoryId: null,
      gradeId: null,
      sellingPrice: "12.50",
      openingQty: null,
      openingRate: null,
      openingValue: null,
      reorderLevel: null,
      active: true,
    },
  });
  return wrap(lanSeq, payload, payload.localStockItemId) as unknown as Phase9StockItemCreateEvent;
}

function deleteEvent(stockItemId: number, code: string): Phase9StockItemDeleteEvent {
  lanSeq += 1;
  const payload = phase9StockItemDeleteEnvelope({ ...actor(), stockItemId, code });
  return wrap(lanSeq, payload, stockItemId) as unknown as Phase9StockItemDeleteEvent;
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

async function replayCreate(client: PoolClient, event: Phase9StockItemCreateEvent, overrideConflicts: string[] = []) {
  await phase9StockItemCreateApplyHandler.authorize(client, event);
  const result = await phase9StockItemCreateApplyHandler.apply(client, event, { overrideConflicts, siteId: SITE });
  expect(await phase9StockItemCreateApplyHandler.verify(client, event, result)).toBe(true);
  return result;
}

async function replayDelete(client: PoolClient, event: Phase9StockItemDeleteEvent) {
  const handled = await translatePhase9LanStockItems(client, SITE, event);
  await phase9StockItemDeleteApplyHandler.authorize(client, handled);
  const result = await phase9StockItemDeleteApplyHandler.apply(client, handled);
  expect(await phase9StockItemDeleteApplyHandler.verify(client, handled, result)).toBe(true);
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
  agent = request.agent(await setupTestApp());
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  edge.config = LAN;
  await ensurePhase9StockOutboxSchema(pool);
  edge.config = CLOUD;
  await ensurePhase9StockItemMapSchema(pool);
  await ensurePhase9CloudEventSchema(pool);
}, 120_000);

afterAll(async () => {
  edge.config = CLOUD;
  await pool.query("ALTER TABLE factory_edge_staged_events DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_staged_events WHERE site_id = $1", [SITE]);
  await pool.query("ALTER TABLE factory_edge_staged_events ENABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_event_stage_cursor WHERE site_id = $1", [SITE]);
  await pool.query("ALTER TABLE factory_edge_stock_outbox DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_stock_outbox WHERE site_id = $1", [SITE]);
  await pool.query("ALTER TABLE factory_edge_stock_outbox ENABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_stock_counter WHERE site_id = $1", [SITE]);
  await pool.query(`DELETE FROM canonical_stock_movements WHERE idempotency_key LIKE '${PREFIX}-%'`);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Stock items created and deleted on the factory LAN server", () => {
  it("creates an item with an id from the reserved range and records it in the same transaction", async () => {
    edge.config = LAN;
    try {
      const created = await agent.post("/api/stock-items").send({
        code: `${PREFIX}-NEW1`,
        name: "Offline jacket",
        uom: "PCS",
        stockGroupId: ctx.stockGroupId,
        sellingPrice: "20",
      });
      expect(created.status).toBe(201);
      expect(created.body.id).toBeGreaterThanOrEqual(PHASE9_LAN_ITEM_ID_BASE);
      const outbox = await pool.query(
        "SELECT operation_kind, local_movement_id::int AS local, payload FROM factory_edge_stock_outbox WHERE site_id = $1 AND operation_kind = 'stock.item-create.v1'",
        [SITE]
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0].local).toBe(created.body.id);
      expect(outbox.rows[0].payload.item).toMatchObject({ code: `${PREFIX}-NEW1`, name: "Offline jacket" });

      const deleted = await agent.delete(`/api/stock-items/${created.body.id}`);
      expect(deleted.status).toBe(200);
      const deletes = await pool.query(
        "SELECT payload FROM factory_edge_stock_outbox WHERE site_id = $1 AND operation_kind = 'stock.item-delete.v1'",
        [SITE]
      );
      expect(deletes.rows.map((row) => row.payload.stockItemId)).toEqual([created.body.id]);
    } finally {
      edge.config = CLOUD;
    }
  });

  it("refuses offline to delete an item that has stock movements", async () => {
    edge.config = LAN;
    try {
      const created = await agent.post("/api/stock-items").send({
        code: `${PREFIX}-MOVED`,
        name: "Moved item",
        uom: "PCS",
        stockGroupId: ctx.stockGroupId,
      });
      expect(created.status).toBe(201);
      await pool.query(
        `INSERT INTO canonical_stock_movements
           (company_id, stock_item_id, location_id, quantity_delta, unit_cost, movement_kind,
            source_type, source_id, idempotency_key, occurred_at)
         VALUES ($1, $2, $3, 1, 0, 'receipt', 'test', 'x', $4, now())`,
        [ctx.companyId, created.body.id, ctx.locationId, `${PREFIX}-${randomUUID()}`]
      );
      const refused = await agent.delete(`/api/stock-items/${created.body.id}`);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("EDGE_PHASE9_STOCK_ITEM_HAS_MOVEMENTS");
    } finally {
      edge.config = CLOUD;
    }
  });
});

describe("Cloud replay of LAN-created and LAN-deleted stock items", () => {
  it("creates the item once, maps the LAN id, and translates later records that name it", async () => {
    await inRolledBackTx(async (client) => {
      const event = createEvent(`${PREFIX}-C1`, "LAN only coat");
      const first = await replayCreate(client, event);
      expect(first.outcome).toBe("cloud-applied");
      expect(first.cloudRef).toBeLessThan(PHASE9_LAN_ITEM_ID_BASE);
      expect(await replayCreate(client, event)).toEqual({ ...first, outcome: "already-present" });

      const later = {
        payload: { stockItemId: event.payload.localStockItemId, items: [{ stockItemId: ctx.stockItemIds[0] }] },
      };
      const translated = await translatePhase9LanStockItems(client, SITE, later);
      expect(translated.payload).toEqual({
        stockItemId: first.cloudRef,
        items: [{ stockItemId: ctx.stockItemIds[0] }],
      });
    });
  });

  it("makes a record naming a LAN item the cloud has not created yet wait, without a conflict", async () => {
    await inRolledBackTx(async (client) => {
      await expect(
        translatePhase9LanStockItems(client, SITE, { payload: { stockItemId: PHASE9_LAN_ITEM_ID_BASE + 123 } })
      ).rejects.toThrow("PHASE9_STOCK_ITEM_NOT_YET_SYNCED");
    });
  });

  it("refuses a code the cloud already uses and holds a same-name item until approved", async () => {
    await inRolledBackTx(async (client) => {
      const existing = await client.query("SELECT code, name FROM stock_items WHERE id = $1", [ctx.stockItemIds[0]]);
      expect(await conflictCode(replayCreate(client, createEvent(String(existing.rows[0].code), "Another name")))).toBe(
        "PHASE9_STOCK_ITEM_CODE_TAKEN"
      );
      const sameName = createEvent(`${PREFIX}-C2`, String(existing.rows[0].name));
      expect(await conflictCode(replayCreate(client, sameName))).toBe("PHASE9_STOCK_ITEM_NAME_EXISTS");
      expect((await replayCreate(client, sameName, ["PHASE9_STOCK_ITEM_NAME_EXISTS"])).outcome).toBe("cloud-applied");
    });
  });

  it("deletes an unused item (by its LAN id) and refuses one the cloud still holds stock of", async () => {
    await inRolledBackTx(async (client) => {
      const created = createEvent(`${PREFIX}-C3`, "Short-lived item");
      const made = await replayCreate(client, created);
      const removed = await replayDelete(client, deleteEvent(created.payload.localStockItemId, `${PREFIX}-C3`));
      expect(removed).toMatchObject({ outcome: "cloud-applied", cloudRef: made.cloudRef });
      expect((await replayDelete(client, deleteEvent(created.payload.localStockItemId, `${PREFIX}-C3`))).outcome).toBe(
        "already-present"
      );

      const stocked = await client.query("SELECT code FROM stock_items WHERE id = $1", [ctx.stockItemIds[0]]);
      expect(
        await conflictCode(replayDelete(client, deleteEvent(ctx.stockItemIds[0], String(stocked.rows[0].code))))
      ).toBe("PHASE9_STOCK_ITEM_IN_USE");
    });
  });
});

describe("Staging follow-up records that name the same LAN row", () => {
  it("stages a delete of a LAN-created item after its create (both carry the item's LAN id)", async () => {
    const created = createEvent(`${PREFIX}-S1`, "Staged item");
    const removed = deleteEvent(created.payload.localStockItemId, `${PREFIX}-S1`);
    const events = [created, removed].map((event, index) => ({ ...event, sequence: String(index + 1) }));
    const body = { protocol: EDGE_EVENT_STAGE_PROTOCOL, siteId: SITE, stream: "stock", events };
    await stagePhase9Events(pool, body, SITE);
    const staged = await pool.query(
      "SELECT operation_kind, local_ref FROM factory_edge_staged_events WHERE site_id = $1 ORDER BY sequence",
      [SITE]
    );
    expect(staged.rows).toEqual([
      { operation_kind: "stock.item-create.v1", local_ref: created.payload.localStockItemId },
      { operation_kind: "stock.item-delete.v1", local_ref: created.payload.localStockItemId },
    ]);
    // A replay of the same batch stays idempotent.
    await stagePhase9Events(pool, body, SITE);
  });
});
