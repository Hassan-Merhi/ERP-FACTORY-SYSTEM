/**
 * Administrator reconciliation of approved Stock Transfer Order WhatsApp Excel
 * deliveries (server/services/stockTransferOrderWaDeliveryReconciliation.ts)
 * against the real database, inside one rolled-back transaction per test.
 * Refusals come first: invalid identifiers, unknown / unapproved batches,
 * missing delivery records, same-chat aliasing, stale status, provider ids,
 * retry limits and frozen-recipient drift, each leaving the rows unchanged.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";

import {
  reconcileStockTransferOrderWaDelivery,
  StockTransferOrderDeliveryReconciliationError,
} from "../server/services/stockTransferOrderWaDeliveryReconciliation";
import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createStoWaFixture, STO_DEST_CHAT, STO_GROUP_CHAT, STO_PHONE } from "./helpers/stockTransferOrderWaFixture";

const REASON = "Checked WhatsApp chat and GREEN API journal for this batch.";
const VERIFY = {
  action: "verify_delivered",
  expectedStatus: "uncertain",
  reason: REASON,
  checkedWhatsApp: true,
  checkedProvider: true,
  confirmedDelivered: true,
};
const RETRY = {
  action: "authorize_retry",
  expectedStatus: "failed",
  reason: REASON,
  checkedWhatsApp: true,
  checkedProvider: true,
  confirmedNotDelivered: true,
  acknowledgeDuplicateRisk: true,
};

interface World {
  client: PoolClient;
  companyId: number;
  batch: (opts?: { status?: string; instance?: string | null; frozenDest?: string | null }) => Promise<number>;
  delivery: (
    batchId: number,
    kind: "approval_group" | "destination",
    chat: string,
    status: string,
    opts?: { provider?: string | null; retries?: number }
  ) => Promise<number>;
  row: (id: number) => Promise<{ status: string; manual_retry_count: number; attempt_count: number }>;
  events: (batchId: number) => Promise<Array<{ event_type: string; details: Record<string, unknown> }>>;
}

function inWorld(work: (w: World) => Promise<void>) {
  return withRolledBackPool(async (client) => {
    const fx = await createStoWaFixture("storec");
    const companyId = fx.companyId;
    await work({
      client,
      companyId,
      async batch({ status = "approved", instance = "inst-1", frozenDest = STO_DEST_CHAT } = {}) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO stock_transfer_order_approval_batches
             (company_id,destination_location_id,approval_group_chat_id,authorized_phone_e164,created_by,status,
              whatsapp_instance_id,request_message_id)
           VALUES($1,$2,$3,$4,'tester',$5,$6,$7) RETURNING id`,
          [
            companyId,
            fx.destinationId,
            STO_GROUP_CHAT,
            STO_PHONE,
            status,
            instance,
            instance ? `req-${randomUUID()}` : null,
          ]
        );
        const batchId = Number(rows[0].id);
        if (frozenDest !== null) {
          await client.query(
            `INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details)
             VALUES($1,$2,'draft_created',$3::jsonb)`,
            [companyId, batchId, JSON.stringify({ destinationRecipientChatId: frozenDest })]
          );
        }
        return batchId;
      },
      async delivery(batchId, kind, chat, status, { provider = null, retries = 0 } = {}) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO stock_transfer_order_approval_deliveries
             (company_id,batch_id,recipient_kind,recipient_chat_id,status,provider_message_id,manual_retry_count,attempt_count)
           VALUES($1,$2,$3,$4,$5,$6,$7,2) RETURNING id`,
          [companyId, batchId, kind, chat, status, provider, retries]
        );
        return Number(rows[0].id);
      },
      async row(id) {
        const { rows } = await client.query(
          "SELECT status,manual_retry_count,attempt_count FROM stock_transfer_order_approval_deliveries WHERE id=$1",
          [id]
        );
        return rows[0];
      },
      async events(batchId) {
        const { rows } = await client.query(
          "SELECT event_type,details FROM stock_transfer_order_approval_events WHERE batch_id=$1 AND event_type<>'draft_created' ORDER BY id",
          [batchId]
        );
        return rows;
      },
    });
  });
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(StockTransferOrderDeliveryReconciliationError);
  const typed = error as StockTransferOrderDeliveryReconciliationError;
  return { status: typed.status, message: typed.message };
}

const call = (companyId: number, batchId: number, recipientKind: string, payload: unknown, actorId = "admin-1") =>
  reconcileStockTransferOrderWaDelivery({
    companyId,
    batchId,
    recipientKind: recipientKind as "approval_group",
    actorId,
    payload,
  });

describe("input refusals", () => {
  it("rejects invalid company, batch, recipient and administrator before touching the database", async () => {
    for (const [companyId, batchId, kind, actor] of [
      [0, 1, "approval_group", "a"],
      [1.5, 1, "approval_group", "a"],
      [1, -1, "approval_group", "a"],
      [1, 1, "customer", "a"],
      [1, 1, "destination", ""],
      [1, 1, "destination", "x".repeat(256)],
    ] as const) {
      expect(await refusal(call(companyId, batchId, kind, VERIFY, actor))).toMatchObject({ status: 400 });
    }
  });

  it("rejects an invalid evidence payload with 400", async () => {
    expect(await refusal(call(1, 1, "approval_group", { ...VERIFY, reason: "short" }))).toMatchObject({
      status: 400,
    });
  });
});

describe("batch and record refusals", () => {
  it("refuses an unknown batch and a batch from another company", () =>
    inWorld(async (w) => {
      const batchId = await w.batch();
      expect(await refusal(call(w.companyId, batchId + 100000, "approval_group", VERIFY))).toMatchObject({
        status: 404,
      });
      expect(await refusal(call(w.companyId + 100000, batchId, "approval_group", VERIFY))).toMatchObject({
        status: 404,
      });
    }));

  it("refuses a batch that is not fully approved", () =>
    inWorld(async (w) => {
      const batchId = await w.batch({ status: "declined" });
      const { message, status } = await refusal(call(w.companyId, batchId, "approval_group", VERIFY));
      expect(status).toBe(409);
      expect(message).toMatch(/fully approved/);
    }));

  it("refuses when either frozen delivery record is missing", () =>
    inWorld(async (w) => {
      const batchId = await w.batch();
      const group = await w.delivery(batchId, "approval_group", STO_GROUP_CHAT, "uncertain");
      expect(await refusal(call(w.companyId, batchId, "approval_group", VERIFY))).toMatchObject({
        status: 409,
        message: expect.stringMatching(/Both frozen/),
      });
      expect(await w.row(group)).toMatchObject({ status: "uncertain" });
    }));

  it("refuses the destination record when both recipients are the same chat", () =>
    inWorld(async (w) => {
      const batchId = await w.batch({ frozenDest: STO_GROUP_CHAT });
      await w.delivery(batchId, "approval_group", STO_GROUP_CHAT, "uncertain");
      const dest = await w.delivery(batchId, "destination", STO_GROUP_CHAT, "uncertain");
      expect(await refusal(call(w.companyId, batchId, "destination", VERIFY))).toMatchObject({
        status: 409,
        message: expect.stringMatching(/same chat/),
      });
      expect(await w.row(dest)).toMatchObject({ status: "uncertain" });
      expect(await w.events(batchId)).toEqual([]);
    }));

  it("refuses a stale expected status, a provider message id and an in-flight same-chat delivery", () =>
    inWorld(async (w) => {
      const stale = await w.batch();
      await w.delivery(stale, "approval_group", STO_GROUP_CHAT, "failed");
      await w.delivery(stale, "destination", STO_DEST_CHAT, "failed");
      expect(await refusal(call(w.companyId, stale, "approval_group", VERIFY))).toMatchObject({
        status: 409,
        message: expect.stringMatching(/status changed/),
      });

      const provider = await w.batch();
      await w.delivery(provider, "approval_group", STO_GROUP_CHAT, "uncertain", { provider: "BAE5-1" });
      await w.delivery(provider, "destination", STO_DEST_CHAT, "uncertain");
      expect(await refusal(call(w.companyId, provider, "approval_group", VERIFY))).toMatchObject({
        status: 409,
        message: expect.stringMatching(/message ID/),
      });

      const sending = await w.batch({ frozenDest: STO_GROUP_CHAT });
      await w.delivery(sending, "approval_group", STO_GROUP_CHAT, "uncertain");
      await w.delivery(sending, "destination", STO_GROUP_CHAT, "sending");
      expect(await refusal(call(w.companyId, sending, "approval_group", VERIFY))).toMatchObject({
        status: 409,
        message: expect.stringMatching(/being processed/),
      });
    }));

  it("refuses a fourth manual retry authorization", () =>
    inWorld(async (w) => {
      const batchId = await w.batch();
      const group = await w.delivery(batchId, "approval_group", STO_GROUP_CHAT, "failed", { retries: 3 });
      await w.delivery(batchId, "destination", STO_DEST_CHAT, "failed");
      expect(await refusal(call(w.companyId, batchId, "approval_group", RETRY))).toMatchObject({
        status: 409,
        message: expect.stringMatching(/limit reached/),
      });
      expect(await w.row(group)).toMatchObject({ status: "failed", manual_retry_count: 3 });
    }));

  it("refuses when the frozen destination, group chat or instance drifted", () =>
    inWorld(async (w) => {
      const cases = [
        { batch: { frozenDest: null }, dest: STO_DEST_CHAT, group: STO_GROUP_CHAT },
        { batch: { frozenDest: "243000000000@c.us" }, dest: STO_DEST_CHAT, group: STO_GROUP_CHAT },
        { batch: {}, dest: STO_DEST_CHAT, group: "120363000000000999@g.us" },
        { batch: { instance: null }, dest: STO_DEST_CHAT, group: STO_GROUP_CHAT },
      ];
      for (const c of cases) {
        const batchId = await w.batch(c.batch);
        const group = await w.delivery(batchId, "approval_group", c.group, "uncertain");
        await w.delivery(batchId, "destination", c.dest, "uncertain");
        expect(await refusal(call(w.companyId, batchId, "approval_group", VERIFY))).toMatchObject({
          status: 409,
          message: expect.stringMatching(/frozen batch/),
        });
        expect(await w.row(group)).toMatchObject({ status: "uncertain" });
      }
    }));
});

describe("successful reconciliation", () => {
  it("verifies a destination delivery and records an audit event", () =>
    inWorld(async (w) => {
      const batchId = await w.batch();
      const group = await w.delivery(batchId, "approval_group", STO_GROUP_CHAT, "accepted");
      const dest = await w.delivery(batchId, "destination", STO_DEST_CHAT, "uncertain");
      const result = await call(w.companyId, batchId, "destination", VERIFY, "admin-7");
      expect(result).toEqual({
        ok: true,
        status: "verified",
        recipientKind: "destination",
        batchId,
        sameChatReconciled: false,
        manualRetryCount: 0,
      });
      expect(await w.row(dest)).toMatchObject({ status: "verified" });
      expect(await w.row(group)).toMatchObject({ status: "accepted" });
      const events = await w.events(batchId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_type: "delivery_manually_verified",
        details: { administratorId: "admin-7", deliveryId: dest, priorStatus: "uncertain", sameChat: false },
      });
    }));

  it("authorizes a retry, resetting attempts and counting the manual retry", () =>
    inWorld(async (w) => {
      const batchId = await w.batch();
      const group = await w.delivery(batchId, "approval_group", STO_GROUP_CHAT, "failed", { retries: 1 });
      await w.delivery(batchId, "destination", STO_DEST_CHAT, "accepted");
      const result = await call(w.companyId, batchId, "approval_group", RETRY);
      expect(result).toMatchObject({ status: "pending", manualRetryCount: 2 });
      expect(await w.row(group)).toEqual({ status: "pending", manual_retry_count: 2, attempt_count: 0 });
      expect((await w.events(batchId)).map((e) => e.event_type)).toEqual(["delivery_manual_retry"]);
    }));

  it("deduplicates the same-chat destination record when verifying the group", () =>
    inWorld(async (w) => {
      const batchId = await w.batch({ frozenDest: STO_GROUP_CHAT });
      await w.delivery(batchId, "approval_group", STO_GROUP_CHAT, "uncertain");
      const dest = await w.delivery(batchId, "destination", STO_GROUP_CHAT, "failed");
      const result = await call(w.companyId, batchId, "approval_group", VERIFY);
      expect(result).toMatchObject({ status: "verified", sameChatReconciled: true });
      expect(await w.row(dest)).toMatchObject({ status: "verified" });
      const events = await w.events(batchId);
      expect(events.map((e) => e.event_type)).toEqual(["delivery_manually_verified", "delivery_manually_verified"]);
      expect(events[1].details).toMatchObject({ recipientKind: "destination", sameChatDeduplicated: true });
    }));

  it("re-queues the same-chat destination record when authorizing a group retry", () =>
    inWorld(async (w) => {
      const batchId = await w.batch({ frozenDest: STO_GROUP_CHAT });
      await w.delivery(batchId, "approval_group", STO_GROUP_CHAT, "failed");
      const dest = await w.delivery(batchId, "destination", STO_GROUP_CHAT, "uncertain");
      const result = await call(w.companyId, batchId, "approval_group", RETRY);
      expect(result).toMatchObject({ status: "pending", sameChatReconciled: true, manualRetryCount: 1 });
      expect(await w.row(dest)).toMatchObject({ status: "pending", attempt_count: 0, manual_retry_count: 0 });
      expect((await w.events(batchId)).map((e) => e.event_type)).toEqual([
        "delivery_manual_retry",
        "delivery_manual_retry",
      ]);
    }));

  it("leaves an already accepted same-chat destination record alone", () =>
    inWorld(async (w) => {
      const batchId = await w.batch({ frozenDest: STO_GROUP_CHAT });
      await w.delivery(batchId, "approval_group", STO_GROUP_CHAT, "uncertain");
      const dest = await w.delivery(batchId, "destination", STO_GROUP_CHAT, "accepted");
      await call(w.companyId, batchId, "approval_group", VERIFY);
      expect(await w.row(dest)).toMatchObject({ status: "accepted" });
      expect(await w.events(batchId)).toHaveLength(1);
    }));
});
