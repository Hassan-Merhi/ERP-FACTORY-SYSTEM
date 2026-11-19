/**
 * Full offline mode: stock transfer edits, finalizes and revisions made on a
 * PC while offline.
 *
 * The PC records exactly what the factory LAN server records (the transfer as
 * it stood, and the change) and writes the finished envelope to
 * pc_local.outbox in the change's own transaction. A transfer made on the PC
 * keeps its local id as its reference, so a later change naming it resolves
 * in the cloud. Proves: the cloud applies an edit of a transfer the PC made,
 * once; envelopes on the browser route are refused; the PC writes these
 * envelopes in the change's transaction and names its own transfers and
 * revisions by their local ids; the guard opens the transfer routes only in
 * entry mode, refuses finalizing anything but a transfer, and keeps a new
 * transfer's own id as its reference.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import express from "express";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, pool, type DbTransaction } from "../server/db";
import { makePcLocalReadOnlyGuard } from "../server/offline/pcLocal/localReadOnlyGuard";
import {
  capturePhase9StockTransferFinalizeTx,
  capturePhase9StockTransferRevisionTx,
  phase9RevisionRefTx,
  phase9TransferRefTx,
  phase9TransferSnapshotTx,
} from "../server/edge/phase9StockOutbox";
import { phase9StockTransferEditEnvelope } from "../server/edge/phase9StockTransferWorkflowEnvelope.mjs";
import { loadPcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { prepareLocalDatabase } from "../scripts/pc-sync/local/localStore.mjs";
import { applyMigrations, databaseUrlFor } from "./helpers/migrateDisposableDatabase.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `pcxfer_${Date.now()}`;
const DEVICE = randomUUID();
const EDIT_KIND = "stock.transfer-edit.v1";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

function actor(requestId: string) {
  return {
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    requestId,
    businessDate: new Date().toISOString().slice(0, 10),
  };
}

function body(kind: string, part: { input?: unknown; envelope?: unknown }, ref: number, operationId = randomUUID()) {
  return { deviceId: DEVICE, operationId, kind, localRef: ref, capturedAt: new Date().toISOString(), ...part };
}

async function transferQuantity(transferId: number): Promise<number> {
  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(quantity::numeric), 0) AS q FROM stock_transfer_items WHERE transfer_id = $1",
    [transferId]
  );
  return Number(rows[0].q);
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
  for (const table of ["offline_negative_stock_flags", "factory_edge_applied_events"]) {
    const column = table === "offline_negative_stock_flags" ? "device_id" : "site_id";
    await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await pool.query(`DELETE FROM ${table} WHERE ${column} = $1::uuid`, [DEVICE]);
    await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("PC offline transfer changes: in the cloud", () => {
  it("applies an edit of a transfer the PC made, once, and refuses it on the browser route", async () => {
    const madeHere = 1_000_000_700;
    const created = await agent.post("/api/offline/pc-sync/operations").send(
      body(
        "stock.transfer.v1",
        {
          input: {
            sourceLocationId: ctx.locationId,
            destinationLocationId: ctx.location2Id,
            items: [{ stockItemId: ctx.stockItemIds[0], quantity: 2, sourceLocationId: ctx.locationId }],
            notes: "Moved on the PC",
            optional: true,
          },
        },
        madeHere
      )
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const cloudTransfer = Number(created.body.cloudRef);
    const before = await db.transaction((tx) =>
      phase9TransferSnapshotTx(tx as DbTransaction, ctx.companyId, cloudTransfer)
    );
    expect(before).not.toBeNull();

    const operationId = randomUUID();
    const localEditId = 1_900_000_701;
    const envelope = phase9StockTransferEditEnvelope({
      ...actor(operationId),
      localEditId,
      transfer: { origin: "lan", localTransferId: madeHere },
      before: before!,
      after: {
        destinationLocationId: ctx.location2Id,
        notes: "Edited on the PC",
        items: [{ stockItemId: ctx.stockItemIds[0], sourceLocationId: ctx.locationId, quantity: 3, rate: 0 }],
      },
    });
    const sent = body(EDIT_KIND, { envelope }, localEditId, operationId);
    const browser = await agent.post("/api/offline/browser-sync/operations").send(sent);
    expect(browser.status).toBe(400); // the route's request schema has no envelope field

    const first = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await transferQuantity(cloudTransfer)).toBe(3);
    const again = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true });
    expect(await transferQuantity(cloudTransfer)).toBe(3);
  });
});

describe("PC offline transfer changes: on the PC", () => {
  let admin: Client;
  let local: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS pcsync_local_xfer_test WITH (FORCE)");
    await admin.query("CREATE DATABASE pcsync_local_xfer_test");
    const url = databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_xfer_test");
    applyMigrations(url);
    local = new Client({ connectionString: url, ssl: false });
    await local.connect();
    await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
  }, 120_000);

  afterAll(async () => {
    delete process.env.OFFLINE_PC_LOCAL_MODE;
    await local?.end().catch(() => undefined);
    await admin?.query("DROP DATABASE IF EXISTS pcsync_local_xfer_test WITH (FORCE)").catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("names its own transfers and revisions by local id, and records changes in the change's transaction", async () => {
    process.env.OFFLINE_PC_LOCAL_MODE = "entry";
    try {
      const pcDb = drizzle(local);
      await pcDb.transaction(async (tx) => {
        const t = tx as unknown as DbTransaction;
        expect(await phase9TransferRefTx(t, 1_000_000_123)).toEqual({ origin: "lan", localTransferId: 1_000_000_123 });
        expect(await phase9TransferRefTx(t, 55)).toEqual({ origin: "cloud", transferId: 55 });
        expect(await phase9RevisionRefTx(t, 1_000_000_124)).toEqual({ origin: "lan", localRevisionId: 1_000_000_124 });
        expect(await phase9RevisionRefTx(t, 56)).toEqual({ origin: "cloud", revisionId: 56 });
      });

      const finalizeId = randomUUID();
      const revisionId = randomUUID();
      const before = {
        destinationLocationId: 2,
        optional: true,
        inventoryApplied: false,
        lines: [{ stockItemId: 7, sourceLocationId: 1, quantity: "3.000" }],
      };
      await pcDb.transaction(async (tx) => {
        const t = tx as unknown as DbTransaction;
        await capturePhase9StockTransferFinalizeTx(t, {
          ...actor(finalizeId),
          transfer: { origin: "lan", localTransferId: 1_000_000_123 },
          before,
        });
        await capturePhase9StockTransferRevisionTx(t, {
          ...actor(revisionId),
          localRevisionId: 1_000_000_124,
          transfer: { origin: "cloud", transferId: 55 },
          revision: {
            note: null,
            pending: true,
            sourceLocationIdLimit: null,
            items: [
              {
                stockItemId: 7,
                stockItemName: "Item 7",
                sourceLocationId: 1,
                sourceLocationName: null,
                originalQuantity: 3,
                newQuantity: 2,
              },
            ],
          },
        });
      });
      const rows = await local.query(
        "SELECT kind, status, local_ref FROM pc_local.outbox WHERE operation_id = ANY($1::uuid[]) ORDER BY kind",
        [[finalizeId, revisionId]]
      );
      expect(rows.rows.map((r) => [r.kind, r.status])).toEqual([
        ["stock.transfer-finalize.v1", "pending"],
        ["stock.transfer-revision.v1", "pending"],
      ]);
      expect(rows.rows[0].local_ref).toBeGreaterThanOrEqual(1_900_000_000);
      expect(rows.rows[1].local_ref).toBe(1_000_000_124);
    } finally {
      delete process.env.OFFLINE_PC_LOCAL_MODE;
    }
  });

  it("opens the transfer routes only in entry mode, and keeps a new transfer's own id", async () => {
    await local.query("UPDATE pc_local.state SET copy_complete = true, last_sync_at = now()");
    await local.query(`BEGIN; SET LOCAL session_replication_role = replica;
      INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, voucher_date, total_amount)
      VALUES (191, 1, 'J-191', 'Journal', '2026-11-19', 0), (192, 1, 'T-192', 'Stock Transfer', '2026-11-19', 0);
      COMMIT;`);
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
      const ok = (_req: express.Request, res: express.Response) => res.json({ ok: true });
      app.put("/api/stock-transfers/:id", ok);
      app.post("/api/stock-transfers/:id/approve", ok);
      app.post("/api/stock-transfers/:id/revisions", ok);
      app.post("/api/stock-transfer-revisions/:id/approve", ok);
      app.post("/api/stock-transfer-revisions/:id/reject", ok);
      app.post("/api/vouchers/:id/finalize", ok);
      app.post("/api/stock-transfers", (_req, res) =>
        res.status(201).json({ transfer: { id: 1_000_000_321 }, voucher: { id: 1_000_000_999 } })
      );
      return app;
    };
    const entry = build("entry");
    expect((await request(entry).put("/api/stock-transfers/5").send({})).status).toBe(200);
    expect((await request(entry).post("/api/stock-transfers/5/approve")).status).toBe(200);
    expect((await request(entry).post("/api/stock-transfers/5/revisions").send({})).status).toBe(200);
    expect((await request(entry).post("/api/stock-transfer-revisions/5/approve")).status).toBe(200);
    expect((await request(entry).post("/api/stock-transfer-revisions/5/reject").send({})).status).toBe(200);
    expect((await request(entry).post("/api/vouchers/192/finalize")).status).toBe(200);
    const journal = await request(entry).post("/api/vouchers/191/finalize");
    expect(journal.status).toBe(423);
    expect(journal.body).toEqual({ code: "OFFLINE_PC_LOCAL_CHANGE_NOT_SUPPORTED" });

    const created = await request(entry)
      .post("/api/stock-transfers")
      .send({ sourceLocationId: 1, destinationLocationId: 2, items: [] });
    expect(created.status).toBe(201);
    // The guard settles the entry after the answer is sent.
    let row: { local_ref: number; status: string } | undefined;
    for (let i = 0; i < 20 && row?.status !== "pending"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      row = (await local.query("SELECT local_ref, status FROM pc_local.outbox WHERE kind = 'stock.transfer.v1'"))
        .rows[0];
    }
    expect(row).toMatchObject({ status: "pending", local_ref: 1_000_000_321 });

    expect((await request(build("read-only")).put("/api/stock-transfers/5").send({})).status).toBe(423);
  });
});
