/**
 * Full offline mode: Journal vouchers entered on a PC while offline.
 *
 * The PC records the journal as entered; the cloud posts it through the same
 * service as POST /api/vouchers/journal, once, with a source id derived from
 * the operation. Proves: a balanced journal is posted once (replay answers
 * replayed); an unbalanced one is held, never posted; a cashier's is held (the
 * live route is requireNonPOS); a browser cannot send journals (PC only); and
 * the PC guard records the journal route in entry mode.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import express from "express";
import { Client } from "pg";
import { pool } from "../server/db";
import { makePcLocalReadOnlyGuard } from "../server/offline/pcLocal/localReadOnlyGuard";
import { loadPcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { prepareLocalDatabase } from "../scripts/pc-sync/local/localStore.mjs";
import { applyMigrations, databaseUrlFor } from "./helpers/migrateDisposableDatabase.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `pcjrnl_${Date.now()}`;
const DEVICE = randomUUID();
const KIND = "voucher.journal.v1";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let localRef = 1_000_000_000;

function journal(debit: string, credit: string, notes = "Entered offline") {
  return {
    voucherDate: new Date().toISOString().slice(0, 10),
    notes,
    entries: [
      { type: "DR", accountType: "ledger", accountId: ctx.salesAccountId, amount: debit },
      { type: "CR", accountType: "ledger", accountId: ctx.cashAccountId, amount: credit },
    ],
  };
}

function op(input: unknown, operationId = randomUUID()) {
  localRef += 1;
  return { deviceId: DEVICE, operationId, kind: KIND, localRef, capturedAt: new Date().toISOString(), input };
}

async function journalsNamed(notes: string): Promise<Array<{ id: number; total: number }>> {
  const { rows } = await pool.query(
    `SELECT id, total_amount::numeric AS total FROM vouchers
      WHERE company_id = $1 AND voucher_type = 'Journal' AND description = $2 AND deleted_at IS NULL`,
    [ctx.companyId, notes]
  );
  return rows.map((r) => ({ id: Number(r.id), total: Number(r.total) }));
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
  await pool
    .query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2", [
      ctx.userId,
      ctx.companyId,
    ])
    .catch(() => undefined);
  await pool.query("ALTER TABLE factory_edge_applied_events DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_applied_events WHERE site_id = $1::uuid", [DEVICE]);
  await pool.query("ALTER TABLE factory_edge_applied_events ENABLE TRIGGER USER");
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("PC offline journals: in the cloud", () => {
  it("posts a balanced journal once, and answers a replay as replayed", async () => {
    const sent = op(journal("25.00", "25.00", "Offline journal A"));
    const first = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, cloudRef: first.body.cloudRef });
    const posted = await journalsNamed("Offline journal A");
    expect(posted).toEqual([{ id: Number(first.body.cloudRef), total: 25 }]);
  });

  it("holds an unbalanced journal instead of posting it, and lets the PC give it up", async () => {
    const sent = op(journal("30.00", "29.00", "Offline journal unbalanced"));
    const res = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "PHASE9_JOURNAL_REFUSED", overridable: false });
    expect(await journalsNamed("Offline journal unbalanced")).toEqual([]);
    // The PC's "discard" goes through the shared discard path: recorded, nothing posted.
    const discarded = await agent.post("/api/offline/browser-sync/operations/discard").send(sent);
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    expect(await journalsNamed("Offline journal unbalanced")).toEqual([]);
  });

  it("writes the factory daybook row with the journal, in the same transaction", async () => {
    await pool.query("INSERT INTO factory_settings (company_id) VALUES ($1)", [ctx.companyId]);
    try {
      const res = await agent
        .post("/api/offline/pc-sync/operations")
        .send(op(journal("12.00", "12.00", "Offline journal with daybook")));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const daybook = await pool.query(
        "SELECT tx_type FROM factory_daybook_entries WHERE company_id = $1 AND reference_id = $2",
        [ctx.companyId, Number(res.body.cloudRef)]
      );
      expect(daybook.rows).toEqual([{ tx_type: "JOURNAL" }]);
    } finally {
      await pool.query("DELETE FROM factory_daybook_entries WHERE company_id = $1", [ctx.companyId]);
      await pool.query("DELETE FROM factory_settings WHERE company_id = $1", [ctx.companyId]);
    }
  });

  it("holds a cashier's journal: the live route is not open to POS", async () => {
    await pool.query("UPDATE user_company_roles SET role = 'POS' WHERE user_id = $1 AND company_id = $2", [
      ctx.userId,
      ctx.companyId,
    ]);
    try {
      const res = await agent
        .post("/api/offline/pc-sync/operations")
        .send(op(journal("5.00", "5.00", "Offline journal by cashier")));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "PHASE9_ACTOR_ROLE_NOT_PERMITTED" });
      expect(await journalsNamed("Offline journal by cashier")).toEqual([]);
    } finally {
      await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2", [
        ctx.userId,
        ctx.companyId,
      ]);
    }
  });

  it("refuses journals on the browser route (PC only)", async () => {
    const res = await agent
      .post("/api/offline/browser-sync/operations")
      .send(op(journal("7.00", "7.00", "Offline journal from a browser")));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "OFFLINE_BROWSER_KIND_NOT_SUPPORTED" });
    expect(await journalsNamed("Offline journal from a browser")).toEqual([]);
  });
});

describe("PC offline journals: on the PC", () => {
  let admin: Client;
  let local: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS pcsync_local_jrnl_test WITH (FORCE)");
    await admin.query("CREATE DATABASE pcsync_local_jrnl_test");
    const url = databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_jrnl_test");
    applyMigrations(url);
    local = new Client({ connectionString: url, ssl: false });
    await local.connect();
    await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
  }, 120_000);

  afterAll(async () => {
    await local?.end().catch(() => undefined);
    await admin?.query("DROP DATABASE IF EXISTS pcsync_local_jrnl_test WITH (FORCE)").catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("records the journal route as an offline entry in entry mode only", async () => {
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
      app.post("/api/vouchers/journal", (_req, res) => res.json({ voucher: { id: 1_000_000_401 } }));
      return app;
    };
    const res = await request(build("entry")).post("/api/vouchers/journal").send({ voucherDate: "2026-11-19" });
    expect(res.status).toBe(200);
    let row: { kind: string; status: string } | undefined;
    for (let i = 0; i < 20 && row?.status !== "pending"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      row = (await local.query("SELECT kind, status FROM pc_local.outbox WHERE kind = $1", [KIND])).rows[0];
    }
    expect(row).toEqual({ kind: KIND, status: "pending" });
    expect((await request(build("read-only")).post("/api/vouchers/journal").send({})).status).toBe(423);
  });
});
