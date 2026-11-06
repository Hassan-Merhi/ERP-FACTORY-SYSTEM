/**
 * Plan batch 3 (owner-approved 2026-11-05): changes to existing stock
 * transfers made on the factory LAN server, on the full application schema.
 *
 * LAN: PUT /api/stock-transfers/:id, finalize (voucher and transfer routes),
 * revisions and revision approve/reject each record their change in the same
 * transaction, naming the transfer by its LAN record when it was created
 * offline. A non-transfer voucher finalize is refused on the LAN.
 *
 * Cloud: each change applies only while the cloud copy still matches what
 * the factory saw:
 * - an edit or finalize of a changed transfer is held (approvable);
 * - a stale revision is held (reject-only);
 * - a transfer whose offline create was rejected is reject-only.
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
import { phase9OverridableConflicts, validatePhase9Event } from "../server/edge/phase9EventProtocol.mjs";
import { ensurePhase9CloudEventSchema, Phase9EventConflict } from "../server/edge/phase9CloudEventStore.mjs";
import {
  PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT,
  phase9StockTransferEditEnvelope,
  phase9StockTransferFinalizeEnvelope,
  phase9StockTransferRevisionEnvelope,
  phase9StockTransferRevisionReviewEnvelope,
  type Phase9TransferRef,
  type Phase9TransferSnapshot,
} from "../server/edge/phase9StockTransferWorkflowEnvelope.mjs";
import { phase9StockTransferApplyHandler } from "../server/edge/phase9StockTransferApply";
import {
  phase9StockTransferEditApplyHandler,
  phase9StockTransferFinalizeApplyHandler,
  phase9StockTransferRevisionApplyHandler,
  phase9StockTransferRevisionReviewApplyHandler,
} from "../server/edge/phase9StockTransferWorkflowApply";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, setupTestApp, type TestContext } from "./setup";

const PREFIX = "p9trwf";
const SITE = randomUUID();
const LAN = { mode: "lan", primary: true, siteId: SITE, writeMode: "lan-primary" };
const CLOUD = { mode: "cloud", primary: false, siteId: null, writeMode: "cloud" };
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let seq = 0;

type Handler = {
  authorize: (client: PoolClient, event: never) => Promise<void>;
  apply: (client: PoolClient, event: never, context: never) => Promise<{ outcome: string; cloudRef: number }>;
  verify: (client: PoolClient, event: never, result: never) => Promise<boolean>;
};

function actor() {
  return {
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    requestId: randomUUID(),
    businessDate: new Date().toISOString().slice(0, 10),
  };
}

function wrap(payload: { kind: string; requestId: string }, localRef: number) {
  seq += 1;
  const event = {
    sequence: String(seq),
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

async function replay(client: PoolClient, handler: Handler, event: unknown, overrideConflicts: string[] = []) {
  await handler.authorize(client, event as never);
  const result = await handler.apply(client, event as never, { overrideConflicts, siteId: SITE } as never);
  expect(await handler.verify(client, event as never, result as never)).toBe(true);
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

async function createTransfer(quantity: number, optional = false): Promise<{ id: number; voucherId: number }> {
  const response = await agent.post("/api/stock-transfers").send({
    sourceLocationId: ctx.locationId,
    destinationLocationId: ctx.location2Id,
    items: [{ stockItemId: ctx.stockItemIds[0], quantity: String(quantity), sourceLocationId: ctx.locationId }],
    notes: "batch 3 probe",
    optional,
    allowNegativeInventory: true,
    voucherDate: new Date().toISOString().slice(0, 10),
    clientRequestId: randomUUID(),
  });
  expect(response.status).toBe(201);
  return { id: Number(response.body.transfer.id), voucherId: Number(response.body.voucher.id) };
}

function snapshot(quantity: number, flags = { optional: false, inventoryApplied: true }): Phase9TransferSnapshot {
  return {
    destinationLocationId: ctx.location2Id,
    ...flags,
    lines: [{ sourceLocationId: ctx.locationId, stockItemId: ctx.stockItemIds[0], quantity: quantity.toFixed(3) }],
  };
}

function editEvent(transfer: Phase9TransferRef, before: Phase9TransferSnapshot, quantity: number) {
  const payload = phase9StockTransferEditEnvelope({
    ...actor(),
    localEditId: 9000 + seq,
    transfer,
    before,
    after: {
      destinationLocationId: ctx.location2Id,
      notes: "edited offline",
      items: [{ stockItemId: ctx.stockItemIds[0], sourceLocationId: ctx.locationId, quantity, rate: 1 }],
    },
  });
  return wrap(payload, payload.localEditId);
}

async function outbox(kind: string) {
  const rows = await pool.query(
    "SELECT payload FROM factory_edge_stock_outbox WHERE site_id = $1 AND operation_kind = $2 ORDER BY sequence",
    [SITE, kind]
  );
  return rows.rows.map((row) => row.payload);
}

async function markApplied(client: PoolClient, kind: string, localRef: number, cloudRef: number | null) {
  await client.query(
    `INSERT INTO factory_edge_applied_events
       (site_id, stream, sequence, operation_id, company_id, actor_user_id, operation_kind,
        local_ref, cloud_ref, payload_sha256, business_date, outcome)
     VALUES ($1, 'stock', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      SITE,
      100_000 + localRef,
      randomUUID(),
      ctx.companyId,
      ctx.userId,
      kind,
      localRef,
      cloudRef,
      "0".repeat(64),
      cloudRef === null ? null : "2026-11-05",
      cloudRef === null ? "rejected-conflict" : "cloud-applied",
    ]
  );
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
  await ensurePhase9CloudEventSchema(pool);
}, 120_000);

afterAll(async () => {
  edge.config = CLOUD;
  for (const table of ["factory_edge_stock_outbox"]) {
    await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await pool.query(`DELETE FROM ${table} WHERE site_id = $1`, [SITE]);
    await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
  await pool.query("DELETE FROM factory_edge_stock_counter WHERE site_id = $1", [SITE]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Transfer changes on the factory LAN server", () => {
  it("records an edit of a transfer created offline, naming it by its LAN record, with the lines it saw", async () => {
    edge.config = LAN;
    try {
      const transfer = await createTransfer(4);
      const edited = await agent.put(`/api/stock-transfers/${transfer.id}`).send({
        destinationLocationId: ctx.location2Id,
        notes: "edited on the LAN",
        items: [{ stockItemId: ctx.stockItemIds[0], sourceLocationId: ctx.locationId, quantity: 6, rate: 1 }],
      });
      expect(edited.status).toBe(200);
      const [edit] = await outbox("stock.transfer-edit.v1");
      expect(edit.transfer).toEqual({ origin: "lan", localTransferId: transfer.id });
      expect(edit.before.lines).toEqual(snapshot(4).lines);
      expect(edit.after.items).toEqual([
        { stockItemId: ctx.stockItemIds[0], sourceLocationId: ctx.locationId, quantity: 6, rate: 1 },
      ]);
    } finally {
      edge.config = CLOUD;
    }
  });

  it("records a finalize once, and refuses to finalize a voucher that is not a transfer", async () => {
    const draft = await createTransfer(3, true);
    edge.config = LAN;
    try {
      expect((await agent.post(`/api/vouchers/${draft.voucherId}/finalize`)).status).toBe(200);
      // Already final: nothing more is recorded.
      expect((await agent.post(`/api/stock-transfers/${draft.id}/approve`)).status).toBe(200);
      const finalizes = await outbox("stock.transfer-finalize.v1");
      expect(finalizes).toHaveLength(1);
      expect(finalizes[0].transfer).toEqual({ origin: "cloud", transferId: draft.id });
      expect(finalizes[0].before).toMatchObject({ optional: true, inventoryApplied: false });

      const other = await pool.query(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional)
         VALUES ($1, $2, 'Journal', CURRENT_DATE, 0, true) RETURNING id`,
        [ctx.companyId, `${PREFIX}-JV-${seq}`]
      );
      const refused = await agent.post(`/api/vouchers/${other.rows[0].id}/finalize`);
      expect(refused.status).toBe(423);
      expect(refused.body.code).toBe("EDGE_SYNC_UNSUPPORTED_OPERATION");
    } finally {
      edge.config = CLOUD;
    }
  });

  it("records a revision and its approval in the revision's own transaction", async () => {
    const transfer = await createTransfer(5);
    const name = (await pool.query("SELECT name FROM stock_items WHERE id = $1", [ctx.stockItemIds[0]])).rows[0].name;
    edge.config = LAN;
    try {
      const created = await agent.post(`/api/stock-transfers/${transfer.id}/revisions`).send({
        note: "offline revision",
        optional: true,
        items: [
          {
            stockItemId: ctx.stockItemIds[0],
            stockItemName: name,
            sourceLocationId: ctx.locationId,
            originalQuantity: 5,
            newQuantity: 7,
          },
        ],
      });
      expect(created.status).toBe(201);
      const revisionId = Number(created.body.id);
      expect((await agent.post(`/api/stock-transfer-revisions/${revisionId}/approve`)).status).toBe(200);
      const [revision] = await outbox("stock.transfer-revision.v1");
      expect(revision).toMatchObject({
        localRevisionId: revisionId,
        transfer: { origin: "cloud", transferId: transfer.id },
      });
      const [review] = await outbox("stock.transfer-revision-review.v1");
      expect(review).toMatchObject({
        decision: "approve",
        reason: null,
        revision: { origin: "lan", localRevisionId: revisionId },
      });
    } finally {
      edge.config = CLOUD;
    }
  });
});

describe("Cloud replay of transfer changes", () => {
  it("applies an edit while the cloud copy matches, holds it when it changed, and applies it once approved", async () => {
    const transfer = await createTransfer(4);
    await inRolledBackTx(async (client) => {
      const applied = await replay(
        client,
        phase9StockTransferEditApplyHandler as Handler,
        editEvent({ origin: "cloud", transferId: transfer.id }, snapshot(4), 8)
      );
      expect(applied).toMatchObject({ outcome: "cloud-applied", cloudRef: transfer.id });
      // The cloud now holds 8; an edit made against 4 is held.
      const stale = editEvent({ origin: "cloud", transferId: transfer.id }, snapshot(4), 2);
      expect(await conflictCode(replay(client, phase9StockTransferEditApplyHandler as Handler, stale))).toBe(
        PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT
      );
      expect(phase9OverridableConflicts("stock", stale.kind)).toContain(PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT);
      const approved = await replay(client, phase9StockTransferEditApplyHandler as Handler, stale, [
        PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT,
      ]);
      expect(approved.outcome).toBe("cloud-applied");
    });
  });

  it("finds a transfer created offline through its create's receipt; a rejected create makes the change reject-only", async () => {
    const transfer = await createTransfer(4);
    await inRolledBackTx(async (client) => {
      await markApplied(client, "stock.transfer.v1", 777_001, transfer.id);
      const viaLan = editEvent({ origin: "lan", localTransferId: 777_001 }, snapshot(4), 5);
      expect((await replay(client, phase9StockTransferEditApplyHandler as Handler, viaLan)).cloudRef).toBe(transfer.id);

      await markApplied(client, "stock.transfer.v1", 777_002, null);
      const orphan = editEvent({ origin: "lan", localTransferId: 777_002 }, snapshot(4), 5);
      expect(await conflictCode(replay(client, phase9StockTransferEditApplyHandler as Handler, orphan))).toBe(
        "PHASE9_STOCK_TRANSFER_MISSING"
      );
    });
  });

  it("finalizes a draft once; a second finalize is already present", async () => {
    const draft = await createTransfer(3, true);
    await inRolledBackTx(async (client) => {
      const make = () => {
        const payload = phase9StockTransferFinalizeEnvelope({
          ...actor(),
          localEditId: 9500 + seq,
          transfer: { origin: "cloud", transferId: draft.id },
          before: snapshot(3, { optional: true, inventoryApplied: false }),
        });
        return wrap(payload, payload.localEditId);
      };
      expect((await replay(client, phase9StockTransferFinalizeApplyHandler as Handler, make())).outcome).toBe(
        "cloud-applied"
      );
      expect((await replay(client, phase9StockTransferFinalizeApplyHandler as Handler, make())).outcome).toBe(
        "already-present"
      );
    });
  });

  it("replays a revision and its approval (the approval names the LAN revision); a stale revision is reject-only", async () => {
    const transfer = await createTransfer(5);
    const name = (await pool.query("SELECT name FROM stock_items WHERE id = $1", [ctx.stockItemIds[0]])).rows[0].name;
    const revisionEvent = (localRevisionId: number, originalQuantity: number) => {
      const payload = phase9StockTransferRevisionEnvelope({
        ...actor(),
        localRevisionId,
        transfer: { origin: "cloud", transferId: transfer.id },
        revision: {
          note: "cloud replay",
          pending: true,
          sourceLocationIdLimit: null,
          items: [
            {
              stockItemId: ctx.stockItemIds[0],
              stockItemName: name,
              sourceLocationId: ctx.locationId,
              sourceLocationName: null,
              originalQuantity,
              newQuantity: 9,
            },
          ],
        },
      });
      return wrap(payload, payload.localRevisionId);
    };
    await inRolledBackTx(async (client) => {
      const created = await replay(
        client,
        phase9StockTransferRevisionApplyHandler as Handler,
        revisionEvent(888_001, 5)
      );
      await markApplied(client, "stock.transfer-revision.v1", 888_001, created.cloudRef);
      const reviewPayload = phase9StockTransferRevisionReviewEnvelope({
        ...actor(),
        localEditId: 9900 + seq,
        revision: { origin: "lan", localRevisionId: 888_001 },
        decision: "approve",
        reason: null,
      });
      const review = wrap(reviewPayload, reviewPayload.localEditId);
      const approved = await replay(client, phase9StockTransferRevisionReviewApplyHandler as Handler, review);
      expect(approved).toMatchObject({ outcome: "cloud-applied", cloudRef: created.cloudRef });

      const stale = revisionEvent(888_002, 1);
      expect(await conflictCode(replay(client, phase9StockTransferRevisionApplyHandler as Handler, stale))).toBe(
        PHASE9_STOCK_TRANSFER_CHANGED_CONFLICT
      );
      expect(phase9OverridableConflicts("stock", stale.kind)).toEqual([]);
    });
  });
});

describe("Excel transfer import on the factory LAN server (plan gate: 50 rows, replayed once)", () => {
  it("records a 50-row import as one ordinary offline transfer that the cloud replays without a second movement", async () => {
    const items = await pool.query("SELECT id, code FROM stock_items WHERE id = ANY($1::int[]) ORDER BY id", [
      ctx.stockItemIds,
    ]);
    const rows = Array.from({ length: 50 }, (_, index) => ({
      barcode: items.rows[index % items.rows.length].code,
      quantity: String((index % 5) + 1),
    }));
    edge.config = LAN;
    let recorded: Record<string, unknown>;
    try {
      const imported = await agent.post("/api/stock-transfer-import/import").send({
        sourceLocationId: ctx.locationId,
        destinationLocationId: ctx.location2Id,
        transferDate: new Date().toISOString().slice(0, 10),
        notes: "offline excel import",
        items: rows,
      });
      expect(imported.status).toBe(200);
      expect(imported.body.itemsCount).toBe(50);
      const transfers = await outbox("stock.transfer.v1");
      recorded = transfers[transfers.length - 1];
      expect(recorded.notes).toBe("offline excel import");
    } finally {
      edge.config = CLOUD;
    }
    const localTransferId = Number(recorded.localTransferId);
    // A second movement would change the destination's stock; the replay must leave it as is.
    const movements = async () =>
      Number(
        (
          await pool.query(
            "SELECT COALESCE(sum(quantity), 0)::numeric AS q FROM inventory WHERE location_id = $1 AND stock_item_id = ANY($2::int[])",
            [ctx.location2Id, ctx.stockItemIds]
          )
        ).rows[0].q
      );
    const before = await movements();
    expect(before).toBeGreaterThan(0);
    // Same database stands in for the cloud: the replay finds the transfer by its LAN request id.
    await inRolledBackTx(async (client) => {
      const event = wrap(recorded as { kind: string; requestId: string }, localTransferId);
      const result = await replay(client, phase9StockTransferApplyHandler as unknown as Handler, event);
      expect(result).toMatchObject({ outcome: "already-present", cloudRef: localTransferId });
      expect(await movements()).toBe(before);
    });
  });
});
