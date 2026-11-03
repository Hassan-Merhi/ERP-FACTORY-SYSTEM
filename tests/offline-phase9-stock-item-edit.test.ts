/**
 * Phase 9 offline stock-item master edits (stock.item-edit.v1, owner decision
 * 2026-11-02) on the full application schema: the factory LAN capture through
 * the bulk-edit, import and single-item routes (same transaction, immutable
 * outbox, cloud-only fields refused) and the cloud replay field by field, with
 * a field the cloud changed meanwhile held for an Admin/Developer decision.
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
import {
  phase9StockItemEditEnvelope,
  type Phase9StockItemChange,
} from "../server/edge/phase9StockItemEditEnvelope.mjs";
import {
  phase9StockItemEditApplyHandler,
  type Phase9StockItemEditEvent,
} from "../server/edge/phase9StockItemEditApply";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, setupTestApp, type TestContext } from "./setup";

const PREFIX = "p9item";
const SITE = randomUUID();
let ctx: TestContext;
let codes: string[];

const LAN = { mode: "lan", primary: true, siteId: SITE, writeMode: "lan-primary" };
const CLOUD = { mode: "cloud", primary: false, siteId: null, writeMode: "cloud" };

function editEvent(sequence: number, changes: Phase9StockItemChange[]): Phase9StockItemEditEvent {
  const requestId = randomUUID();
  const payload = phase9StockItemEditEnvelope({
    companyId: ctx.companyId,
    localEditId: 7000 + sequence,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    requestId,
    businessDate: "2026-11-02",
    route: "POST /api/stock-items/bulk-update-prices",
    changes,
  });
  const event = {
    sequence: String(sequence),
    operationId: requestId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    kind: payload.kind,
    localRef: payload.localEditId,
    payload,
    payloadSha256: hashEvidence(payload),
  };
  validatePhase9Event("stock", event);
  return event as unknown as Phase9StockItemEditEvent;
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

async function replay(client: PoolClient, event: Phase9StockItemEditEvent, overrideConflicts: string[] = []) {
  await phase9StockItemEditApplyHandler.authorize(client, event);
  const result = await phase9StockItemEditApplyHandler.apply(client, event, { overrideConflicts });
  expect(await phase9StockItemEditApplyHandler.verify(client, event, result)).toBe(true);
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

async function outboxSince(sequence: number) {
  const rows = await pool.query(
    `SELECT sequence::int AS sequence, operation_kind, payload FROM factory_edge_stock_outbox
      WHERE site_id = $1 AND sequence > $2 ORDER BY sequence`,
    [SITE, sequence]
  );
  return rows.rows as Array<{ sequence: number; operation_kind: string; payload: Record<string, unknown> }>;
}

async function lastSequence(): Promise<number> {
  const row = await pool.query("SELECT last_sequence::int AS n FROM factory_edge_stock_counter WHERE site_id = $1", [
    SITE,
  ]);
  return Number(row.rows[0]?.n ?? 0);
}

async function asLan<T>(run: () => Promise<T>): Promise<T> {
  edge.config = LAN;
  try {
    return await run();
  } finally {
    edge.config = CLOUD;
  }
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  const agent = request.agent(await setupTestApp());
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  ctx.agent = agent;
  const items = await pool.query("SELECT id, code FROM stock_items WHERE id = ANY($1::int[]) ORDER BY id", [
    ctx.stockItemIds,
  ]);
  const byId = new Map(items.rows.map((row) => [Number(row.id), String(row.code)]));
  codes = ctx.stockItemIds.map((id) => byId.get(id)!);
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

describe("Phase 9 offline stock-item edits on the factory LAN server", () => {
  it("records a bulk price update (item and location prices) in the same transaction", async () => {
    const since = await lastSequence();
    const response = await asLan(() =>
      ctx.agent.post("/api/stock-items/bulk-update-prices").send({
        prices: [
          { barcode: codes[0], sellingPrice: "55.5" },
          { barcode: codes[1], sellingPrice: "12", locationId: ctx.location2Id },
        ],
      })
    );
    expect(response.status).toBe(200);
    const [row, ...rest] = await outboxSince(since);
    expect(rest).toHaveLength(0);
    expect(row.operation_kind).toBe("stock.item-edit.v1");
    expect(row.payload).toMatchObject({
      route: "POST /api/stock-items/bulk-update-prices",
      localEditId: row.sequence,
      changes: [
        { target: "item", stockItemId: ctx.stockItemIds[0], code: codes[0], field: "sellingPrice", after: "55.5" },
        {
          target: "location-price",
          stockItemId: ctx.stockItemIds[1],
          locationId: ctx.location2Id,
          field: "sellingPrice",
          before: null,
          after: "12",
        },
      ],
    });
    // The cloud already holding these values (a lost ACK) is already-present.
    const event = {
      sequence: String(row.sequence),
      operationId: String(row.payload.requestId),
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      kind: row.operation_kind,
      localRef: row.sequence,
      payload: row.payload,
      payloadSha256: hashEvidence(row.payload),
    };
    validatePhase9Event("stock", event);
    await inRolledBackTx(async (client) => {
      expect(await replay(client, event as unknown as Phase9StockItemEditEvent)).toMatchObject({
        outcome: "already-present",
      });
    });
  });

  it("records a single-item edit, a barcode import and a rename import; refuses a code change", async () => {
    const since = await lastSequence();
    const refused = await asLan(() =>
      ctx.agent.patch(`/api/stock-items/${ctx.stockItemIds[2]}`).send({ code: `${codes[2]}-X` })
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("EDGE_PHASE9_STOCK_ITEM_FIELD_CLOUD_ONLY");
    // The form re-sends the unchanged code with the new name: accepted.
    const patched = await asLan(() =>
      ctx.agent.patch(`/api/stock-items/${ctx.stockItemIds[2]}`).send({ code: codes[2], name: "Offline name" })
    );
    expect(patched.status).toBe(200);
    const barcode = `${PREFIX}-${Date.now()}`;
    const barcodes = await asLan(() =>
      ctx.agent.post("/api/stock-items/import-barcodes").send({ rows: [{ itemCode: codes[0], barcode }] })
    );
    expect(barcodes.body).toMatchObject({ imported: 1 });
    const renamed = await asLan(() =>
      ctx.agent
        .post("/api/stock-items/update-names-by-code")
        .send({ rows: [{ code: codes[1], newName: "Renamed offline" }] })
    );
    expect(renamed.status).toBe(200);
    const rows = await outboxSince(since);
    expect(rows.map((row) => row.payload.route)).toEqual([
      "PATCH /api/stock-items/:id",
      "POST /api/stock-items/import-barcodes",
      "POST /api/stock-items/update-names-by-code",
    ]);
    expect(rows[0].payload.changes).toEqual([
      expect.objectContaining({ field: "name", after: "Offline name", stockItemId: ctx.stockItemIds[2] }),
    ]);
    expect(rows[1].payload.changes).toEqual([
      expect.objectContaining({ target: "alias", field: "aliasCode", before: null, after: barcode }),
    ]);
  });
});

describe("Phase 9 cloud replay of stock-item edits", () => {
  it("applies a change whose cloud value is still the LAN's before value", async () => {
    await inRolledBackTx(async (client) => {
      const current = await client.query("SELECT name FROM stock_items WHERE id = $1", [ctx.stockItemIds[0]]);
      const event = editEvent(1, [
        {
          target: "item",
          stockItemId: ctx.stockItemIds[0],
          code: codes[0],
          field: "name",
          before: String(current.rows[0].name),
          after: "Cloud gets LAN name",
        },
        {
          target: "location-price",
          stockItemId: ctx.stockItemIds[0],
          code: codes[0],
          locationId: ctx.locationId,
          field: "sellingPrice",
          before: null,
          after: "9.75",
        },
      ]);
      expect(await replay(client, event)).toMatchObject({ outcome: "cloud-applied", cloudRef: ctx.stockItemIds[0] });
      const after = await client.query("SELECT name FROM stock_items WHERE id = $1", [ctx.stockItemIds[0]]);
      expect(after.rows[0].name).toBe("Cloud gets LAN name");
      expect(await replay(client, event)).toMatchObject({ outcome: "already-present" });
    });
  });

  it("holds a field the cloud changed meanwhile, and applies the LAN value only on approval", async () => {
    await inRolledBackTx(async (client) => {
      await client.query("UPDATE stock_items SET uom = 'CLOUD' WHERE id = $1", [ctx.stockItemIds[1]]);
      const event = editEvent(2, [
        { target: "item", stockItemId: ctx.stockItemIds[1], code: codes[1], field: "uom", before: "PCS", after: "BL" },
      ]);
      expect(await conflictCode(replay(client, event))).toBe("PHASE9_STOCK_ITEM_CHANGED");
      expect(await conflictCode(replay(client, event, ["PHASE9_STOCK_ITEM_MISSING"]))).toBe(
        "PHASE9_STOCK_ITEM_CHANGED"
      );
      await replay(client, event, ["PHASE9_STOCK_ITEM_CHANGED"]);
      const row = await client.query("SELECT uom FROM stock_items WHERE id = $1", [ctx.stockItemIds[1]]);
      expect(row.rows[0].uom).toBe("BL");
    });
  });

  it("refuses a re-coded item, a missing category and a barcode another item holds", async () => {
    await inRolledBackTx(async (client) => {
      const recoded = editEvent(3, [
        { target: "item", stockItemId: ctx.stockItemIds[0], code: "NOT-THIS", field: "uom", before: null, after: "BL" },
      ]);
      expect(await conflictCode(replay(client, recoded))).toBe("PHASE9_STOCK_ITEM_MISSING");
      const category = editEvent(4, [
        {
          target: "item",
          stockItemId: ctx.stockItemIds[0],
          code: codes[0],
          field: "categoryId",
          before: null,
          after: "2147480000",
        },
      ]);
      expect(await conflictCode(replay(client, category))).toBe("PHASE9_STOCK_ITEM_REFERENCE_MISSING");
      const alias = `${PREFIX}-taken-${Date.now()}`;
      await client.query(
        "INSERT INTO stock_item_code_aliases (company_id, stock_item_id, alias_code) VALUES ($1, $2, $3)",
        [ctx.companyId, ctx.stockItemIds[1], alias]
      );
      const taken = editEvent(5, [
        {
          target: "alias",
          stockItemId: ctx.stockItemIds[0],
          code: codes[0],
          field: "aliasCode",
          before: null,
          after: alias,
        },
      ]);
      expect(await conflictCode(replay(client, taken))).toBe("PHASE9_STOCK_ALIAS_TAKEN");
    });
  });

  it("refuses evidence outside the whitelist", () => {
    expect(() =>
      editEvent(6, [
        { target: "item", stockItemId: ctx.stockItemIds[0], code: codes[0], field: "code", before: "A", after: "B" },
      ])
    ).toThrow("PHASE9_STOCK_ITEM_EDIT_EVIDENCE_INVALID");
  });
});
