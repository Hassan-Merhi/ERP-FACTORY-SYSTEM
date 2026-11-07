/**
 * Plan batch 4 (owner-approved 2026-11-05): Payment / Receipt vouchers edited
 * or deleted on the factory LAN server, on the full application schema.
 *
 * LAN: the edit (PATCH /api/vouchers/:id/payment-receipt) and the delete
 * (DELETE /api/vouchers/:id, once batch 4's drill is approved) each record the
 * change with a digest of the voucher as it stood, in the same transaction.
 *
 * Cloud: the change applies only while the cloud voucher still has that
 * digest. A changed voucher is held (approvable); a reconciled one is
 * reject-only; a voucher created offline is found through its create's
 * receipt. A payment the cloud replays from the LAN has the same digest as
 * the LAN's own voucher, which is what makes the match check work.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import request from "supertest";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

const SITE = randomUUID();
const edge = vi.hoisted(() => ({
  config: { mode: "cloud", primary: false, siteId: null } as Record<string, unknown>,
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFactoryEdgeConfiguration: () => edge.config,
}));

import { pool, type DbTransaction } from "../server/db";
import { ensurePhase9PaymentOutboxSchema } from "../server/edge/phase9PaymentOutbox";
import { hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";
import { phase9OverridableConflicts, validatePhase9Event } from "../server/edge/phase9EventProtocol.mjs";
import { ensurePhase9CloudEventSchema, Phase9EventConflict } from "../server/edge/phase9CloudEventStore.mjs";
import { phase9PaymentApplyHandler, type Phase9PaymentEvent } from "../server/edge/phase9PaymentApply";
import {
  PHASE9_PAYMENT_CHANGED_CONFLICT,
  phase9PaymentDeleteEnvelope,
  phase9PaymentEditEnvelope,
  type Phase9PaymentVoucherInputs,
  type Phase9PaymentVoucherRef,
} from "../server/edge/phase9PaymentEnvelope.mjs";
import {
  phase9PaymentDeleteApplyHandler,
  phase9PaymentEditApplyHandler,
} from "../server/edge/phase9PaymentFollowUpApply";
import { phase9PaymentSnapshotTx } from "../server/edge/phase9PaymentSnapshot";
import { PHASE9_PERIOD_CLOSED } from "../server/edge/phase9ClosedPeriod";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "p9payfu";
const LAN = { mode: "lan", primary: true, siteId: SITE, approvedPlanBatches: [4] };
const LAN_UNAPPROVED = { mode: "lan", primary: true, siteId: SITE, approvedPlanBatches: [] };
const CLOUD = { mode: "cloud", primary: false, siteId: null };
let ctx: TestContext;
let agent: ReturnType<typeof request.agent>;
let supplierId: number;
let bankId: number;
let seq = 0;

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

const txOf = (client: PoolClient) => drizzle(client, { schema }) as unknown as DbTransaction;

function wrap(payload: { kind: string; requestId: string; localVoucherId: number }) {
  seq += 1;
  const event = {
    sequence: String(seq),
    operationId: payload.requestId,
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    kind: payload.kind,
    localRef: payload.localVoucherId,
    payload,
    payloadSha256: hashEvidence(payload),
  };
  validatePhase9Event("payments", event);
  return event;
}

function inputs(amount: string): Phase9PaymentVoucherInputs {
  return {
    voucherType: "Payment",
    voucherDate: "2026-11-05",
    paymentAccountType: "supplier",
    paymentAccountId: supplierId,
    entries: [{ accountType: "bank", accountId: bankId, amount }],
    notes: "Offline payment edit",
    optional: false,
    currency: "USD",
    exchangeRate: null,
    effectiveDate: null,
  };
}

function actor() {
  return {
    companyId: ctx.companyId,
    actorUserId: ctx.userId,
    actorUsername: `${PREFIX}_testuser`,
    requestId: randomUUID(),
  };
}

function editEvent(ref: Phase9PaymentVoucherRef, localVoucherId: number, beforeSha256: string, amount: string) {
  return wrap(
    phase9PaymentEditEnvelope({ ...actor(), localVoucherId, voucherRef: ref, beforeSha256, voucher: inputs(amount) })
  );
}

async function replay(
  client: PoolClient,
  handler: { authorize: Function; apply: Function; verify: Function },
  event: unknown,
  overrideConflicts: string[] = []
) {
  await handler.authorize(client, event);
  const result = await handler.apply(client, event, { overrideConflicts, siteId: SITE });
  expect(await handler.verify(client, event, result)).toBe(true);
  return result as { outcome: string; cloudRef: number };
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

async function postPayment(amount: string): Promise<number> {
  const response = await agent.post("/api/vouchers/payment-receipt").send({
    voucherType: "Payment",
    voucherDate: "2026-11-05",
    paymentAccountType: "supplier",
    paymentAccountId: supplierId,
    entries: [{ accountType: "bank", accountId: bankId, amount }],
    notes: "Offline payment edit",
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return Number(response.body.voucher.id);
}

async function snapshot(voucherId: number): Promise<string> {
  return inRolledBackTx(async (client) =>
    String(await phase9PaymentSnapshotTx(txOf(client), ctx.companyId, voucherId))
  );
}

async function outbox(kind: string) {
  const rows = await pool.query(
    "SELECT payload FROM factory_edge_payment_outbox WHERE site_id = $1 AND operation_kind = $2 ORDER BY sequence",
    [SITE, kind]
  );
  return rows.rows.map((row) => row.payload);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  // The delete route is Admin-only.
  await pool.query("UPDATE user_company_roles SET role = 'Admin' WHERE user_id = $1 AND company_id = $2", [
    ctx.userId,
    ctx.companyId,
  ]);
  const supplier = await pool.query(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, active, stock_group_id)
     VALUES ($1, $2, 'Offline Supplier', 'offline@p9payfu.test', '0', true, $3) RETURNING id`,
    [ctx.companyId, `${PREFIX}-SUP-${ctx.companyId}`, ctx.stockGroupId]
  );
  supplierId = Number(supplier.rows[0].id);
  const bank = await pool.query(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, opening_balance, opening_balance_side, active)
     VALUES ($1, $2, 'Factory Bank', 'Factory Bank', 'P9FU-001', '0', 'Dr', true) RETURNING id`,
    [ctx.companyId, `${PREFIX}-BANK-${ctx.companyId}`]
  );
  bankId = Number(bank.rows[0].id);
  edge.config = LAN;
  await ensurePhase9PaymentOutboxSchema(pool);
  edge.config = CLOUD;
  await ensurePhase9CloudEventSchema(pool);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  edge.config = CLOUD;
  await pool.query("ALTER TABLE factory_edge_payment_outbox DISABLE TRIGGER factory_edge_payment_outbox_no_mutation");
  await pool.query("DELETE FROM factory_edge_payment_outbox WHERE site_id = $1", [SITE]);
  await pool.query("ALTER TABLE factory_edge_payment_outbox ENABLE TRIGGER factory_edge_payment_outbox_no_mutation");
  await pool.query("DELETE FROM factory_edge_payment_counter WHERE site_id = $1", [SITE]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60_000);

describe("Payment edits and deletes on the factory LAN server", () => {
  it("records an edit of an offline payment with the voucher's digest from before the edit", async () => {
    edge.config = LAN;
    try {
      const voucherId = await postPayment("100");
      const before = await snapshot(voucherId);
      const edited = await agent.patch(`/api/vouchers/${voucherId}/payment-receipt`).send({
        voucherType: "Payment",
        voucherDate: "2026-11-05",
        paymentAccountType: "supplier",
        paymentAccountId: supplierId,
        entries: [{ accountType: "bank", accountId: bankId, amount: "150" }],
        notes: "Offline payment edit",
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      const [edit] = await outbox("voucher.payment-receipt-edit.v1");
      expect(edit).toMatchObject({
        localVoucherId: voucherId,
        voucherRef: { origin: "lan", localVoucherId: voucherId },
        beforeSha256: before,
      });
      expect(edit.voucher.entries).toEqual([{ accountType: "bank", accountId: bankId, amount: "150" }]);
      expect(await snapshot(voucherId)).not.toBe(before);
    } finally {
      edge.config = CLOUD;
    }
  });

  it("records a delete only once batch 4's drill is approved on this server", async () => {
    edge.config = LAN;
    let voucherId: number;
    try {
      voucherId = await postPayment("40");
    } finally {
      edge.config = CLOUD;
    }
    edge.config = LAN_UNAPPROVED;
    try {
      const refused = await agent.delete(`/api/vouchers/${voucherId}`);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("EDGE_VOUCHER_DELETE_OFFLINE_SALES_ONLY");
    } finally {
      edge.config = CLOUD;
    }
    const before = await snapshot(voucherId);
    edge.config = LAN;
    try {
      expect((await agent.delete(`/api/vouchers/${voucherId}`)).status).toBe(200);
    } finally {
      edge.config = CLOUD;
    }
    const deletes = await outbox("voucher.payment-receipt-delete.v1");
    expect(deletes.at(-1)).toMatchObject({ localVoucherId: voucherId, beforeSha256: before });
  });
});

describe("Cloud replay of payment edits and deletes", () => {
  it("gives a payment replayed from the LAN the same digest as the LAN's own voucher", async () => {
    edge.config = LAN;
    let lanVoucherId: number;
    try {
      lanVoucherId = await postPayment("77.25");
    } finally {
      edge.config = CLOUD;
    }
    const [created] = (await outbox("voucher.payment-receipt.v1")).filter(
      (row: { localVoucherId: number }) => row.localVoucherId === lanVoucherId
    );
    await inRolledBackTx(async (client) => {
      const event = wrap(created) as unknown as Phase9PaymentEvent;
      const result = await phase9PaymentApplyHandler.apply(client, event);
      expect(result.cloudRef).not.toBe(lanVoucherId);
      expect(await phase9PaymentSnapshotTx(txOf(client), ctx.companyId, result.cloudRef)).toBe(
        await phase9PaymentSnapshotTx(txOf(client), ctx.companyId, lanVoucherId)
      );
    });
  });

  it("applies an edit while the voucher matches, holds it once the cloud changed it, applies it when approved", async () => {
    const voucherId = await postPayment("200");
    const before = await snapshot(voucherId);
    const ref = { origin: "cloud" as const, voucherId };
    await inRolledBackTx(async (client) => {
      const applied = await replay(client, phase9PaymentEditApplyHandler, editEvent(ref, voucherId, before, "260"));
      expect(applied).toMatchObject({ outcome: "cloud-applied", cloudRef: voucherId });
      const amounts = await client.query(
        "SELECT sum(debit_amount)::numeric AS d FROM voucher_entries WHERE voucher_id = $1",
        [voucherId]
      );
      expect(Number(amounts.rows[0].d)).toBe(260);

      const stale = editEvent(ref, voucherId, before, "90");
      expect(await conflictCode(replay(client, phase9PaymentEditApplyHandler, stale))).toBe(
        PHASE9_PAYMENT_CHANGED_CONFLICT
      );
      expect(phase9OverridableConflicts("payments", stale.kind)).toContain(PHASE9_PAYMENT_CHANGED_CONFLICT);
      expect(
        (await replay(client, phase9PaymentEditApplyHandler, stale, [PHASE9_PAYMENT_CHANGED_CONFLICT])).outcome
      ).toBe("cloud-applied");
    });
  });

  it("holds an edit of a reconciled payment as reject-only", async () => {
    const voucherId = await postPayment("55");
    const before = await snapshot(voucherId);
    await inRolledBackTx(async (client) => {
      const statement = await client.query(
        `INSERT INTO accounting_cash_bank_statements
           (company_id, account_kind, account_id, currency, period_start, period_end, opening_balance,
            closing_balance, file_hash, file_name, imported_by)
         VALUES ($1, 'bank', $2, 'USD', '2026-11-01', '2026-11-30', 0, 0, $3, 'p9.csv', $4) RETURNING id`,
        [ctx.companyId, bankId, randomUUID(), ctx.userId]
      );
      const line = await client.query(
        `INSERT INTO accounting_cash_bank_statement_lines (company_id, statement_id, row_number, transaction_date, amount)
         VALUES ($1, $2, 1, '2026-11-05', -55) RETURNING id`,
        [ctx.companyId, statement.rows[0].id]
      );
      const entry = await client.query("SELECT id FROM voucher_entries WHERE voucher_id = $1 LIMIT 1", [voucherId]);
      await client.query(
        `INSERT INTO accounting_cash_bank_matches (company_id, statement_line_id, voucher_entry_id, matched_on, matched_by)
         VALUES ($1, $2, $3, '2026-11-05', $4)`,
        [ctx.companyId, line.rows[0].id, entry.rows[0].id, ctx.userId]
      );
      const event = editEvent({ origin: "cloud", voucherId }, voucherId, before, "60");
      expect(await conflictCode(replay(client, phase9PaymentEditApplyHandler, event))).toBe(
        "PHASE9_PAYMENT_RECONCILED"
      );
      expect(phase9OverridableConflicts("payments", event.kind)).not.toContain("PHASE9_PAYMENT_RECONCILED");
    });
  });

  it("holds a payment create, edit or delete dated in a closed period as reject-only instead of stopping the stream", async () => {
    const voucherId = await postPayment("70");
    const before = await snapshot(voucherId);
    await inRolledBackTx(async (client) => {
      const retained = await client.query("SELECT id FROM ledger_accounts WHERE company_id = $1 ORDER BY id LIMIT 1", [
        ctx.companyId,
      ]);
      await client.query(
        `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
           closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
         VALUES ($1, '2026-11-01', '2026-11-30', $2, $3, $4, 0, 0, 0, 'CLOSED')`,
        [ctx.companyId, ctx.userId, voucherId, retained.rows[0].id]
      );
      edge.config = LAN;
      let lanVoucherId: number;
      try {
        lanVoucherId = await postPayment("71");
      } finally {
        edge.config = CLOUD;
      }
      const [created] = (await outbox("voucher.payment-receipt.v1")).filter(
        (row: { localVoucherId: number }) => row.localVoucherId === lanVoucherId
      );
      await client.query("SAVEPOINT closed_create");
      expect(
        await conflictCode(phase9PaymentApplyHandler.apply(client, wrap(created) as unknown as Phase9PaymentEvent))
      ).toBe(PHASE9_PERIOD_CLOSED);
      await client.query("ROLLBACK TO SAVEPOINT closed_create");
      const edit = editEvent({ origin: "cloud", voucherId }, voucherId, before, "75");
      await client.query("SAVEPOINT closed_edit");
      // The edit and delete services refuse a closed-period voucher themselves.
      const editCode = await conflictCode(replay(client, phase9PaymentEditApplyHandler, edit));
      expect(editCode).toBe("PHASE9_PAYMENT_EDIT_REFUSED");
      expect(phase9OverridableConflicts("payments", edit.kind)).not.toContain(editCode);
      expect(phase9OverridableConflicts("payments", "voucher.payment-receipt.v1")).not.toContain(PHASE9_PERIOD_CLOSED);
      await client.query("ROLLBACK TO SAVEPOINT closed_edit");
      const remove = wrap(
        phase9PaymentDeleteEnvelope({
          ...actor(),
          localVoucherId: voucherId,
          voucherRef: { origin: "cloud", voucherId },
          beforeSha256: before,
        })
      );
      const deleteCode = await conflictCode(replay(client, phase9PaymentDeleteApplyHandler, remove));
      expect(["PHASE9_PAYMENT_DELETE_REFUSED", PHASE9_PERIOD_CLOSED]).toContain(deleteCode);
      expect(phase9OverridableConflicts("payments", remove.kind)).not.toContain(deleteCode);
    });
  });

  it("deletes a payment created offline (found through its create's receipt) once, and refuses one whose create was rejected", async () => {
    const voucherId = await postPayment("33");
    const before = await snapshot(voucherId);
    await inRolledBackTx(async (client) => {
      const mark = async (localRef: number, cloudRef: number | null) =>
        client.query(
          `INSERT INTO factory_edge_applied_events
             (site_id, stream, sequence, operation_id, company_id, actor_user_id, operation_kind,
              local_ref, cloud_ref, payload_sha256, business_date, outcome)
           VALUES ($1, 'payments', $2, $3, $4, $5, 'voucher.payment-receipt.v1', $6, $7, $8, $9, $10)`,
          [
            SITE,
            500_000 + localRef,
            randomUUID(),
            ctx.companyId,
            ctx.userId,
            localRef,
            cloudRef,
            "0".repeat(64),
            cloudRef === null ? null : "2026-11-05",
            cloudRef === null ? "rejected-conflict" : "cloud-applied",
          ]
        );
      await mark(910_001, voucherId);
      const remove = () =>
        wrap(
          phase9PaymentDeleteEnvelope({
            ...actor(),
            localVoucherId: 910_001,
            voucherRef: { origin: "lan", localVoucherId: 910_001 },
            beforeSha256: before,
          })
        );
      expect(await replay(client, phase9PaymentDeleteApplyHandler, remove())).toMatchObject({
        outcome: "cloud-applied",
        cloudRef: voucherId,
      });
      expect((await replay(client, phase9PaymentDeleteApplyHandler, remove())).outcome).toBe("already-present");

      await mark(910_002, null);
      const orphan = wrap(
        phase9PaymentDeleteEnvelope({
          ...actor(),
          localVoucherId: 910_002,
          voucherRef: { origin: "lan", localVoucherId: 910_002 },
          beforeSha256: before,
        })
      );
      expect(await conflictCode(replay(client, phase9PaymentDeleteApplyHandler, orphan))).toBe(
        "PHASE9_PAYMENT_MISSING"
      );
    });
  });
});
