/**
 * Full offline mode (Phase C1): customers created on a PC while offline.
 *
 * The PC writes `customer.create.v1` (with its local customer and ledger ids)
 * in the customer's own transaction. The cloud creates its own customer and
 * ledger through the live route's service, records which is which, and
 * translates later entries from that PC naming them. Proves: a customer is
 * created once (a replay answers replayed) and its local ids are mapped; a
 * Sales voucher naming the PC's customer and ledger posts against the cloud's;
 * an entry naming a customer the cloud has not created yet waits; a customer
 * that looks like an existing one is held (owner decision) until an approver
 * creates it as new; a POS sale's credit and cash accounts translate as the
 * PC's ledgers; envelopes are refused on the browser route; the PC records the
 * customer in its own transaction; discarding a held customer on the PC also
 * refuses the entries naming it; and the guard lets POST /api/customers
 * through only in entry mode.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import express from "express";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { pool, type DbTransaction } from "../server/db";
import { makePcLocalReadOnlyGuard } from "../server/offline/pcLocal/localReadOnlyGuard";
import { phase9CustomerCreateEnvelope } from "../server/edge/phase9CustomerCreateEnvelope.mjs";
import { createCustomerTx } from "../server/routes/customers/customerService";
import { translatePhase9PcRecords } from "../server/edge/phase9PcRecordMap.mjs";
import { resolveConflict } from "../scripts/pc-sync/local/outbox.mjs";
import { capturePcCustomerCreateTx } from "../server/routes/customers/customerPcCapture";
import { loadPcSyncPolicy } from "../server/offline/pcSync/tablePolicy.mjs";
import { prepareLocalDatabase } from "../scripts/pc-sync/local/localStore.mjs";
import { applyMigrations, databaseUrlFor } from "./helpers/migrateDisposableDatabase.mjs";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = `pccust_${Date.now()}`;
const DEVICE = randomUUID();
const KIND = "customer.create.v1";
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let localId = 1_000_000_100;

function customerEnvelope(legalName: string, phone: string | null = null) {
  localId += 2;
  const requestId = randomUUID();
  return phase9CustomerCreateEnvelope({
    requestId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    businessDate: new Date().toISOString().slice(0, 10),
    localCustomerId: localId,
    localLedgerAccountId: localId + 1,
    customer: {
      legalName,
      phone,
      openingBalance: "0",
      openingBalanceSide: "Dr",
      active: true,
      statementNote: null,
      paymentTermsDays: null,
      ledgerAccountId: null,
    },
  });
}

function deliver(envelope: { requestId: string; localCustomerId: number }, override?: string) {
  return agent.post("/api/offline/pc-sync/operations").send({
    deviceId: DEVICE,
    operationId: envelope.requestId,
    kind: KIND,
    localRef: envelope.localCustomerId,
    capturedAt: new Date().toISOString(),
    envelope,
    ...(override ? { override } : {}),
  });
}

async function mapping(localRecord: number) {
  const { rows } = await pool.query(
    "SELECT record_type, cloud_id FROM factory_edge_pc_record_map WHERE site_id = $1::uuid AND local_id = $2",
    [DEVICE, localRecord]
  );
  return rows.map((r) => ({ type: String(r.record_type), cloudId: Number(r.cloud_id) }));
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
  await pool.query("ALTER TABLE factory_edge_applied_events DISABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_applied_events WHERE site_id = $1::uuid", [DEVICE]);
  await pool.query("ALTER TABLE factory_edge_applied_events ENABLE TRIGGER USER");
  await pool.query("DELETE FROM factory_edge_pc_record_map WHERE site_id = $1::uuid", [DEVICE]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("PC offline customers: in the cloud", () => {
  it("creates the customer once, maps its local ids, and posts a later voucher against the cloud's", async () => {
    const envelope = customerEnvelope(`${PREFIX} Offline Customer A`, "+260 977 000 111");
    const first = await deliver(envelope);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await deliver(envelope)).body).toMatchObject({ replayed: true, cloudRef: first.body.cloudRef });

    const cloudCustomer = Number(first.body.cloudRef);
    const { rows } = await pool.query("SELECT company_id, legal_name, ledger_account_id FROM customers WHERE id = $1", [
      cloudCustomer,
    ]);
    expect(rows[0]).toMatchObject({ company_id: ctx.companyId, legal_name: envelope.customer.legalName });
    const cloudLedger = Number(rows[0].ledger_account_id);
    expect(await mapping(envelope.localCustomerId)).toEqual([{ type: "customer", cloudId: cloudCustomer }]);
    expect(await mapping(envelope.localLedgerAccountId!)).toEqual([{ type: "ledger_account", cloudId: cloudLedger }]);

    // A Sales voucher the PC made for its own customer names its local ids.
    const sale = await agent.post("/api/offline/pc-sync/operations").send({
      deviceId: DEVICE,
      operationId: randomUUID(),
      kind: "voucher.sales.v1",
      localRef: localId + 50,
      capturedAt: new Date().toISOString(),
      input: {
        clientRequestId: randomUUID(),
        voucher: { voucherType: "Sales", voucherDate: new Date().toISOString().slice(0, 10), description: PREFIX },
        entries: [
          {
            customerId: envelope.localCustomerId,
            ledgerAccountId: envelope.localLedgerAccountId,
            debitAmount: "30.00",
            creditAmount: "0",
          },
          { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "30.00" },
        ],
      },
    });
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    const lines = await pool.query(
      "SELECT customer_id, ledger_account_id FROM voucher_entries WHERE voucher_id = $1 AND debit_amount > 0",
      [Number(sale.body.cloudRef)]
    );
    expect(lines.rows.map((r) => [Number(r.customer_id), Number(r.ledger_account_id)])).toEqual([
      [cloudCustomer, cloudLedger],
    ]);
  });

  it("makes an entry naming a customer the cloud has not created yet wait", async () => {
    const res = await agent.post("/api/offline/pc-sync/operations").send({
      deviceId: DEVICE,
      operationId: randomUUID(),
      kind: "voucher.sales.v1",
      localRef: localId + 60,
      capturedAt: new Date().toISOString(),
      input: {
        clientRequestId: randomUUID(),
        voucher: { voucherType: "Sales", voucherDate: new Date().toISOString().slice(0, 10), description: PREFIX },
        entries: [
          { customerId: 1_999_999_001, debitAmount: "5.00", creditAmount: "0" },
          { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "5.00" },
        ],
      },
    });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ code: "PHASE9_PC_RECORD_NOT_YET_SYNCED" });
  });

  it("holds a customer that looks like an existing one until an approver creates it as new", async () => {
    const existing = customerEnvelope(`${PREFIX} Mwansa Trading`, "0977 123 456");
    expect((await deliver(existing)).status).toBe(200);

    const sameName = customerEnvelope(`  ${PREFIX} mwansa trading `);
    const held = await deliver(sameName);
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({ code: "PHASE9_CUSTOMER_POSSIBLE_DUPLICATE", overridable: true });
    expect(await mapping(sameName.localCustomerId)).toEqual([]);

    const samePhone = customerEnvelope(`${PREFIX} Another Name`, "+260-977-123-456");
    expect((await deliver(samePhone)).body).toMatchObject({ code: "PHASE9_CUSTOMER_POSSIBLE_DUPLICATE" });

    const approved = await deliver(sameName, "PHASE9_CUSTOMER_POSSIBLE_DUPLICATE");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await mapping(sameName.localCustomerId)).toHaveLength(1);
  });

  it("translates a POS sale's credit and cash accounts as the PC's ledgers", async () => {
    const queryable = {
      query: async () => ({
        rows: [
          { record_type: "ledger_account", local_id: 1_000_000_007, cloud_id: 70 },
          { record_type: "customer", local_id: 1_000_000_007, cloud_id: 71 },
        ],
      }),
    };
    const event = (paymentAccountType: string) => ({
      payload: { paymentAccountType, paymentAccountId: 1_000_000_007, items: [{ stockItemId: 5 }] },
    });
    expect((await translatePhase9PcRecords(queryable, DEVICE, event("credit"))).payload.paymentAccountId).toBe(70);
    expect((await translatePhase9PcRecords(queryable, DEVICE, event("cash"))).payload.paymentAccountId).toBe(70);
    // A bank account is never one the PC made: left as it is.
    expect((await translatePhase9PcRecords(queryable, DEVICE, event("bank"))).payload.paymentAccountId).toBe(
      1_000_000_007
    );
  });

  it("refuses customer envelopes on the browser route", async () => {
    const envelope = customerEnvelope(`${PREFIX} From A Browser`);
    const res = await agent.post("/api/offline/browser-sync/operations").send({
      deviceId: DEVICE,
      operationId: envelope.requestId,
      kind: KIND,
      localRef: envelope.localCustomerId,
      capturedAt: new Date().toISOString(),
      envelope,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await mapping(envelope.localCustomerId)).toEqual([]);
  });
});

describe("PC offline customers: on the PC", () => {
  let admin: Client;
  let local: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await admin.connect();
    await admin.query("DROP DATABASE IF EXISTS pcsync_local_customer_test WITH (FORCE)");
    await admin.query("CREATE DATABASE pcsync_local_customer_test");
    const url = databaseUrlFor(process.env.DATABASE_URL!, "pcsync_local_customer_test");
    applyMigrations(url);
    local = new Client({ connectionString: url, ssl: false });
    await local.connect();
    await prepareLocalDatabase(local, loadPcSyncPolicy().redact);
    // The company and person the PC copied from the cloud (ids below the local range).
    await local.query("INSERT INTO companies (id, code, name) VALUES (7, 'PC7', 'PC Company')");
  }, 120_000);

  afterAll(async () => {
    delete process.env.OFFLINE_PC_LOCAL_MODE;
    await local?.end().catch(() => undefined);
    await admin?.query("DROP DATABASE IF EXISTS pcsync_local_customer_test WITH (FORCE)").catch(() => undefined);
    await admin?.end().catch(() => undefined);
  });

  it("records the customer and its ledger with their local ids in the customer's own transaction", async () => {
    const pcDb = drizzle(local, { schema });
    const actor = { userId: "pc-user", username: "pc.clerk" };
    process.env.OFFLINE_PC_LOCAL_MODE = "entry";
    try {
      const created = await pcDb.transaction(async (tx) => {
        const row = await createCustomerTx(tx as unknown as DbTransaction, 7, { legalName: "Chanda Stores" }, actor);
        await capturePcCustomerCreateTx(tx as unknown as DbTransaction, row, { legalName: "Chanda Stores" }, actor);
        return row;
      });
      expect(created.id).toBeGreaterThanOrEqual(1_000_000_000);
      expect(created.ledgerAccountId).toBeGreaterThanOrEqual(1_000_000_000);
      const { rows } = await local.query("SELECT kind, status, local_ref, envelope FROM pc_local.outbox");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: KIND, status: "pending", local_ref: created.id });
      expect(rows[0].envelope).toMatchObject({
        companyId: 7,
        actorUsername: "pc.clerk",
        localCustomerId: created.id,
        localLedgerAccountId: created.ledgerAccountId,
        customer: { legalName: "Chanda Stores", openingBalance: "0.00", ledgerAccountId: null },
      });

      // A customer the cloud could not replay is refused, and nothing is kept.
      await expect(
        pcDb.transaction(async (tx) => {
          const input = { legalName: "Negative Opening", openingBalance: "-5" };
          const row = await createCustomerTx(tx as unknown as DbTransaction, 7, input, actor);
          await capturePcCustomerCreateTx(tx as unknown as DbTransaction, row, input, actor);
        })
      ).rejects.toThrow("OFFLINE_PC_LOCAL_CHANGE_NOT_SUPPORTED");
      const kept = await local.query("SELECT 1 FROM customers WHERE legal_name = 'Negative Opening'");
      expect(kept.rowCount).toBe(0);
    } finally {
      delete process.env.OFFLINE_PC_LOCAL_MODE;
    }
  });

  it("refuses the entries naming a held customer when it is discarded on the PC", async () => {
    await local.query("DELETE FROM pc_local.outbox");
    const envelope = customerEnvelope(`${PREFIX} Discarded Customer`);
    const add = async (status: string, input: unknown, env: unknown = null) =>
      (
        await local.query(
          `INSERT INTO pc_local.outbox (operation_id, kind, input, envelope, local_ref, user_id, company_id, status)
           VALUES ($1::uuid, 'k', $2::jsonb, $3::jsonb, 1, 'u1', 7, $4) RETURNING operation_id`,
          [randomUUID(), JSON.stringify(input), env === null ? null : JSON.stringify(env), status]
        )
      ).rows[0].operation_id as string;
    const held = await add("conflict", {}, envelope);
    await local.query("UPDATE pc_local.outbox SET kind = $1 WHERE operation_id = $2", [KIND, held]);
    const sale = await add("waiting", { entries: [{ customerId: envelope.localCustomerId }] });
    const credit = await add("pending", { isCreditSale: true, paymentAccountId: envelope.localLedgerAccountId });
    const unrelated = await add("pending", { entries: [{ customerId: 42 }], localVoucherId: envelope.localCustomerId });

    const result = await resolveConflict(local, null as never, held, "discard");
    expect(result).toEqual({ discarded: true, dependentsRefused: 2 });
    const { rows } = await local.query("SELECT operation_id, status, code FROM pc_local.outbox");
    const byId = new Map(rows.map((r) => [r.operation_id, [r.status, r.code]]));
    expect(byId.get(held)).toEqual(["refused", "DISCARDED"]);
    expect(byId.get(sale)).toEqual(["refused", "PC_SYNC_NAMES_DISCARDED_CUSTOMER"]);
    expect(byId.get(credit)).toEqual(["refused", "PC_SYNC_NAMES_DISCARDED_CUSTOMER"]);
    expect(byId.get(unrelated)).toEqual(["pending", null]);
    await local.query("DELETE FROM pc_local.outbox");
  });

  it("lets POST /api/customers through only in entry mode", async () => {
    await local.query("UPDATE pc_local.state SET copy_complete = true, last_sync_at = now()");
    const connect = async () => ({
      query: (text: string, values?: unknown[]) => local.query(text, values as unknown[]),
      release: () => undefined,
    });
    const statusIn = async (mode: string) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { session: Record<string, unknown> }).session = { userId: "u1", currentCompanyId: 7 };
        next();
      });
      app.use(makePcLocalReadOnlyGuard({ OFFLINE_PC_LOCAL_MODE: mode }, connect));
      app.post("/api/customers", (_req, res) => res.status(201).json({ id: 1_000_000_900 }));
      return (await request(app).post("/api/customers").send({ legalName: "Guarded" })).status;
    };
    expect(await statusIn("entry")).toBe(201);
    expect(await statusIn("read-only")).toBe(423);
    // The route writes its own record: the guard queues nothing for it.
    const queued = await local.query("SELECT count(*)::int AS n FROM pc_local.outbox WHERE envelope IS NULL");
    expect(queued.rows[0].n).toBe(0);
  });
});
