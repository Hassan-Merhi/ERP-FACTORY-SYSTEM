/**
 * Full offline mode: Payment / Receipt edits and deletes made on a PC while
 * offline.
 *
 * The PC's live route builds the same evidence the factory LAN server records
 * (with the voucher as it stood) and writes it to pc_local.outbox in the
 * change's own transaction; the cloud accepts that finished envelope only from
 * the PC route, only for the signed-in person and company, and applies it
 * through the existing exactly-once handlers. Proves: an edit and a delete of
 * a payment the PC created offline reach the cloud once; a stale edit is held
 * as "changed" instead of overwriting; an envelope naming someone else, and
 * any envelope on the browser route, are refused; the PC records the envelope
 * in the same transaction and names its own vouchers by their local id; and
 * a PC refuses deletes it cannot replay.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import express from "express";
import { makePcLocalReadOnlyGuard } from "../server/offline/pcLocal/localReadOnlyGuard";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, pool, type DbTransaction } from "../server/db";
import { paymentReceiptEvidence, phase9PaymentVoucherRefTx } from "../server/edge/phase9PaymentOutbox";
import { phase9PaymentSnapshotTx } from "../server/edge/phase9PaymentSnapshot";
import { phase9PaymentDeleteEnvelope, phase9PaymentEditEnvelope } from "../server/edge/phase9PaymentEnvelope.mjs";
import { assertPcLocalCaptured, capturePcLocalEnvelopeTx } from "../server/offline/pcLocal/pcCapture";
import { loadPcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { prepareLocalDatabase } from "../scripts/pc-sync/local/localStore.mjs";
import { deliverOutbox, deliveryDeviceId } from "../scripts/pc-sync/local/outbox.mjs";
import { applyMigrations, databaseUrlFor } from "./helpers/migrateDisposableDatabase.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `pcedit_${Date.now()}`;
const DEVICE = randomUUID();
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let supplierId: number;
let bankId: number;
let localRef = 1_000_000_000;
let deliveryDevice: string | null = null;

function body(kind: string, part: { input?: unknown; envelope?: unknown }, ref: number, operationId = randomUUID()) {
  return { deviceId: DEVICE, operationId, kind, localRef: ref, capturedAt: new Date().toISOString(), ...part };
}

async function snapshot(voucherId: number): Promise<string> {
  const sha = await db.transaction((tx) => phase9PaymentSnapshotTx(tx as DbTransaction, ctx.companyId, voucherId));
  if (!sha) throw new Error("no snapshot");
  return sha;
}

function actor(requestId: string) {
  return { companyId: ctx.companyId, actorUserId: ctx.userId, actorUsername: `${PREFIX}_testuser`, requestId };
}

function voucherFields(amount: string) {
  return paymentReceiptEvidence({
    voucherType: "Payment",
    voucherDate: new Date().toISOString().slice(0, 10),
    paymentAccountType: "supplier",
    paymentAccountId: supplierId,
    entries: [{ accountType: "bank", accountId: bankId, amount }],
    notes: "Edited offline",
    optional: false,
    currency: null,
    exchangeRate: null,
    effectiveDate: null,
  } as Parameters<typeof paymentReceiptEvidence>[0]);
}

/** A payment created offline on the PC and already delivered: its local id and its cloud id. */
async function deliveredPayment(amount = "40.00"): Promise<{ local: number; cloud: number }> {
  localRef += 1;
  const res = await agent.post("/api/offline/pc-sync/operations").send(
    body(
      "voucher.payment-receipt.v1",
      {
        input: {
          voucherType: "Payment",
          voucherDate: new Date().toISOString().slice(0, 10),
          paymentAccountType: "supplier",
          paymentAccountId: supplierId,
          entries: [{ accountType: "bank", accountId: bankId, amount }],
          notes: "Paid offline",
        },
      },
      localRef
    )
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { local: localRef, cloud: Number(res.body.cloudRef) };
}

async function total(voucherId: number): Promise<number | null> {
  const { rows } = await pool.query(
    "SELECT total_amount::numeric AS t FROM vouchers WHERE id = $1 AND deleted_at IS NULL",
    [voucherId]
  );
  return rows[0] ? Number(rows[0].t) : null;
}

beforeAll(async () => {
  process.env.OFFLINE_PC_SYNC_ENABLED = "1";
  process.env.OFFLINE_BROWSER_SYNC_ENABLED = "1";
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  const supplier = await pool.query(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, active, stock_group_id)
     VALUES ($1, $2, 'Offline Edit Supplier', 'edit@pcedit.test', '0', true, $3) RETURNING id`,
    [ctx.companyId, `${PREFIX}-SUP`.slice(0, 40), ctx.stockGroupId]
  );
  supplierId = Number(supplier.rows[0].id);
  const bank = await pool.query(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side, active)
     VALUES ($1, $2, 'PC Bank', 'PC Bank', 'PCE-001', '0', 'Dr', true) RETURNING id`,
    [ctx.companyId, `${PREFIX}-BANK`.slice(0, 40)]
  );
  bankId = Number(bank.rows[0].id);
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

describe("PC offline payment edits and deletes: in the cloud", () => {
  it("applies an edit of a payment the PC created offline, once", async () => {
    const payment = await deliveredPayment("40.00");
    const operationId = randomUUID();
    const envelope = phase9PaymentEditEnvelope({
      ...actor(operationId),
      localVoucherId: payment.local,
      voucherRef: { origin: "lan", localVoucherId: payment.local },
      beforeSha256: await snapshot(payment.cloud),
      voucher: voucherFields("55.00"),
    });
    const sent = body("voucher.payment-receipt-edit.v1", { envelope }, payment.local, operationId);
    const first = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await total(payment.cloud)).toBe(55);

    const again = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true });
    expect(await total(payment.cloud)).toBe(55);
  });

  it("holds a stale delete as changed instead of overwriting, then applies a current one", async () => {
    const payment = await deliveredPayment("20.00");
    const stale = await snapshot(payment.cloud);
    // Someone changes it in the cloud first.
    const editId = randomUUID();
    const edit = await agent.post("/api/offline/pc-sync/operations").send(
      body(
        "voucher.payment-receipt-edit.v1",
        {
          envelope: phase9PaymentEditEnvelope({
            ...actor(editId),
            localVoucherId: payment.local,
            voucherRef: { origin: "lan", localVoucherId: payment.local },
            beforeSha256: stale,
            voucher: voucherFields("21.00"),
          }),
        },
        payment.local,
        editId
      )
    );
    expect(edit.status).toBe(200);

    const staleId = randomUUID();
    const held = await agent.post("/api/offline/pc-sync/operations").send(
      body(
        "voucher.payment-receipt-delete.v1",
        {
          envelope: phase9PaymentDeleteEnvelope({
            ...actor(staleId),
            localVoucherId: payment.local,
            voucherRef: { origin: "lan", localVoucherId: payment.local },
            beforeSha256: stale,
          }),
        },
        payment.local,
        staleId
      )
    );
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({ code: "PHASE9_PAYMENT_CHANGED", overridable: true });
    expect(await total(payment.cloud)).toBe(21);

    const currentId = randomUUID();
    const deleted = await agent.post("/api/offline/pc-sync/operations").send(
      body(
        "voucher.payment-receipt-delete.v1",
        {
          envelope: phase9PaymentDeleteEnvelope({
            ...actor(currentId),
            localVoucherId: payment.local,
            voucherRef: { origin: "lan", localVoucherId: payment.local },
            beforeSha256: await snapshot(payment.cloud),
          }),
        },
        payment.local,
        currentId
      )
    );
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(await total(payment.cloud)).toBeNull();
  });

  it("refuses an envelope that names another person, and any envelope on the browser route", async () => {
    const payment = await deliveredPayment("10.00");
    const operationId = randomUUID();
    const envelope = phase9PaymentEditEnvelope({
      ...actor(operationId),
      actorUserId: "someone-else",
      localVoucherId: payment.local,
      voucherRef: { origin: "lan", localVoucherId: payment.local },
      beforeSha256: await snapshot(payment.cloud),
      voucher: voucherFields("99.00"),
    });
    const sent = body("voucher.payment-receipt-edit.v1", { envelope }, payment.local, operationId);
    const forged = await agent.post("/api/offline/pc-sync/operations").send(sent);
    expect(forged.status).toBe(422);
    const browser = await agent.post("/api/offline/browser-sync/operations").send(sent);
    expect(browser.status).toBe(422);
    expect(await total(payment.cloud)).toBe(10);
  });
});

