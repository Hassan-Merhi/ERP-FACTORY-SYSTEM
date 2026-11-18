/**
 * Full offline mode (Phase B): entries made on a PC while offline.
 *
 * The PC is a disposable database built from migrations/. Proves: the local
 * server records only the supported entries, and only after the local route
 * succeeded; new entries stop when the copy is 2 days old; the agent delivers
 * them to the cloud's exactly-once apply path as the connected person only,
 * keeps conflicts for Admin/Developer review, and once nothing is outstanding
 * undoes the PC's own writes and pulls the cloud's version.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { Client } from "pg";
import { pool } from "../server/db";
import { loadPcSyncPolicy, readPublicSchema, resolvePcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { readPrimaryKeys, renderChangeFeedInstallSql } from "../scripts/pc-sync/changeFeedSql.mjs";
import { prepareLocalDatabase } from "../scripts/pc-sync/local/localStore.mjs";
import { bindCloudAccount, syncOnce } from "../scripts/pc-sync/local/syncAgent.mjs";
import { deliverOutbox, outboxSummary, resolveConflict, syncCycle } from "../scripts/pc-sync/local/outbox.mjs";
import { makePcLocalReadOnlyGuard } from "../server/offline/pcLocal/localReadOnlyGuard";
import { applyMigrations, databaseUrlFor } from "./helpers/migrateDisposableDatabase.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `pcentry_${Date.now()}`;
const FEED_TABLES = ["companies", "locations", "vouchers", "users", "user_company_roles"];

let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let admin: Client;
let local: Client;

type Cloud = {
  get(path: string, query?: Record<string, unknown>): Promise<{ status: number; body: any }>;
  post(path: string, body?: unknown): Promise<{ status: number; body: any }>;
};
const cloud: Cloud = {
  async get(path, query) {
    const res = await agent.get(path).query(query ?? {});
    return { status: res.status, body: res.body };
  },
  async post(path, body) {
    const res = await agent.post(path).send((body ?? {}) as object);
    return { status: res.status, body: res.body };
  },
};

const localQuery = (text: string, values?: unknown[]) => local.query(text, values as unknown[]);

/** The local server's middleware in front of stand-ins for the live routes. */
function pcApp(mode: "entry" | "read-only", session: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = session;
    next();
  });
  app.use(makePcLocalReadOnlyGuard({ OFFLINE_PC_LOCAL_MODE: mode }, localQuery));
  app.post("/api/inventory/quick-adjust", (_req, res) => res.json({ ok: true }));
  app.post("/api/stock-items", (_req, res) => res.status(201).json({ id: 1_000_000_005 }));
  app.post("/api/pos/sales", (_req, res) => res.status(400).json({ message: "refused locally" }));
  app.post("/api/vouchers", (_req, res) => res.json({ ok: true }));
  return app;
}

async function quantity(stockItemId: number): Promise<number> {
  const row = await pool.query(
    "SELECT quantity::numeric AS q FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3",
    [ctx.companyId, ctx.locationId, stockItemId]
  );
  return Number(row.rows[0]?.q ?? 0);
}

beforeAll(async () => {
  process.env.OFFLINE_PC_SYNC_ENABLED = "1";
  process.env.OFFLINE_BROWSER_SYNC_ENABLED = "1";
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });

  const client = await pool.connect();
  try {
    const { rules, problems } = resolvePcSyncPolicy(loadPcSyncPolicy(), await readPublicSchema(client));
    expect(problems).toEqual([]);
    const subset = new Map(FEED_TABLES.map((table) => [table, rules.get(table)]));
    await client.query(renderChangeFeedInstallSql(subset, await readPrimaryKeys(client)));
  } finally {
    client.release();
  }

  admin = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await admin.connect();
  await admin.query("DROP DATABASE IF EXISTS pcsync_local_entries_test WITH (FORCE)");
  await admin.query("CREATE DATABASE pcsync_local_entries_test");
  const localUrl = databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_entries_test");
  applyMigrations(localUrl);
  local = new Client({ connectionString: localUrl, ssl: false });
  await local.connect();
  await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
  expect((await syncOnce(local, cloud)).upToDate).toBe(true);
}, 120_000);

