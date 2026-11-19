/**
 * Full offline mode: POS sale edits (returns, corrections) and cancellations
 * made on a PC while offline.
 *
 * The PC records them exactly as the factory LAN server does, as finished
 * envelopes in pc_local.outbox in the change's own transaction; the sale is
 * named by its till sale id, so sales the PC made resolve in the cloud. A PC
 * builds its record itself, so the cloud re-checks the live sale-edit rules
 * (role, location, daybook edit window, locked date and payment) before
 * applying an edit, and the existing handler still requires Admin or Developer
 * for a cancellation. Proves: a cancellation of a sale the PC made applies
 * once; an edit outside the live rules is held (a Manager past their edit
 * days, a cashier at another location), while an Admin's passes them; a
 * cashier's cancellation is held; envelopes on the browser route are refused;
 * the PC records both in the change's transaction; and the guard opens these
 * routes only for sales, only in entry mode.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import express from "express";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type DbTransaction } from "../server/db";
import { makePcLocalReadOnlyGuard } from "../server/offline/pcLocal/localReadOnlyGuard";
import { capturePhase9PosSaleCancelTx, capturePhase9PosSaleEditTx } from "../server/edge/phase9PosOutbox";
import { phase9PosSaleCancelEnvelope, phase9PosSaleEditEnvelope } from "../server/edge/phase9PosSaleEnvelope.mjs";
import { inventoryMoney, inventoryQuantity } from "../server/lib/inventoryMath";
import { loadPcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { prepareLocalDatabase } from "../scripts/pc-sync/local/localStore.mjs";
import { applyMigrations, databaseUrlFor } from "./helpers/migrateDisposableDatabase.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `pcpos_${Date.now()}`;
const DEVICE = randomUUID();
const EDIT_KIND = "pos.sale-edit.v1";
const CANCEL_KIND = "pos.sale-cancel.v1";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;

function body(kind: string, part: { input?: unknown; envelope?: unknown }, ref: number, operationId = randomUUID()) {
  return { deviceId: DEVICE, operationId, kind, localRef: ref, capturedAt: new Date().toISOString(), ...part };
}

function actor(requestId: string, businessDate = new Date().toISOString().slice(0, 10)) {
  return {
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    requestId,
    businessDate,
  };
}

async function setRole(role: string, extra: { editDays?: number; locationId?: number | null } = {}) {
  await pool.query(
    `UPDATE user_company_roles SET role = $3, daybook_edit_days = $4, assigned_location_id = $5
      WHERE user_id = $1 AND company_id = $2`,
    [ctx.userId, ctx.companyId, role, extra.editDays ?? 0, extra.locationId ?? null]
  );
}

/** A sale the PC made offline and already delivered: its local id, cloud id, till sale id and date. */
async function deliveredSale(localRef: number) {
  const res = await agent.post("/api/offline/pc-sync/operations").send(
    body(
      "pos.sale.v1",
      {
        input: {
          locationId: ctx.locationId,
          cashAccountId: ctx.cashAccountId,
          items: [{ stockItemId: ctx.stockItemIds[0], quantity: 2, rate: 10 }],
        },
      },
      localRef
    )
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const cloud = Number(res.body.cloudRef);
  const row = await pool.query("SELECT client_sale_id, voucher_date::text AS d FROM vouchers WHERE id = $1", [cloud]);
  return { local: localRef, cloud, clientSaleId: String(row.rows[0].client_sale_id), date: String(row.rows[0].d) };
}

function editEnvelope(operationId: string, sale: { local: number; clientSaleId: string; date: string }) {
  return phase9PosSaleEditEnvelope({
    ...actor(operationId, sale.date),
    localVoucherId: sale.local,
    voucherRef: { clientSaleId: sale.clientSaleId, voucherId: sale.local },
    edit: {
      description: "Returned one",
      isCreditSale: false,
      locationId: null,
      paymentAccountId: null,
      paymentAccountType: null,
      voucherDate: null,
      items: [
        {
          existing: true,
          stockItemId: ctx.stockItemIds[0],
          quantity: inventoryQuantity("1"),
          sellingPrice: inventoryMoney("10"),
        },
      ],
    },
  });
}

async function saleDeleted(id: number): Promise<boolean> {
  const { rows } = await pool.query("SELECT deleted_at FROM vouchers WHERE id = $1", [id]);
  return rows[0]?.deleted_at != null;
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
  await setRole("Admin").catch(() => undefined);
  await pool.query("ALTER TABLE offline_negative_stock_flags DISABLE TRIGGER USER");
  await pool.query("DELETE FROM offline_negative_stock_flags WHERE device_id = $1::uuid", [DEVICE]);
  await pool.query("ALTER TABLE offline_negative_stock_flags ENABLE TRIGGER USER");
  await pool.query("ALTER TABLE factory_edge_applied_events DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_applied_events WHERE site_id = $1::uuid", [DEVICE]);
  await pool.query("ALTER TABLE factory_edge_applied_events ENABLE TRIGGER USER");
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("PC offline POS edits and cancellations: in the cloud", () => {
  it("cancels a sale the PC made, once, and refuses the envelope on the browser route", async () => {
    const sale = await deliveredSale(1_000_000_501);
    const operationId = randomUUID();
    const envelope = phase9PosSaleCancelEnvelope({
      ...actor(operationId, sale.date),
      localVoucherId: sale.local,
      voucherRef: { clientSaleId: sale.clientSaleId, voucherId: sale.local },
    });
    const sent = body(CANCEL_KIND, { envelope }, sale.local, operationId);
    expect((await agent.post("/api/offline/browser-sync/operations").send(sent)).status).toBe(422);
    const first = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await saleDeleted(sale.cloud)).toBe(true);
    const again = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(again.body).toMatchObject({ replayed: true });
  });

  it("holds a cashier's cancellation: the live delete is Admin-only", async () => {
    const sale = await deliveredSale(1_000_000_502);
    await setRole("POS", { locationId: ctx.locationId, editDays: 7 });
    try {
      const operationId = randomUUID();
      const envelope = phase9PosSaleCancelEnvelope({
        ...actor(operationId, sale.date),
        localVoucherId: sale.local,
        voucherRef: { clientSaleId: sale.clientSaleId, voucherId: sale.local },
      });
      const res = await agent
        .post("/api/offline/pc-sync/operations")
        .send(body(CANCEL_KIND, { envelope }, sale.local, operationId));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: "PHASE9_ACTOR_ROLE_NOT_PERMITTED" });
      expect(await saleDeleted(sale.cloud)).toBe(false);
    } finally {
      await setRole("Admin");
    }
  });

  it("re-checks the live edit rules: a Manager past their edit days and a cashier elsewhere are held", async () => {
    const sale = await deliveredSale(1_000_000_503);
    // Make the sale three days old in the cloud.
    await pool.query("UPDATE vouchers SET voucher_date = voucher_date - 3 WHERE id = $1", [sale.cloud]);
    const old = {
      ...sale,
      date: (await pool.query("SELECT voucher_date::text AS d FROM vouchers WHERE id = $1", [sale.cloud])).rows[0].d,
    };
    const send = async () => {
      const operationId = randomUUID();
      return agent
        .post("/api/offline/pc-sync/operations")
        .send(body(EDIT_KIND, { envelope: editEnvelope(operationId, old) }, old.local, operationId));
    };
    try {
      await setRole("Manager", { editDays: 1 });
      const manager = await send();
      expect(manager.status).toBe(409);
      expect(manager.body).toMatchObject({ code: "PHASE9_POS_EDIT_NOT_ALLOWED", overridable: false });
      expect(manager.body.detail).toMatchObject({ reason: "date" });

      await setRole("POS", { locationId: ctx.location2Id, editDays: 30 });
      const cashier = await send();
      expect(cashier.status).toBe(409);
      expect(cashier.body.detail).toMatchObject({ reason: "location" });

      await setRole("Admin");
      const admin = await send();
      expect(admin.status, JSON.stringify(admin.body)).toBe(200);
      // Two at 10 became one at 10.
      const total = await pool.query("SELECT total_amount::numeric AS t FROM vouchers WHERE id = $1", [sale.cloud]);
      expect(Number(total.rows[0].t)).toBe(10);
    } finally {
      await setRole("Admin");
    }
  });
});

