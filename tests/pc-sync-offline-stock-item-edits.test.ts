/**
 * Full offline mode: stock item master edits and deletes made on a PC while
 * offline.
 *
 * The PC records exactly what the factory LAN server records (whitelisted
 * fields "before -> after", or the delete of an unused item) and writes the
 * finished envelope to pc_local.outbox in the change's own transaction. The
 * cloud accepts it only from the PC route, only for the signed-in person and
 * company, translates items the PC created to their cloud items, and applies
 * it through the existing exactly-once handlers. Proves: an edit applies once;
 * an edit of a field that changed in the cloud is held instead of
 * overwriting; a delete of an unused item applies; envelopes on the browser
 * route are refused; the PC writes the envelope in the change's transaction;
 * the guard lets the stock item routes through only in entry mode; and an
 * item made on the PC can be edited on the PC and delivered in order.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import express from "express";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type DbTransaction } from "../server/db";
import { makePcLocalReadOnlyGuard } from "../server/offline/pcLocal/localReadOnlyGuard";
import { capturePhase9StockItemDeleteTx, capturePhase9StockItemEditTx } from "../server/edge/phase9StockOutbox";
import { stockItemEditRecorder } from "../server/services/inventory/stockItemEditCapture";
import { phase9StockItemEditEnvelope } from "../server/edge/phase9StockItemEditEnvelope.mjs";
import { phase9StockItemDeleteEnvelope } from "../server/edge/phase9StockItemLifecycleEnvelope.mjs";
import { loadPcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { prepareLocalDatabase } from "../scripts/pc-sync/local/localStore.mjs";
import { deliverOutbox, deliveryDeviceId } from "../scripts/pc-sync/local/outbox.mjs";
import { applyMigrations, databaseUrlFor } from "./helpers/migrateDisposableDatabase.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `pcitem_${Date.now()}`;
const DEVICE = randomUUID();
const EDIT_KIND = "stock.item-edit.v1";
const DELETE_KIND = "stock.item-delete.v1";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let deliveryDevice: string | null = null;
let codeSeq = 0;

function body(kind: string, envelope: unknown, ref: number, operationId: string) {
  return { deviceId: DEVICE, operationId, kind, localRef: ref, capturedAt: new Date().toISOString(), envelope };
}

function actor(requestId: string) {
  return {
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    requestId,
    businessDate: new Date().toISOString().slice(0, 10),
  };
}

async function cloudItem(name = "Cloud Item"): Promise<{ id: number; code: string }> {
  codeSeq += 1;
  const code = `${PREFIX}-${codeSeq}`.slice(0, 50);
  const { rows } = await pool.query(
    `INSERT INTO stock_items (company_id, code, name, uom, stock_group_id, active)
     VALUES ($1, $2, $3, 'pcs', $4, true) RETURNING id`,
    [ctx.companyId, code, name, ctx.stockGroupId]
  );
  return { id: Number(rows[0].id), code };
}

async function itemRow(id: number) {
  const { rows } = await pool.query("SELECT name, deleted_at FROM stock_items WHERE id = $1", [id]);
  return rows[0] as { name: string; deleted_at: Date | null } | undefined;
}

function renameEnvelope(
  operationId: string,
  ref: number,
  item: { id: number; code: string },
  from: string,
  to: string
) {
  return phase9StockItemEditEnvelope({
    ...actor(operationId),
    localEditId: ref,
    route: "PATCH /api/stock-items/:id",
    changes: [{ target: "item", stockItemId: item.id, code: item.code, field: "name", before: from, after: to }],
  });
}

beforeAll(async () => {
  process.env.OFFLINE_PC_SYNC_ENABLED = "1";
  process.env.OFFLINE_BROWSER_SYNC_ENABLED = "1";
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  delete process.env.OFFLINE_PC_SYNC_ENABLED;
  delete process.env.OFFLINE_BROWSER_SYNC_ENABLED;
  delete process.env.OFFLINE_PC_LOCAL_MODE;
  for (const table of ["factory_edge_applied_events", "factory_edge_stock_item_map"]) {
    await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await pool.query(`DELETE FROM ${table} WHERE site_id = ANY($1::uuid[])`, [[DEVICE, deliveryDevice ?? DEVICE]]);
    await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("PC offline stock item edits and deletes: in the cloud", () => {
  it("applies an edit once, and holds one whose field changed in the cloud", async () => {
    const item = await cloudItem("Blue Bag");
    const operationId = randomUUID();
    const sent = body(
      EDIT_KIND,
      renameEnvelope(operationId, 1_900_000_101, item, "Blue Bag", "Blue Bag XL"),
      1_900_000_101,
      operationId
    );
    const first = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await itemRow(item.id))?.name).toBe("Blue Bag XL");
    const again = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true });

    // The PC still thinks the name is "Blue Bag": the cloud's newer name is kept.
    const staleId = randomUUID();
    const held = await agent
      .post("/api/offline/pc-sync/operations")
      .send(
        body(EDIT_KIND, renameEnvelope(staleId, 1_900_000_102, item, "Blue Bag", "Blue Bag S"), 1_900_000_102, staleId)
      );
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({ code: "PHASE9_STOCK_ITEM_CHANGED", overridable: true });
    expect((await itemRow(item.id))?.name).toBe("Blue Bag XL");
  });

  it("deletes an unused item, and refuses envelopes on the browser route", async () => {
    const item = await cloudItem("Unused");
    const operationId = randomUUID();
    const envelope = phase9StockItemDeleteEnvelope({ ...actor(operationId), stockItemId: item.id, code: item.code });
    const sent = body(DELETE_KIND, envelope, item.id, operationId);
    const browser = await agent.post("/api/offline/browser-sync/operations").send(sent);
    expect(browser.status).toBe(422);
    expect((await itemRow(item.id))?.deleted_at).toBeNull();

    const res = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await itemRow(item.id))?.deleted_at).not.toBeNull();
  });

  it("refuses an envelope that names another person", async () => {
    const item = await cloudItem("Mine");
    const operationId = randomUUID();
    const envelope = {
      ...renameEnvelope(operationId, 1_900_000_103, item, "Mine", "Theirs"),
      actorUsername: "someone",
    };
    const res = await agent
      .post("/api/offline/pc-sync/operations")
      .send(body(EDIT_KIND, envelope, 1_900_000_103, operationId));
    expect(res.status).toBe(422);
    expect((await itemRow(item.id))?.name).toBe("Mine");
  });
});

describe("PC offline stock item edits and deletes: on the PC", () => {
  let admin: Client;
  let local: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS pcsync_local_items_test WITH (FORCE)");
    await admin.query("CREATE DATABASE pcsync_local_items_test");
    const url = databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_items_test");
    applyMigrations(url);
    local = new Client({ connectionString: url, ssl: false });
    await local.connect();
    await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
  }, 120_000);

  afterAll(async () => {
    delete process.env.OFFLINE_PC_LOCAL_MODE;
    await local?.end().catch(() => undefined);
    await admin?.query("DROP DATABASE IF EXISTS pcsync_local_items_test WITH (FORCE)").catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("records edits and deletes as finished envelopes in the change's own transaction", async () => {
    process.env.OFFLINE_PC_LOCAL_MODE = "entry";
    try {
      expect(stockItemEditRecorder("PATCH /api/stock-items/:id").active).toBe(true);
      const pcDb = drizzle(local);
      const editId = randomUUID();
      const deleteId = randomUUID();
      await pcDb.transaction(async (tx) => {
        await capturePhase9StockItemEditTx(tx as unknown as DbTransaction, {
          ...actor(editId),
          route: "PATCH /api/stock-items/:id",
          changes: [{ target: "item", stockItemId: 77, code: "C-77", field: "name", before: "A", after: "B" }],
        });
        await capturePhase9StockItemDeleteTx(tx as unknown as DbTransaction, {
          ...actor(deleteId),
          stockItemId: 78,
          code: "C-78",
        });
      });
      const rows = await local.query(
        "SELECT operation_id, kind, status, local_ref, envelope FROM pc_local.outbox WHERE operation_id = ANY($1::uuid[]) ORDER BY kind",
        [[editId, deleteId]]
      );
      expect(rows.rows.map((r) => [r.kind, r.status])).toEqual([
        [DELETE_KIND, "pending"],
        [EDIT_KIND, "pending"],
      ]);
      expect(rows.rows[0].local_ref).toBe(78);
      expect(rows.rows[1].local_ref).toBeGreaterThanOrEqual(1_900_000_000);
      expect(rows.rows[1].envelope.localEditId).toBe(rows.rows[1].local_ref);

      const rolledBack = randomUUID();
      await expect(
        pcDb.transaction(async (tx) => {
          await capturePhase9StockItemDeleteTx(tx as unknown as DbTransaction, {
            ...actor(rolledBack),
            stockItemId: 79,
            code: "C-79",
          });
          throw new Error("the change failed");
        })
      ).rejects.toThrow("the change failed");
      const gone = await local.query("SELECT 1 FROM pc_local.outbox WHERE operation_id = $1", [rolledBack]);
      expect(gone.rowCount).toBe(0);
    } finally {
      delete process.env.OFFLINE_PC_LOCAL_MODE;
    }
    expect(stockItemEditRecorder("PATCH /api/stock-items/:id").active).toBe(false);
  });

  it("lets the stock item routes through only in entry mode", async () => {
    await local.query("UPDATE pc_local.state SET copy_complete = true, last_sync_at = now()");
    const connect = async () => ({
      query: (text: string, values?: unknown[]) => local.query(text, values as unknown[]),
      release: () => undefined,
    });
    const build = (mode: string) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { session: Record<string, unknown> }).session = { userId: "u1", currentCompanyId: 1 };
        next();
      });
      app.use(makePcLocalReadOnlyGuard({ OFFLINE_PC_LOCAL_MODE: mode }, connect));
      app.patch("/api/stock-items/:id", (_req, res) => res.json({ ok: true }));
      app.delete("/api/stock-items/:id", (_req, res) => res.json({ ok: true }));
      app.post("/api/stock-items/bulk-update-prices", (_req, res) => res.json({ ok: true }));
      app.post("/api/stock-items/:id/location-prices", (_req, res) => res.json({ ok: true }));
      app.post("/api/stock-items/merge", (_req, res) => res.json({ ok: true }));
      return app;
    };
    const entry = build("entry");
    expect((await request(entry).patch("/api/stock-items/5").send({})).status).toBe(200);
    expect((await request(entry).delete("/api/stock-items/5")).status).toBe(200);
    expect((await request(entry).post("/api/stock-items/bulk-update-prices").send({})).status).toBe(200);
    expect((await request(entry).post("/api/stock-items/5/location-prices").send({})).status).toBe(200);
    // Not something the cloud can replay.
    expect((await request(entry).post("/api/stock-items/merge").send({})).status).toBe(423);
    // Nothing is queued by the guard: the route writes its own envelope.
    const queued = await local.query("SELECT count(*)::int AS n FROM pc_local.outbox WHERE envelope IS NULL");
    expect(queued.rows[0].n).toBe(0);
    expect((await request(build("read-only")).patch("/api/stock-items/5").send({})).status).toBe(423);
  });

  it("delivers an item made on the PC, then its edit, translated to the cloud item", async () => {
    const state = await local.query("UPDATE pc_local.state SET cloud_user_id = $1 RETURNING device_id", [ctx.userId]);
    deliveryDevice = deliveryDeviceId(state.rows[0].device_id, ctx.userId, ctx.companyId);
    await local.query("DELETE FROM pc_local.outbox");
    const cloud = {
      get: async (path: string, query?: Record<string, unknown>) => {
        const res = await agent.get(path).query(query ?? {});
        return { status: res.status, body: res.body };
      },
      post: async (path: string, payload?: unknown) => {
        const res = await agent.post(path).send((payload ?? {}) as object);
        return { status: res.status, body: res.body };
      },
    };
    const madeHere = 1_000_000_950;
    const code = `${PREFIX}-PC`.slice(0, 50);
    await local.query(
      `INSERT INTO pc_local.outbox (operation_id, kind, input, local_ref, user_id, company_id, status)
       VALUES (gen_random_uuid(), 'stock.item-create.v1', $1::jsonb, $2, $3, $4, 'pending')`,
      [
        JSON.stringify({ code, name: "Made on PC", uom: "pcs", stockGroupId: ctx.stockGroupId }),
        madeHere,
        ctx.userId,
        ctx.companyId,
      ]
    );
    expect(await deliverOutbox(local, cloud)).toMatchObject({ applied: 1 });
    const created = await local.query("SELECT receipt FROM pc_local.outbox WHERE local_ref = $1", [madeHere]);
    const cloudId = Number(created.rows[0].receipt.cloudRef);

    const editId = randomUUID();
    const envelope = renameEnvelope(editId, 1_900_000_500, { id: madeHere, code }, "Made on PC", "Renamed on PC");
    await local.query(
      `INSERT INTO pc_local.outbox (operation_id, kind, input, envelope, local_ref, user_id, company_id, status)
       VALUES ($1::uuid, $2, '{}'::jsonb, $3::jsonb, $4, $5, $6, 'pending')`,
      [editId, EDIT_KIND, JSON.stringify(envelope), 1_900_000_500, ctx.userId, ctx.companyId]
    );
    expect(await deliverOutbox(local, cloud)).toMatchObject({ applied: 1, conflicts: 0, refused: 0 });
    expect((await itemRow(cloudId))?.name).toBe("Renamed on PC");
  });
});
