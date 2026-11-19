/**
 * Verified DONE/DECLINE execution of a Stock Transfer Order WhatsApp approval
 * batch (server/services/stockTransferOrderWhatsAppBatchExecution.ts) against
 * the real database: skips and waits, tampered decision evidence, stale
 * snapshots turned terminal, and the all-or-nothing decline/approve paths.
 * No WhatsApp message is sent by the executor.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const edge = vi.hoisted(() => ({ lanPrimary: false, captures: [] as Array<Record<string, unknown>> }));
vi.mock("../server/edge/phase9PosOutbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/edge/phase9PosOutbox")>()),
  isPhase9LanPrimary: () => edge.lanPrimary,
}));
vi.mock("../server/edge/phase9StockOutbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/edge/phase9StockOutbox")>()),
  phase9RevisionRefTx: async (_tx: unknown, revisionId: number) => ({ revisionId }),
  capturePhase9StockTransferRevisionReviewTx: async (_tx: unknown, input: Record<string, unknown>) => {
    edge.captures.push(input);
  },
}));

import { pool } from "../server/db";
import { executeStockTransferOrderWaBatch } from "../server/services/stockTransferOrderWhatsAppBatchExecution";
import { createStockTransferOrderApprovalDraft } from "../server/services/stockTransferOrderWhatsAppApprovalBatch";
import {
  createStoWaFixture,
  STO_GROUP_CHAT,
  STO_PHONE,
  type StoWaFixture,
} from "./helpers/stockTransferOrderWaFixture";

let fx: StoWaFixture;
const SENDER = `${STO_PHONE.slice(1)}@c.us`;

beforeAll(async () => {
  fx = await createStoWaFixture("stoexe");
  await fx.configure();
});
afterEach(() => {
  edge.lanPrimary = false;
  edge.captures = [];
});
afterAll(async () => {
  // Revision items are not part of the shared fixture teardown.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `DELETE FROM stock_transfer_revision_items WHERE revision_id IN (
         SELECT r.id FROM stock_transfer_revisions r JOIN stock_transfer_vouchers t ON t.id=r.transfer_id
           JOIN vouchers v ON v.id=t.voucher_id WHERE v.company_id=$1)`,
      [fx.companyId]
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  await fx?.cleanup();
});

type Requested = { batchId: number; transferIds: number[]; revisionIds: number[]; requestMessageId: string };

async function requestedBatch(orders = 1): Promise<Requested> {
  const added = [];
  for (let i = 0; i < orders; i++) added.push(await fx.addOrder());
  const draft = await createStockTransferOrderApprovalDraft({
    companyId: fx.companyId,
    destinationLocationId: fx.destinationId,
    transferIds: added.map((o) => o.transferId),
    actorUserId: "tester",
  });
  const requestMessageId = `REQ-${randomUUID()}`;
  await pool.query(
    `UPDATE stock_transfer_order_approval_batches
        SET status='requested', requested_at=now(), whatsapp_instance_id='inst-1', request_message_id=$3
      WHERE company_id=$1 AND id=$2`,
    [fx.companyId, draft.batchId, requestMessageId]
  );
  return {
    batchId: draft.batchId,
    transferIds: added.map((o) => o.transferId),
    revisionIds: added.map((o) => Number(o.revisionId)),
    requestMessageId,
  };
}

async function decide(
  batch: Requested,
  type: "done_received" | "decline_received",
  overrides: Partial<{ sender: string; instance: string; group: string; quoted: string; message: string | null }> = {}
) {
  await pool.query(
    `INSERT INTO stock_transfer_order_approval_events
       (company_id,batch_id,event_type,sender_chat_id,provider_message_id,whatsapp_instance_id,approval_group_chat_id,details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      fx.companyId,
      batch.batchId,
      type,
      overrides.sender ?? SENDER,
      overrides.message === undefined ? `MSG-${randomUUID()}` : overrides.message,
      overrides.instance ?? "inst-1",
      overrides.group ?? STO_GROUP_CHAT,
      JSON.stringify({ quotedMessageId: overrides.quoted ?? batch.requestMessageId }),
    ]
  );
}

async function batchStatus(batchId: number) {
  const { rows } = await pool.query(`SELECT status FROM stock_transfer_order_approval_batches WHERE id=$1`, [batchId]);
  return rows[0]?.status as string | undefined;
}

async function revisionStatuses(ids: number[]) {
  const { rows } = await pool.query(
    `SELECT status FROM stock_transfer_revisions WHERE id = ANY($1::int[]) ORDER BY id`,
    [ids]
  );
  return rows.map((r) => r.status as string);
}

async function events(batchId: number) {
  const { rows } = await pool.query(
    `SELECT event_type, details FROM stock_transfer_order_approval_events WHERE batch_id=$1 ORDER BY id`,
    [batchId]
  );
  return rows as Array<{ event_type: string; details: Record<string, unknown> }>;
}

describe("executeStockTransferOrderWaBatch", () => {
  it("skips invalid and missing batch ids", async () => {
    for (const id of [0, -4, 1.5, Number.NaN]) {
      expect(await executeStockTransferOrderWaBatch(id)).toMatchObject({
        outcome: "skipped",
        reason: "invalid_batch_id",
      });
    }
    expect(await executeStockTransferOrderWaBatch(2_147_000_123)).toEqual({
      outcome: "skipped",
      batchId: 2_147_000_123,
      reason: "missing_batch",
    });
  });

  it("waits until exactly one verified decision exists", async () => {
    const batch = await requestedBatch();
    expect(await executeStockTransferOrderWaBatch(batch.batchId)).toMatchObject({
      outcome: "waiting",
      reason: "verified_decision_not_unique",
    });
    expect(await batchStatus(batch.batchId)).toBe("requested");
    expect(await revisionStatuses(batch.revisionIds)).toEqual(["pending"]);
  });

  it.each([
    ["sender", { sender: "243899999999@c.us" }],
    ["instance", { instance: "inst-2" }],
    ["group", { group: "120363999999999999@g.us" }],
    ["quoted request", { quoted: "REQ-other" }],
    ["provider message", { message: null }],
  ])("marks the batch stale when the decision %s does not match", async (_label, override) => {
    const batch = await requestedBatch();
    await decide(batch, "done_received", override);
    expect(await executeStockTransferOrderWaBatch(batch.batchId)).toMatchObject({
      outcome: "skipped",
      reason: "STO_WA_AUTH_CHANGED",
    });
    expect(await batchStatus(batch.batchId)).toBe("stale");
    expect(await revisionStatuses(batch.revisionIds)).toEqual(["pending"]);
    const log = await events(batch.batchId);
    expect(log.at(-1)).toMatchObject({
      event_type: "request_stale",
      details: { reason: "STO_WA_AUTH_CHANGED", phase: "approval_execution" },
    });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM stock_transfer_order_approval_batch_items WHERE batch_id=$1 AND reservation_active`,
      [batch.batchId]
    );
    expect(rows[0].n).toBe(0);
    expect(await executeStockTransferOrderWaBatch(batch.batchId)).toMatchObject({
      outcome: "skipped",
      reason: "batch_already_terminal",
    });
  });

  it("marks the batch stale when a frozen revision changed after the request", async () => {
    const batch = await requestedBatch();
    await pool.query(`UPDATE stock_transfer_revisions SET payload_hash=$2 WHERE id=$1`, [
      batch.revisionIds[0],
      "b".repeat(64),
    ]);
    await decide(batch, "decline_received");
    const result = await executeStockTransferOrderWaBatch(batch.batchId);
    expect(result.outcome).toBe("skipped");
    expect(await batchStatus(batch.batchId)).toBe("stale");
    expect(await revisionStatuses(batch.revisionIds)).toEqual(["pending"]);
  });

  it("declines every frozen revision in one transaction", async () => {
    const batch = await requestedBatch(2);
    await decide(batch, "decline_received");
    expect(await executeStockTransferOrderWaBatch(batch.batchId)).toEqual({
      outcome: "declined",
      batchId: batch.batchId,
      orderCount: 2,
      revisionCount: 2,
      appliedRevisions: 0,
      supersededRevisions: 0,
    });
    expect(await batchStatus(batch.batchId)).toBe("declined");
    expect(await revisionStatuses(batch.revisionIds)).toEqual(["rejected", "rejected"]);
    const log = await events(batch.batchId);
    expect(log.at(-1)).toMatchObject({ event_type: "declined", details: { orderCount: 2, revisionCount: 2 } });
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE company_id=$1 AND record_identifier LIKE 'sto-wa:%' AND record_id = ANY($2::int[])`,
      [fx.companyId, batch.revisionIds]
    );
    expect(audit.rows[0].n).toBe(2);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM stock_transfer_order_approval_deliveries WHERE batch_id=$1`,
      [batch.batchId]
    );
    expect(rows[0].n).toBe(0);
    expect(await executeStockTransferOrderWaBatch(batch.batchId)).toMatchObject({ reason: "batch_already_terminal" });
  });

  it("captures LAN review evidence for each declined revision on a LAN primary", async () => {
    edge.lanPrimary = true;
    const batch = await requestedBatch();
    await decide(batch, "decline_received");
    expect(await executeStockTransferOrderWaBatch(batch.batchId)).toMatchObject({ outcome: "declined" });
    expect(edge.captures).toEqual([
      expect.objectContaining({
        companyId: fx.companyId,
        actorUserId: `whatsapp:${STO_PHONE}`,
        decision: "reject",
        revision: { revisionId: batch.revisionIds[0] },
        reason: expect.stringContaining("Declined via WhatsApp batch"),
      }),
    ]);
  });

  it("leaves the batch requested and rethrows unexpected lifecycle failures", async () => {
    const batch = await requestedBatch();
    await decide(batch, "done_received");
    await expect(executeStockTransferOrderWaBatch(batch.batchId)).rejects.toThrow("Pending revision has no items");
    expect(await batchStatus(batch.batchId)).toBe("requested");
    expect(await revisionStatuses(batch.revisionIds)).toEqual(["pending"]);
    expect((await events(batch.batchId)).map((e) => e.event_type)).toEqual(["draft_created", "done_received"]);
  });

  it("approves every order and queues both deliveries", async () => {
    const batch = await requestedBatch();
    await pool.query(
      `INSERT INTO stock_transfer_revision_items
         (revision_id,stock_item_id,stock_item_name,source_location_id,original_quantity,new_quantity,delta)
       VALUES($1,$2,'Sacks',$3,'5.000','5.000','0.000')`,
      [batch.revisionIds[0], fx.stockItemId, fx.sourceId]
    );
    await decide(batch, "done_received");
    edge.lanPrimary = true;
    const result = await executeStockTransferOrderWaBatch(batch.batchId);
    expect(edge.captures).toEqual([expect.objectContaining({ decision: "approve", reason: null })]);
    expect(result).toMatchObject({ outcome: "approved", orderCount: 1, revisionCount: 1, appliedRevisions: 1 });
    expect(await batchStatus(batch.batchId)).toBe("approved");
    expect(await revisionStatuses(batch.revisionIds)).toEqual(["approved"]);
    const { rows } = await pool.query(
      `SELECT recipient_kind, status FROM stock_transfer_order_approval_deliveries WHERE batch_id=$1 ORDER BY recipient_kind`,
      [batch.batchId]
    );
    expect(rows).toEqual([
      { recipient_kind: "approval_group", status: "pending" },
      { recipient_kind: "destination", status: "pending" },
    ]);
  });
});
