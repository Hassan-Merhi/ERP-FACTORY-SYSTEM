/**
 * Full offline mode: accounting Sales and Purchase vouchers entered on a PC
 * while offline (POST /api/vouchers/with-entries, the protected central path).
 *
 * The cloud posts each through the same service as the live route, once,
 * with a client request id derived from the operation. Proves: a Sales or
 * Purchase voucher is posted once, as its own kind (replay answers replayed);
 * an unbalanced one, or one naming a customer the cloud does not have, is held
 * and never posted; a browser cannot send it (PC only); and the PC records only
 * what the cloud can replay (Sales or Purchase, USD, active, within the
 * envelope's limits), refusing other voucher types,
 * optional vouchers and over-long text before the route runs, and never queues
 * a retried save twice.
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

const PREFIX = `pcsale_${Date.now()}`;
const DEVICE = randomUUID();
const KIND = "voucher.sales.v1";
const PURCHASE_KIND = "voucher.purchase.v1";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let localRef = 1_000_000_000;

function sale(description: string, debit: string, credit: string, extra: Record<string, unknown> = {}) {
  return {
    clientRequestId: randomUUID(),
    voucher: { voucherType: "Sales", voucherDate: new Date().toISOString().slice(0, 10), description, ...extra },
    entries: [
      { ledgerAccountId: ctx.cashAccountId, debitAmount: debit, creditAmount: "0" },
      { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: credit },
    ],
  };
}

function op(input: unknown, operationId = randomUUID(), kind = KIND) {
  localRef += 1;
  return { deviceId: DEVICE, operationId, kind, localRef, capturedAt: new Date().toISOString(), input };
}

async function salesNamed(description: string, voucherType = "Sales"): Promise<Array<{ id: number; total: number }>> {
  const { rows } = await pool.query(
    `SELECT id, total_amount::numeric AS total FROM vouchers
      WHERE company_id = $1 AND voucher_type = $3 AND description = $2 AND deleted_at IS NULL`,
    [ctx.companyId, description, voucherType]
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
  await pool.query("ALTER TABLE factory_edge_applied_events DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_applied_events WHERE site_id = $1::uuid", [DEVICE]);
  await pool.query("ALTER TABLE factory_edge_applied_events ENABLE TRIGGER USER");
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("PC offline Sales and Purchase vouchers: in the cloud", () => {
  it("posts a Sales voucher once, and answers a replay as replayed", async () => {
    const sent = op(sale("Offline sale A", "40.00", "40.00"));
    const first = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(again.body).toMatchObject({ replayed: true, cloudRef: first.body.cloudRef });
    expect(await salesNamed("Offline sale A")).toEqual([{ id: Number(first.body.cloudRef), total: 40 }]);
  });

  it("holds an unbalanced voucher and one naming a customer the cloud does not have", async () => {
    const unbalanced = await agent
      .post("/api/offline/pc-sync/operations")
      .send(op(sale("Offline sale unbalanced", "40.00", "39.00")));
    expect(unbalanced.status).toBe(409);
    expect(unbalanced.body).toMatchObject({ code: "PHASE9_SALES_VOUCHER_REFUSED", overridable: false });
    expect(await salesNamed("Offline sale unbalanced")).toEqual([]);

    const input = sale("Offline sale unknown customer", "15.00", "15.00");
    // A cloud id the cloud does not have (ids from 1e9 up are a PC's own and wait for their create).
    input.entries[0] = { customerId: 999_999_999, debitAmount: "15.00", creditAmount: "0" } as never;
    const unknown = await agent.post("/api/offline/pc-sync/operations").send(op(input));
    expect(unknown.status).toBe(409);
    expect(unknown.body).toMatchObject({ code: "PHASE9_SALES_VOUCHER_REFUSED" });
    expect(await salesNamed("Offline sale unknown customer")).toEqual([]);
  });

  it("posts a Purchase voucher once as its own kind, and holds an unbalanced one", async () => {
    const input = sale("Offline purchase A", "25.00", "25.00");
    input.voucher.voucherType = "Purchase";
    const sent = op(input, randomUUID(), PURCHASE_KIND);
    const first = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await agent.post("/api/offline/pc-sync/operations").send(sent)).body).toMatchObject({ replayed: true });
    expect(await salesNamed("Offline purchase A", "Purchase")).toEqual([
      { id: Number(first.body.cloudRef), total: 25 },
    ]);

    const unbalanced = sale("Offline purchase unbalanced", "25.00", "24.00");
    unbalanced.voucher.voucherType = "Purchase";
    const held = await agent.post("/api/offline/pc-sync/operations").send(op(unbalanced, randomUUID(), PURCHASE_KIND));
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({ code: "PHASE9_PURCHASE_VOUCHER_REFUSED", overridable: false });
    expect(await salesNamed("Offline purchase unbalanced", "Purchase")).toEqual([]);

    // A Purchase body sent as a Sales voucher is never posted.
    const mislabelled = sale("Offline purchase sent as a sale", "5.00", "5.00");
    mislabelled.voucher.voucherType = "Purchase";
    const refused = await agent.post("/api/offline/pc-sync/operations").send(op(mislabelled));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await salesNamed("Offline purchase sent as a sale", "Purchase")).toEqual([]);
    expect(await salesNamed("Offline purchase sent as a sale")).toEqual([]);
  });

  it("refuses Sales vouchers on the browser route (PC only)", async () => {
    const res = await agent
      .post("/api/offline/browser-sync/operations")
      .send(op(sale("Offline sale from a browser", "5.00", "5.00")));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "OFFLINE_BROWSER_KIND_NOT_SUPPORTED" });
  });
});

describe("PC offline Sales and Purchase vouchers: on the PC", () => {
  let admin: Client;
  let local: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS pcsync_local_sale_test WITH (FORCE)");
    await admin.query("CREATE DATABASE pcsync_local_sale_test");
    const url = databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_sale_test");
    applyMigrations(url);
    local = new Client({ connectionString: url, ssl: false });
    await local.connect();
    await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
  }, 120_000);

  afterAll(async () => {
    await local?.end().catch(() => undefined);
    await admin?.query("DROP DATABASE IF EXISTS pcsync_local_sale_test WITH (FORCE)").catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("records Sales and Purchase vouchers as their own kinds, and refuses other types and optional vouchers before the route runs", async () => {
    await local.query("UPDATE pc_local.state SET copy_complete = true, last_sync_at = now()");
    const connect = async () => ({
      query: (text: string, values?: unknown[]) => local.query(text, values as unknown[]),
      release: () => undefined,
    });
    const handled: string[] = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: Record<string, unknown> }).session = { userId: "u1", currentCompanyId: 1 };
      next();
    });
    app.use(makePcLocalReadOnlyGuard({ OFFLINE_PC_LOCAL_MODE: "entry" }, connect));
    const seen = new Set<string>();
    app.post("/api/vouchers/with-entries", (req, res) => {
      handled.push(String(req.body.voucher?.voucherType));
      const replayed = seen.has(req.body.clientRequestId);
      seen.add(req.body.clientRequestId);
      res.json({ voucher: { id: 1_000_000_501 }, replayed });
    });
    const body = (voucherType: string, extra: Record<string, unknown> = {}) => ({
      clientRequestId: randomUUID(),
      voucher: { voucherType, voucherDate: "2026-11-20", ...extra },
      entries: [
        { ledgerAccountId: 1, debitAmount: "10.00", creditAmount: "0" },
        { ledgerAccountId: 2, debitAmount: "0", creditAmount: "10.00" },
      ],
    });

    const first = body("Sales");
    expect((await request(app).post("/api/vouchers/with-entries").send(first)).status).toBe(200);
    // A retry of the same save (the response was lost) is answered as a replay
    // and must not queue a second delivery.
    expect((await request(app).post("/api/vouchers/with-entries").send(first)).body).toMatchObject({
      replayed: true,
    });
    expect((await request(app).post("/api/vouchers/with-entries").send(body("Purchase"))).status).toBe(200);
    const contra = await request(app).post("/api/vouchers/with-entries").send(body("Contra"));
    expect(contra.status).toBe(423);
    expect(contra.body).toEqual({ code: "OFFLINE_PC_LOCAL_CHANGE_NOT_SUPPORTED" });
    expect(
      (
        await request(app)
          .post("/api/vouchers/with-entries")
          .send(body("Sales", { optional: true }))
      ).status
    ).toBe(423);
    // What the cloud would refuse is refused here too: the envelope's limits.
    expect(
      (
        await request(app)
          .post("/api/vouchers/with-entries")
          .send(body("Sales", { description: "x".repeat(2001) }))
      ).status
    ).toBe(423);
    expect(handled).toEqual(["Sales", "Sales", "Purchase"]);

    const outbox = async () =>
      (await local.query("SELECT kind, status FROM pc_local.outbox ORDER BY kind")).rows as Array<{
        kind: string;
        status: string;
      }>;
    let rows = await outbox();
    for (let i = 0; i < 20 && (rows.length !== 2 || rows.some((r) => r.status !== "pending")); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      rows = await outbox();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await outbox()).toEqual([
      { kind: PURCHASE_KIND, status: "pending" },
      { kind: KIND, status: "pending" },
    ]);
  });
});
