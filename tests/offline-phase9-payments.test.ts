/**
 * Phase 9 offline payments (voucher.payment-receipt.v1) on the full schema:
 * a supplier payment from a bank account recorded through the real route on
 * the factory LAN server (captured with its inputs and rate in the same
 * transaction), and its replay in the cloud through the same posting code.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { PoolClient } from "pg";

const SITE = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
const edge = vi.hoisted(() => ({
  config: { mode: "cloud", primary: false, siteId: null } as Record<string, unknown>,
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { pool } from "../server/db";
import { ensurePhase9PaymentOutboxSchema } from "../server/edge/phase9PaymentOutbox";
import { hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";
import { validatePhase9Event } from "../server/edge/phase9EventProtocol.mjs";
import { Phase9EventConflict } from "../server/edge/phase9CloudEventStore.mjs";
import { phase9PaymentApplyHandler, type Phase9PaymentEvent } from "../server/edge/phase9PaymentApply";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p9pay";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let bankId: number;

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

function eventFrom(payload: Record<string, unknown>): Phase9PaymentEvent {
  const event = {
    sequence: "1",
    operationId: String(payload.requestId),
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    kind: String(payload.kind),
    localRef: Number(payload.localVoucherId),
    payload,
    payloadSha256: hashEvidence(payload),
  };
  validatePhase9Event("payments", event);
  return event as Phase9PaymentEvent;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query("UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2", [
    ctx.userId,
    ctx.companyId,
  ]);
  const supplier = await pool.query(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, active, stock_group_id)
     VALUES ($1, $2, 'Offline Supplier', 'offline@p9pay.test', '0', true, $3) RETURNING id`,
    [ctx.companyId, `${PREFIX}-SUP-${ctx.companyId}`, ctx.stockGroupId]
  );
  supplierId = Number(supplier.rows[0].id);
  const bank = await pool.query(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side, active)
     VALUES ($1, $2, 'Factory Bank', 'Factory Bank', 'P9-001', '0', 'Dr', true) RETURNING id`,
    [ctx.companyId, `${PREFIX}-BANK-${ctx.companyId}`]
  );
  bankId = Number(bank.rows[0].id);
  edge.config = { mode: "lan", primary: true, siteId: SITE };
  await ensurePhase9PaymentOutboxSchema(pool);
  edge.config = { mode: "cloud", primary: false, siteId: null };
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  await pool.query("ALTER TABLE factory_edge_payment_outbox DISABLE TRIGGER factory_edge_payment_outbox_no_mutation");
  await pool.query("DELETE FROM factory_edge_payment_outbox WHERE site_id = $1", [SITE]);
  await pool.query("ALTER TABLE factory_edge_payment_outbox ENABLE TRIGGER factory_edge_payment_outbox_no_mutation");
  await pool.query("DELETE FROM factory_edge_payment_counter WHERE site_id = $1", [SITE]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Phase 9 offline supplier/customer/bank payments (POST /api/vouchers/payment-receipt)", () => {
  it("records a supplier payment from a bank account on the LAN and replays it exactly in the cloud", async () => {
    edge.config = { mode: "lan", primary: true, siteId: SITE };
    let response;
    try {
      response = await agent.post("/api/vouchers/payment-receipt").send({
        voucherType: "Payment",
        voucherDate: "2026-11-02",
        paymentAccountType: "supplier",
        paymentAccountId: supplierId,
        entries: [{ accountType: "bank", accountId: bankId, amount: "125.50" }],
        notes: "Offline supplier payment",
      });
    } finally {
      edge.config = { mode: "cloud", primary: false, siteId: null };
    }
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const outbox = await pool.query("SELECT payload FROM factory_edge_payment_outbox WHERE local_voucher_id = $1", [
      response.body.voucher.id,
    ]);
    expect(outbox.rows).toHaveLength(1);
    const payload = outbox.rows[0].payload;
    expect(payload.voucher).toEqual({
      voucherType: "Payment",
      voucherDate: "2026-11-02",
      paymentAccountType: "supplier",
      paymentAccountId: supplierId,
      entries: [{ accountType: "bank", accountId: bankId, amount: "125.5" }],
      notes: "Offline supplier payment",
      optional: false,
      currency: "USD",
      exchangeRate: null,
      effectiveDate: null,
    });

    const event = eventFrom(payload);
    await inRolledBackTx(async (client) => {
      await phase9PaymentApplyHandler.authorize(client, event);
      const result = await phase9PaymentApplyHandler.apply(client, event);
      expect(result).toMatchObject({ outcome: "cloud-applied", businessDate: "2026-11-02" });
      expect(await phase9PaymentApplyHandler.verify(client, event, result)).toBe(true);
      const entries = await client.query(
        `SELECT supplier_id, bank_account_id, debit_amount::numeric AS dr, credit_amount::numeric AS cr
           FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [result.cloudRef]
      );
      expect(entries.rows.map((r) => [r.supplier_id, r.bank_account_id, Number(r.dr), Number(r.cr)])).toEqual([
        [supplierId, null, 125.5, 0],
        [null, bankId, 0, 125.5],
      ]);
      // Replaying the same operation finds the posted voucher.
      expect(await phase9PaymentApplyHandler.apply(client, event)).toEqual({ ...result, outcome: "already-present" });
    });
  });

  it("turns a posting refusal (a party missing in the cloud) into a reject-only conflict", async () => {
    const event = eventFrom({
      kind: "voucher.payment-receipt.v1",
      requestId: "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d",
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      actorUsername: `${PREFIX}_testuser`,
      localVoucherId: 991,
      voucher: {
        voucherType: "Receipt",
        voucherDate: "2026-11-02",
        paymentAccountType: "ledger",
        paymentAccountId: 2147480000,
        entries: [{ accountType: "customer", accountId: 2147480001, amount: "10" }],
        notes: null,
        optional: false,
        currency: "USD",
        exchangeRate: null,
        effectiveDate: null,
      },
    });
    await inRolledBackTx(async (client) => {
      await expect(phase9PaymentApplyHandler.apply(client, event)).rejects.toBeInstanceOf(Phase9EventConflict);
    });
  });
});