describe("PC offline POS edits: a cashier's own return reaches the cloud", () => {
  it("applies a cashier's edit of a sale at their location inside the window", async () => {
    const sale = await deliveredSale(1_000_000_504);
    await setRole("POS", { locationId: ctx.locationId, editDays: 7 });
    try {
      const operationId = randomUUID();
      const res = await agent
        .post("/api/offline/pc-sync/operations")
        .send(body(EDIT_KIND, { envelope: editEnvelope(operationId, sale) }, sale.local, operationId));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const total = await pool.query("SELECT total_amount::numeric AS t FROM vouchers WHERE id = $1", [sale.cloud]);
      expect(Number(total.rows[0].t)).toBe(10);
    } finally {
      await setRole("Admin");
    }
  });
});

describe("PC offline POS edits and cancellations: on the PC", () => {
  let admin: Client;
  let local: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS pcsync_local_pos_test WITH (FORCE)");
    await admin.query("CREATE DATABASE pcsync_local_pos_test");
    const url = databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_pos_test");
    applyMigrations(url);
    local = new Client({ connectionString: url, ssl: false });
    await local.connect();
    await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
  }, 120_000);

  afterAll(async () => {
    delete process.env.OFFLINE_PC_LOCAL_MODE;
    await local?.end().catch(() => undefined);
    await admin?.query("DROP DATABASE IF EXISTS pcsync_local_pos_test WITH (FORCE)").catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("records an edit and a cancellation in the change's own transaction, named by the sale", async () => {
    process.env.OFFLINE_PC_LOCAL_MODE = "entry";
    try {
      const pcDb = drizzle(local);
      const sale = { local: 1_000_000_601, clientSaleId: randomUUID(), date: "2026-11-19" };
      const editId = randomUUID();
      const cancelId = randomUUID();
      await pcDb.transaction(async (tx) => {
        const t = tx as unknown as DbTransaction;
        const { kind: _edit, ...editEvidence } = editEnvelope(editId, sale);
        await capturePhase9PosSaleEditTx(t, editEvidence as never);
        await capturePhase9PosSaleCancelTx(t, {
          ...actor(cancelId, sale.date),
          localVoucherId: sale.local,
          voucherRef: { clientSaleId: sale.clientSaleId, voucherId: sale.local },
        });
      });
      const rows = await local.query(
        "SELECT kind, status, local_ref FROM pc_local.outbox WHERE operation_id = ANY($1::uuid[]) ORDER BY kind",
        [[editId, cancelId]]
      );
      expect(rows.rows).toEqual([
        { kind: CANCEL_KIND, status: "pending", local_ref: sale.local },
        { kind: EDIT_KIND, status: "pending", local_ref: sale.local },
      ]);

      const rolledBack = randomUUID();
      await expect(
        pcDb.transaction(async (tx) => {
          await capturePhase9PosSaleCancelTx(tx as unknown as DbTransaction, {
            ...actor(rolledBack, sale.date),
            localVoucherId: sale.local,
            voucherRef: { clientSaleId: sale.clientSaleId, voucherId: sale.local },
          });
          throw new Error("the cancellation failed");
        })
      ).rejects.toThrow("the cancellation failed");
      expect((await local.query("SELECT 1 FROM pc_local.outbox WHERE operation_id = $1", [rolledBack])).rowCount).toBe(
        0
      );
    } finally {
      delete process.env.OFFLINE_PC_LOCAL_MODE;
    }
  });

  it("opens the sale edit and cancel routes only for sales, only in entry mode", async () => {
    await local.query("UPDATE pc_local.state SET copy_complete = true, last_sync_at = now()");
    await local.query("BEGIN");
    await local.query("SET LOCAL session_replication_role = replica");
    await local.query(
      `INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES (291, 1, 'J-291', 'Journal', '2026-11-19', 0), (292, 1, 'S-292', 'Sales', '2026-11-19', 0)`
    );
    await local.query("COMMIT");
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
      app.put("/api/vouchers/:id/sales", ok);
      app.patch("/api/vouchers/:id/sales", ok);
      app.delete("/api/vouchers/:id", ok);
      return app;
    };
    const entry = build("entry");
    expect((await request(entry).put("/api/vouchers/292/sales").send({})).status).toBe(200);
    expect((await request(entry).patch("/api/vouchers/292/sales").send({})).status).toBe(200);
    expect((await request(entry).delete("/api/vouchers/292")).status).toBe(200);
    const journalEdit = await request(entry).put("/api/vouchers/291/sales").send({});
    expect(journalEdit.status).toBe(423);
    expect(journalEdit.body).toEqual({ code: "OFFLINE_PC_LOCAL_CHANGE_NOT_SUPPORTED" });
    expect((await request(entry).delete("/api/vouchers/291")).status).toBe(423);
    expect((await request(build("read-only")).put("/api/vouchers/292/sales").send({})).status).toBe(423);
  });
});