describe("PC offline payment edits and deletes: on the PC", () => {
  let admin: Client;
  let local: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS pcsync_local_edits_test WITH (FORCE)");
    await admin.query("CREATE DATABASE pcsync_local_edits_test");
    const url = databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_edits_test");
    applyMigrations(url);
    local = new Client({ connectionString: url, ssl: false });
    await local.connect();
    await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
  }, 120_000);

  afterAll(async () => {
    await local?.end().catch(() => undefined);
    await admin?.query("DROP DATABASE IF EXISTS pcsync_local_edits_test WITH (FORCE)").catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("records the finished envelope in the change's own transaction, and nothing if it rolls back", async () => {
    const pcDb = drizzle(local);
    const envelope = {
      kind: "voucher.payment-receipt-delete.v1",
      requestId: randomUUID(),
      companyId: 1,
      actorUserId: "u1",
    };
    await pcDb.transaction((tx) => capturePcLocalEnvelopeTx(tx as unknown as DbTransaction, envelope, 1_000_000_123));
    const kept = await local.query("SELECT status, local_ref, envelope FROM pc_local.outbox WHERE operation_id = $1", [
      envelope.requestId,
    ]);
    expect(kept.rows[0]).toMatchObject({ status: "pending", local_ref: 1_000_000_123, envelope });

    const rolledBack = { ...envelope, requestId: randomUUID() };
    await expect(
      pcDb.transaction(async (tx) => {
        await capturePcLocalEnvelopeTx(tx as unknown as DbTransaction, rolledBack, 1_000_000_124);
        throw new Error("the change failed");
      })
    ).rejects.toThrow("the change failed");
    const gone = await local.query("SELECT 1 FROM pc_local.outbox WHERE operation_id = $1", [rolledBack.requestId]);
    expect(gone.rowCount).toBe(0);
  });

  it("refuses, on a PC, a change the route could not record, so it rolls back", async () => {
    process.env.OFFLINE_PC_LOCAL_MODE = "entry";
    try {
      expect(() => assertPcLocalCaptured(false)).toThrow("OFFLINE_PC_LOCAL_CHANGE_NOT_SUPPORTED");
      expect(() => assertPcLocalCaptured(true)).not.toThrow();
    } finally {
      delete process.env.OFFLINE_PC_LOCAL_MODE;
    }
    expect(() => assertPcLocalCaptured(false)).not.toThrow();
  });

  it("names a voucher the PC created by its local id and a synced one by its cloud id", async () => {
    process.env.OFFLINE_PC_LOCAL_MODE = "entry";
    try {
      await db.transaction(async (tx) => {
        expect(await phase9PaymentVoucherRefTx(tx as DbTransaction, 1_000_000_777)).toEqual({
          origin: "lan",
          localVoucherId: 1_000_000_777,
        });
        expect(await phase9PaymentVoucherRefTx(tx as DbTransaction, 4242)).toEqual({
          origin: "cloud",
          voucherId: 4242,
        });
      });
    } finally {
      delete process.env.OFFLINE_PC_LOCAL_MODE;
    }
  });

  it("lets payment edits and deletes through on the PC and refuses any other voucher before a handler runs", async () => {
    await local.query("UPDATE pc_local.state SET copy_complete = true, last_sync_at = now()");
    await local.query(`BEGIN; SET LOCAL session_replication_role = replica;
      INSERT INTO vouchers (id, company_id, voucher_number, voucher_type, voucher_date, total_amount)
      VALUES (91, 1, 'J-91', 'Journal', '2026-11-19', 0), (92, 1, 'P-92', 'Payment', '2026-11-19', 5);
      COMMIT;`);
    const handled: string[] = [];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: Record<string, unknown> }).session = { userId: "u1", currentCompanyId: 1 };
      next();
    });
    const connect = async () => ({
      query: (text: string, values?: unknown[]) => local.query(text, values as unknown[]),
      release: () => undefined,
    });
    app.use(makePcLocalReadOnlyGuard({ OFFLINE_PC_LOCAL_MODE: "entry" }, connect));
    app.delete("/api/vouchers/:id", (req, res) => {
      handled.push(`DELETE ${req.params.id}`);
      res.json({ ok: true });
    });
    app.patch("/api/vouchers/:id/payment-receipt", (req, res) => {
      handled.push(`PATCH ${req.params.id}`);
      res.json({ ok: true });
    });

    const journal = await request(app).delete("/api/vouchers/91");
    expect(journal.status).toBe(423);
    expect(journal.body).toEqual({ code: "OFFLINE_PC_LOCAL_DELETE_NOT_SUPPORTED" });
    const journalEdit = await request(app).patch("/api/vouchers/91/payment-receipt").send({});
    expect(journalEdit.status).toBe(423);
    expect(journalEdit.body).toEqual({ code: "OFFLINE_PC_LOCAL_CHANGE_NOT_SUPPORTED" });
    expect((await request(app).delete("/api/vouchers/92")).status).toBe(200);
    expect((await request(app).patch("/api/vouchers/92/payment-receipt").send({})).status).toBe(200);
    expect(handled).toEqual(["DELETE 92", "PATCH 92"]);
    // Nothing is queued by the guard: the route writes its own envelope in its transaction.
    const queued = await local.query("SELECT count(*)::int AS n FROM pc_local.outbox WHERE envelope IS NULL");
    expect(queued.rows[0].n).toBe(0);

    const readOnly = express();
    readOnly.use(makePcLocalReadOnlyGuard({ OFFLINE_PC_LOCAL_MODE: "read-only" }, connect));
    readOnly.delete("/api/vouchers/:id", (_req, res) => res.json({ ok: true }));
    expect((await request(readOnly).delete("/api/vouchers/92")).status).toBe(423);
  });

  it("delivers a payment made on the PC and then its edit, as one person and company", async () => {
    const state = await local.query("UPDATE pc_local.state SET cloud_user_id = $1 RETURNING device_id", [ctx.userId]);
    deliveryDevice = deliveryDeviceId(state.rows[0].device_id, ctx.userId, ctx.companyId);
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
    const madeHere = 1_000_000_900;
    await local.query(
      `INSERT INTO pc_local.outbox (operation_id, kind, input, local_ref, user_id, company_id, status)
       VALUES (gen_random_uuid(), 'voucher.payment-receipt.v1', $1::jsonb, $2, $3, $4, 'pending')`,
      [
        JSON.stringify({
          voucherType: "Payment",
          voucherDate: new Date().toISOString().slice(0, 10),
          paymentAccountType: "supplier",
          paymentAccountId: supplierId,
          entries: [{ accountType: "bank", accountId: bankId, amount: "30.00" }],
          notes: "Paid on the PC",
        }),
        madeHere,
        ctx.userId,
        ctx.companyId,
      ]
    );
    expect(await deliverOutbox(local, cloud)).toMatchObject({ applied: 1 });
    const created = await local.query("SELECT receipt FROM pc_local.outbox WHERE local_ref = $1", [madeHere]);
    const cloudId = Number(created.rows[0].receipt.cloudRef);

    const editId = randomUUID();
    const envelope = phase9PaymentEditEnvelope({
      ...actor(editId),
      localVoucherId: madeHere,
      voucherRef: { origin: "lan", localVoucherId: madeHere },
      beforeSha256: await snapshot(cloudId),
      voucher: voucherFields("31.00"),
    });
    await local.query(
      `INSERT INTO pc_local.outbox (operation_id, kind, input, envelope, local_ref, user_id, company_id, status)
       VALUES ($1::uuid, $2, '{}'::jsonb, $3::jsonb, $4, $5, $6, 'pending')`,
      [editId, envelope.kind, JSON.stringify(envelope), madeHere, ctx.userId, ctx.companyId]
    );
    expect(await deliverOutbox(local, cloud)).toMatchObject({ applied: 1, conflicts: 0, refused: 0 });
    expect(await total(cloudId)).toBe(31);
  });
});
