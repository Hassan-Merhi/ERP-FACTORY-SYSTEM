/**
 * Phase 9 offline stock transfers (stock.transfer.v1) on the full application
 * schema: the factory LAN capture through POST /api/stock-transfers (same
 * transaction, immutable outbox) and the cloud replay through the shared
 * transfer code, idempotent on the LAN request id, with a cloud shortfall held
 * for an Admin/Developer decision (owner policy 2026-11-02).
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
import { Phase9EventConflict } from "../server/edge/phase9CloudEventStore.mjs";
import { phase9StockTransferEnvelope } from "../server/edge/phase9StockEnvelope.mjs";
import {
  phase9StockTransferApplyHandler,
  type Phase9StockTransferEvent,
} from "../server/edge/phase9StockTransferApply";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, setupTestApp, type TestContext } from "./setup";

const PREFIX = "p9xfer";
const SITE = randomUUID();
let ctx: TestContext;

const LAN = { mode: "lan", primary: true, siteId: SITE, writeMode: "lan-primary" };
const CLOUD = { mode: "cloud", primary: false, siteId: null, writeMode: "cloud" };

function transferEvent(
  sequence: number,
  options: { quantity: string; requestId?: string; destinationLocationId?: number }
): Phase9StockTransferEvent {
  const requestId = options.requestId ?? randomUUID();
  const payload = phase9StockTransferEnvelope({
    companyId: ctx.companyId,
    localTransferId: 5000 + sequence,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    requestId,
    businessDate: "2026-11-02",
    sourceLocationId: ctx.locationId,
    destinationLocationId: options.destinationLocationId ?? ctx.location2Id,
    notes: null,
    optional: false,
    allowNegativeInventory: true,
    items: [
      { sourceLocationId: ctx.locationId, stockItemId: ctx.stockItemIds[0], quantity: options.quantity, rate: "0" },
    ],
  });
  const event = {
    sequence: String(sequence),
    operationId: requestId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    kind: payload.kind,
    localRef: payload.localTransferId,
    payload,
    payloadSha256: hashEvidence(payload),
  };
  validatePhase9Event("stock", event);
  return event as unknown as Phase9StockTransferEvent;
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

async function replay(client: PoolClient, event: Phase9StockTransferEvent, overrideConflicts: string[] = []) {
  await phase9StockTransferApplyHandler.authorize(client, event);
  const result = await phase9StockTransferApplyHandler.apply(client, event, { overrideConflicts });
  expect(await phase9StockTransferApplyHandler.verify(client, event, result)).toBe(true);
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

async function quantity(queryable: Pick<PoolClient, "query">, locationId: number): Promise<number> {
  const result = await queryable.query(
    "SELECT quantity::numeric AS q FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3",
    [ctx.companyId, locationId, ctx.stockItemIds[0]]
  );
  return Number(result.rows[0]?.q ?? 0);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  const agent = request.agent(await setupTestApp());
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  ctx.agent = agent;
  edge.config = LAN;
  await ensurePhase9StockOutboxSchema(pool);
  edge.config = CLOUD;
}, 120_000);

afterAll(async () => {
  edge.config = CLOUD;
  await pool.query("ALTER TABLE factory_edge_stock_outbox DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_stock_outbox WHERE site_id = $1", [SITE]);
  await pool.query("ALTER TABLE factory_edge_stock_outbox ENABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_stock_counter WHERE site_id = $1", [SITE]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 9 offline stock transfers (POST /api/stock-transfers)", () => {
  it("records a new LAN transfer on the stock stream in the same transaction, once per request id", async () => {
    edge.config = LAN;
    try {
      const clientRequestId = randomUUID();
      const body = {
        sourceLocationId: ctx.locationId,
        destinationLocationId: ctx.location2Id,
        items: [{ stockItemId: ctx.stockItemIds[0], quantity: "4" }],
        voucherDate: "2026-11-02",
        clientRequestId,
      };
      const created = await ctx.agent.post("/api/stock-transfers").send(body);
      expect(created.status).toBe(201);
      const outbox = await pool.query(
        "SELECT operation_kind, local_movement_id, payload FROM factory_edge_stock_outbox WHERE operation_id = $1",
        [clientRequestId]
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]).toMatchObject({
        operation_kind: "stock.transfer.v1",
        local_movement_id: String(created.body.transfer.id),
      });
      expect(outbox.rows[0].payload).toMatchObject({
        destinationLocationId: ctx.location2Id,
        items: [{ sourceLocationId: ctx.locationId, stockItemId: ctx.stockItemIds[0], quantity: "4.000" }],
      });
      // A retried request is the same transfer: nothing new to sync.
      const again = await ctx.agent.post("/api/stock-transfers").send(body);
      expect(again.body.replayed).toBe(true);
      const count = await pool.query("SELECT count(*)::int AS n FROM factory_edge_stock_outbox WHERE site_id = $1", [
        SITE,
      ]);
      expect(count.rows[0].n).toBe(1);

      // The cloud already holding this transfer (a lost ACK) is already-present.
      const event = {
        sequence: "1",
        operationId: clientRequestId,
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        kind: "stock.transfer.v1",
        localRef: created.body.transfer.id,
        payload: outbox.rows[0].payload,
        payloadSha256: hashEvidence(outbox.rows[0].payload),
      };
      validatePhase9Event("stock", event);
      await inRolledBackTx(async (client) => {
        const result = await replay(client, event as unknown as Phase9StockTransferEvent);
        expect(result).toMatchObject({ outcome: "already-present", cloudRef: created.body.transfer.id });
      });
    } finally {
      edge.config = CLOUD;
    }
  });

  it("refuses the existing-voucher transfer form on the LAN", async () => {
    edge.config = LAN;
    try {
      const refused = await ctx.agent.post("/api/stock-transfers").send({
        voucherId: 1,
        destinationLocationId: ctx.location2Id,
        items: [{ sourceLocationId: ctx.locationId, stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "1" }],
      });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("EDGE_PHASE9_STOCK_TRANSFER_FORM_CLOUD_ONLY");
    } finally {
      edge.config = CLOUD;
    }
  });

  it("replays a LAN transfer in the cloud, moving stock once", async () => {
    await inRolledBackTx(async (client) => {
      const from = await quantity(client, ctx.locationId);
      const to = await quantity(client, ctx.location2Id);
      const event = transferEvent(2, { quantity: "6.000" });
      const applied = await replay(client, event);
      expect(applied).toMatchObject({ outcome: "cloud-applied", businessDate: "2026-11-02" });
      expect(await quantity(client, ctx.locationId)).toBe(from - 6);
      expect(await quantity(client, ctx.location2Id)).toBe(to + 6);
      const again = await replay(client, event);
      expect(again).toEqual({ ...applied, outcome: "already-present" });
      expect(await quantity(client, ctx.locationId)).toBe(from - 6);
    });
  });

  it("holds a transfer the cloud cannot cover until an Admin/Developer approves the override", async () => {
    await inRolledBackTx(async (client) => {
      const from = await quantity(client, ctx.locationId);
      const event = transferEvent(3, { quantity: String(from + 50) });
      expect(await conflictCode(replay(client, event))).toBe("PHASE9_STOCK_WOULD_GO_NEGATIVE");
      expect(await quantity(client, ctx.locationId)).toBe(from);
      await replay(client, event, ["PHASE9_STOCK_WOULD_GO_NEGATIVE"]);
      expect(await quantity(client, ctx.locationId)).toBe(-50);
    });
  });

  it("refuses a request id that already made a different transfer, and a revoked actor", async () => {
    await inRolledBackTx(async (client) => {
      const requestId = randomUUID();
      await replay(client, transferEvent(4, { quantity: "1.000", requestId }));
      expect(await conflictCode(replay(client, transferEvent(5, { quantity: "2.000", requestId })))).toBe(
        "PHASE9_STOCK_REQUEST_ID_DIVERGED"
      );
      await client.query("UPDATE users SET active = false WHERE id = $1", [ctx.userId]);
      expect(
        await conflictCode(phase9StockTransferApplyHandler.authorize(client, transferEvent(6, { quantity: "1" })))
      ).toBe("PHASE9_ACTOR_ACCESS_REVOKED");
    });
  });
});