afterAll(async () => {
  delete process.env.OFFLINE_PC_SYNC_ENABLED;
  delete process.env.OFFLINE_BROWSER_SYNC_ENABLED;
  const state = await local?.query("SELECT device_id FROM pc_local.state").catch(() => null);
  const device = state?.rows[0]?.device_id;
  await local?.end().catch(() => undefined);
  await admin?.query("DROP DATABASE IF EXISTS pcsync_local_entries_test WITH (FORCE)").catch(() => undefined);
  await admin?.end().catch(() => undefined);
  if (device) {
    for (const table of ["factory_edge_applied_events", "factory_edge_stock_item_map"]) {
      await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      await pool.query(`DELETE FROM ${table} WHERE site_id = $1`, [device]);
      await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
  }
  await pool.query("DROP SCHEMA IF EXISTS pc_sync CASCADE");
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("PC offline entries: recording on the PC", () => {
  const session = () => ({ userId: ctx.userId, currentCompanyId: ctx.companyId });

  it("records a supported entry only after the local route succeeded", async () => {
    const pc = request(pcApp("entry", session()));
    const ok = await pc
      .post("/api/inventory/quick-adjust")
      .send({ stockItemId: ctx.stockItemIds[0], locationId: ctx.locationId, quantity: "3", type: "add" });
    expect(ok.status).toBe(200);
    const created = await pc.post("/api/stock-items").send({ name: "x" });
    expect(created.status).toBe(201);
    expect((await pc.post("/api/pos/sales").send({})).status).toBe(400);

    await new Promise((resolve) => setTimeout(resolve, 100)); // the outbox update runs after the response
    const { rows } = await local.query("SELECT kind, status, local_ref, user_id FROM pc_local.outbox ORDER BY id");
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(rows[0].local_ref).toBeGreaterThanOrEqual(1_900_000_000);
    expect(rows[1].local_ref).toBe(1_000_000_005); // a new stock item keeps its own local id
    expect(rows.every((r) => r.user_id === ctx.userId)).toBe(true);
    await local.query("DELETE FROM pc_local.outbox WHERE local_ref = 1000000005");
  });

  it("refuses every other write, and every entry in read-only mode", async () => {
    const entry = request(pcApp("entry", session()));
    expect((await entry.post("/api/vouchers").send({})).body).toEqual({ code: "OFFLINE_PC_LOCAL_READ_ONLY" });
    const readOnly = request(pcApp("read-only", session()));
    const res = await readOnly.post("/api/inventory/quick-adjust").send({});
    expect(res.status).toBe(423);
    expect(res.body).toEqual({ code: "OFFLINE_PC_LOCAL_READ_ONLY" });
  });

  it("stops new entries once the copy is 2 days old; reading still works", async () => {
    await local.query("UPDATE pc_local.state SET last_sync_at = now() - interval '49 hours'");
    try {
      const pc = request(pcApp("entry", session()));
      const res = await pc.post("/api/inventory/quick-adjust").send({});
      expect(res.status).toBe(423);
      expect(res.body).toEqual({ code: "OFFLINE_PC_LOCAL_SYNC_TOO_OLD" });
    } finally {
      await local.query("UPDATE pc_local.state SET last_sync_at = now()");
    }
  });
});

describe("PC offline entries: delivery to the cloud", () => {
  it("delivers only the connected person's entries, exactly once", async () => {
    await local.query(
      `INSERT INTO pc_local.outbox (operation_id, kind, input, local_ref, user_id, company_id, status)
       SELECT gen_random_uuid(), kind, input, nextval('pc_local.local_ref_seq'), 'someone-else', company_id, 'pending'
         FROM pc_local.outbox LIMIT 1`
    );
    const before = await quantity(ctx.stockItemIds[0]);
    expect(await deliverOutbox(local, cloud)).toMatchObject({ applied: 0 }); // nobody connected yet
    expect(await bindCloudAccount(local, ctx.userId)).toBe(false);

    const first = await deliverOutbox(local, cloud);
    expect(first).toMatchObject({ applied: 1, conflicts: 0, refused: 0 });
    expect(await quantity(ctx.stockItemIds[0])).toBe(before + 3);

    // A lost acknowledgement: delivering the same entry again changes nothing.
    await local.query("UPDATE pc_local.outbox SET status = 'pending' WHERE user_id = $1", [ctx.userId]);
    expect(await deliverOutbox(local, cloud)).toMatchObject({ applied: 1 });
    expect(await quantity(ctx.stockItemIds[0])).toBe(before + 3);
    const receipt = await local.query("SELECT receipt FROM pc_local.outbox WHERE user_id = $1", [ctx.userId]);
    expect(receipt.rows[0].receipt).toMatchObject({ outcome: "cloud-applied", replayed: true });

    expect(await outboxSummary(local)).toEqual([{ status: "pending", userId: "someone-else", count: 1 }]);
  });

  it("keeps a conflict for Admin/Developer review instead of writing", async () => {
    const before = await quantity(ctx.stockItemIds[0]);
    await local.query(
      `INSERT INTO pc_local.outbox (operation_id, kind, input, local_ref, user_id, company_id, status)
       VALUES (gen_random_uuid(), 'stock.quick-adjust.v1', $1::jsonb, nextval('pc_local.local_ref_seq'), $2, $3, 'pending')`,
      [
        JSON.stringify({
          stockItemId: ctx.stockItemIds[0],
          locationId: ctx.locationId,
          quantity: "999999",
          type: "subtract",
        }),
        ctx.userId,
        ctx.companyId,
      ]
    );
    const outcome = await deliverOutbox(local, cloud);
    const seen = await local.query("SELECT status, code FROM pc_local.outbox ORDER BY id DESC LIMIT 1");
    expect(outcome, JSON.stringify(seen.rows)).toMatchObject({ conflicts: 1 });
    const { rows } = await local.query("SELECT code, overridable FROM pc_local.outbox WHERE status = 'conflict'");
    expect(rows).toEqual([{ code: expect.stringContaining("NEGATIVE"), overridable: true }]);
    expect(await quantity(ctx.stockItemIds[0])).toBe(before);
  });

  it("lets only an Admin/Developer approve a held entry (stock then goes negative); anyone may discard", async () => {
    const held = await local.query("SELECT operation_id FROM pc_local.outbox WHERE status = 'conflict'");
    const operationId = held.rows[0].operation_id;
    const before = await quantity(ctx.stockItemIds[0]);

    await pool.query("UPDATE user_company_roles SET role = 'Manager' WHERE user_id = $1 AND company_id = $2", [
      ctx.userId,
      ctx.companyId,
    ]);
    try {
      await expect(resolveConflict(local, cloud, operationId, "approve")).rejects.toMatchObject({
        code: "OFFLINE_BROWSER_OVERRIDE_NOT_ALLOWED",
      });
    } finally {
      await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2", [
        ctx.userId,
        ctx.companyId,
      ]);
    }
    expect(await quantity(ctx.stockItemIds[0])).toBe(before);

    await resolveConflict(local, cloud, operationId, "approve");
    expect(await quantity(ctx.stockItemIds[0])).toBe(before - 999999);

    // A second held entry, given up instead: the cloud is untouched.
    await local.query(
      `INSERT INTO pc_local.outbox (operation_id, kind, input, local_ref, user_id, company_id, status, code, overridable)
       SELECT gen_random_uuid(), kind, input, nextval('pc_local.local_ref_seq'), user_id, company_id, 'conflict', code, true
         FROM pc_local.outbox WHERE operation_id = $1::uuid`,
      [operationId]
    );
    const second = await local.query("SELECT operation_id FROM pc_local.outbox WHERE status = 'conflict'");
    const afterApprove = await quantity(ctx.stockItemIds[0]);
    await resolveConflict(local, cloud, second.rows[0].operation_id, "discard");
    expect(await quantity(ctx.stockItemIds[0])).toBe(afterApprove);
    const after = await local.query("SELECT status, code FROM pc_local.outbox WHERE operation_id = $1", [
      second.rows[0].operation_id,
    ]);
    expect(after.rows[0]).toEqual({ status: "refused", code: "DISCARDED" });
  });
});

describe("PC offline entries: switching the connected account", () => {
  it("refuses another account while the connected one still has entries to send", async () => {
    await local.query(
      `INSERT INTO pc_local.outbox (operation_id, kind, input, local_ref, user_id, company_id, status)
       VALUES (gen_random_uuid(), 'stock.quick-adjust.v1', '{}'::jsonb, nextval('pc_local.local_ref_seq'), $1, $2, 'pending')`,
      [ctx.userId, ctx.companyId]
    );
    try {
      await expect(bindCloudAccount(local, "another-account")).rejects.toMatchObject({
        code: "PC_LOCAL_ENTRIES_NOT_DELIVERED",
      });
      const state = await local.query("SELECT cloud_user_id, copy_complete FROM pc_local.state");
      expect(state.rows[0]).toEqual({ cloud_user_id: ctx.userId, copy_complete: true }); // copy kept
    } finally {
      await local.query("DELETE FROM pc_local.outbox WHERE user_id = $1 AND status = 'pending'", [ctx.userId]);
    }
  });
});

describe("PC offline entries: back to the cloud's version", () => {
  it("pauses the pull while entries are outstanding, then undoes local writes and pulls", async () => {
    const copied = await local.query("SELECT id, total_amount FROM vouchers ORDER BY id LIMIT 1");
    // The local server's own writes (origin role, so the capture trigger records them).
    const mine = await local.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, 'PC-LOCAL-1', 'Journal', '2026-11-18', 5) RETURNING id`,
      [ctx.companyId]
    );
    expect(Number(mine.rows[0].id)).toBeGreaterThanOrEqual(1_000_000_000); // never a cloud id
    if (copied.rows[0]) await local.query("UPDATE vouchers SET total_amount = 77 WHERE id = $1", [copied.rows[0].id]);

    // Someone else's entry is still outstanding: nothing is undone and the pull waits.
    const paused = await syncCycle(local, cloud);
    expect(paused).toMatchObject({ pullPaused: true, reverted: 0 });

    await local.query("UPDATE pc_local.outbox SET status = 'refused' WHERE user_id = 'someone-else'");
    const cycle = await syncCycle(local, cloud);
    expect(cycle).toMatchObject({ pullPaused: false, upToDate: true });
    expect(cycle.reverted).toBeGreaterThanOrEqual(1);
    const gone = await local.query("SELECT count(*)::int AS n FROM vouchers WHERE id >= 1000000000");
    expect(gone.rows[0].n).toBe(0);
    if (copied.rows[0]) {
      const back = await local.query("SELECT total_amount FROM vouchers WHERE id = $1", [copied.rows[0].id]);
      expect(Number(back.rows[0].total_amount)).toBe(Number(copied.rows[0].total_amount));
    }
    const writes = await local.query("SELECT count(*)::int AS n FROM pc_local.local_writes");
    expect(writes.rows[0].n).toBe(0);
  });
});
