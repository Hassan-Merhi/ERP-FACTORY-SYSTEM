/**
 * Approved Stock Transfer Order Excel delivery worker
 * (server/services/stockTransferOrderWaDeliveryWorker.ts) against the real
 * database. The GREEN API upload is mocked at the whatsappService boundary.
 * Covers the feature gate, same-chat de-duplication, the frozen-destination
 * guard, workbook checksum refusals, failed / uncertain outcomes (never
 * auto-retried as a duplicate) and expired-claim quarantine.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({
  send: vi.fn(),
  // Runs inside the render, e.g. to let a "second worker" persist its copy first.
  beforeRender: null as null | (() => Promise<Buffer | void>),
}));
vi.mock("../server/services/whatsappService", () => ({
  sendApprovedStockTransferOrderWorkbook: wa.send,
}));
vi.mock("../server/services/stockTransferNoCostWorkbook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/stockTransferNoCostWorkbook")>();
  return {
    ...actual,
    createNoCostExcel: async (params: Parameters<typeof actual.createNoCostExcel>[0]) => {
      const hook = wa.beforeRender;
      wa.beforeRender = null;
      const replaced = hook ? await hook() : undefined;
      return replaced ?? actual.createNoCostExcel(params);
    },
  };
});

import { pool } from "../server/db";
import { snapshotSha256 } from "../server/services/stockTransferOrderApprovedWorkbookSnapshot";
import {
  queueStockTransferOrderWaDeliveries,
  quarantineExpiredStockTransferOrderWaClaims,
  startStockTransferOrderWaDeliveryWorker,
  stockTransferOrderWaDeliveryEnabled,
  sweepStockTransferOrderWaDeliveries,
} from "../server/services/stockTransferOrderWaDeliveryWorker";
import {
  createStoWaFixture,
  STO_DEST_CHAT,
  STO_GROUP_CHAT,
  STO_PHONE,
  type StoWaFixture,
} from "./helpers/stockTransferOrderWaFixture";

let fx: StoWaFixture;
const savedEnv = {
  STO_WA_PRODUCTION_ACTIVATED: process.env.STO_WA_PRODUCTION_ACTIVATED,
  STO_WA_DELIVERY_ENABLED: process.env.STO_WA_DELIVERY_ENABLED,
  ENABLE_SCHEDULERS: process.env.ENABLE_SCHEDULERS,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeAll(async () => {
  fx = await createStoWaFixture("stodel");
});
afterAll(async () => {
  restoreEnv();
  await fx?.cleanup();
});
beforeEach(() => {
  process.env.STO_WA_PRODUCTION_ACTIVATED = "true";
  process.env.STO_WA_DELIVERY_ENABLED = "true";
  process.env.ENABLE_SCHEDULERS = "true";
  // Each upload is its own WhatsApp message with its own provider id.
  wa.send.mockReset().mockImplementation(async () => ({ outcome: "accepted", idMessage: `BAE5-${randomUUID()}` }));
});
afterEach(async () => {
  // Park whatever a case left eligible so later sweeps only see their own rows.
  await pool.query(
    "UPDATE stock_transfer_order_approval_deliveries SET status='failed',attempt_count=3 WHERE company_id=$1 AND status IN ('pending','failed')",
    [fx.companyId]
  );
});

type WorkbookMode = "fresh" | "none" | "bad-snapshot" | "rendered" | "rendered-bad";

async function approvedBatch(opts: { workbook?: WorkbookMode; frozenDest?: string; instance?: string | null } = {}) {
  const instance = opts.instance === undefined ? "inst-1" : opts.instance;
  const batch = await pool.query<{ id: string; batch_key: string }>(
    `INSERT INTO stock_transfer_order_approval_batches
       (company_id,destination_location_id,approval_group_chat_id,authorized_phone_e164,created_by,status,
        whatsapp_instance_id,request_message_id)
     VALUES($1,$2,$3,$4,'tester','approved',$5,$6) RETURNING id,batch_key`,
    [fx.companyId, fx.destinationId, STO_GROUP_CHAT, STO_PHONE, instance, instance ? randomUUID() : null]
  );
  const batchId = Number(batch.rows[0].id);
  await pool.query(
    `INSERT INTO stock_transfer_order_approval_events(company_id,batch_id,event_type,details)
     VALUES($1,$2,'draft_created',$3::jsonb)`,
    [fx.companyId, batchId, JSON.stringify({ destinationRecipientChatId: opts.frozenDest ?? STO_DEST_CHAT })]
  );
  const mode = opts.workbook ?? "fresh";
  if (mode !== "none") {
    const snapshot = {
      companyName: "Coverage Co",
      destinationName: "Main Depot",
      transferDate: "2026-03-01",
      batchKey: batch.rows[0].batch_key,
      orderNumbers: ["STO-1"],
      items: [{ stockItemName: "Sacks", sourceLocationName: "Source", quantity: 5 }],
    };
    const bytes = mode.startsWith("rendered") ? Buffer.from("persisted workbook") : null;
    const bytesHash = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
    await pool.query(
      `INSERT INTO stock_transfer_order_approval_workbooks
         (company_id,batch_id,snapshot_json,snapshot_sha256,workbook_bytes,workbook_sha256,filename,rendered_at)
       VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,CASE WHEN $5::bytea IS NULL THEN NULL ELSE now() END)`,
      [
        fx.companyId,
        batchId,
        JSON.stringify(snapshot),
        mode === "bad-snapshot" ? "0".repeat(64) : snapshotSha256(snapshot),
        bytes,
        mode === "rendered-bad" ? "f".repeat(64) : bytesHash,
        bytes ? "persisted.xlsx" : null,
      ]
    );
  }
  return batchId;
}

async function delivery(
  batchId: number,
  kind: "approval_group" | "destination",
  chat: string,
  extra: Record<string, unknown> = {}
) {
  const columns = ["company_id", "batch_id", "recipient_kind", "recipient_chat_id", ...Object.keys(extra)];
  const values = [fx.companyId, batchId, kind, chat, ...Object.values(extra)];
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO stock_transfer_order_approval_deliveries(${columns.join(",")})
     VALUES(${values.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    values
  );
  return Number(rows[0].id);
}

async function deliveryRow(id: number) {
  const { rows } = await pool.query(
    "SELECT status,provider_message_id,attempt_count,last_error,filename,available_at>now() AS backed_off FROM stock_transfer_order_approval_deliveries WHERE id=$1",
    [id]
  );
  return rows[0];
}

async function events(batchId: number): Promise<string[]> {
  const { rows } = await pool.query<{ event_type: string }>(
    "SELECT event_type FROM stock_transfer_order_approval_events WHERE company_id=$1 AND batch_id=$2 ORDER BY id",
    [fx.companyId, batchId]
  );
  return rows.map((r) => r.event_type);
}

describe("feature gate", () => {
  it("stays off unless production activation and schedulers are on", async () => {
    process.env.STO_WA_PRODUCTION_ACTIVATED = "false";
    expect(stockTransferOrderWaDeliveryEnabled()).toBe(false);
    expect(await sweepStockTransferOrderWaDeliveries()).toBe(0);
    process.env.STO_WA_PRODUCTION_ACTIVATED = "true";
    process.env.STO_WA_DELIVERY_ENABLED = "false";
    expect(stockTransferOrderWaDeliveryEnabled()).toBe(false);
    process.env.STO_WA_DELIVERY_ENABLED = "true";
    process.env.ENABLE_SCHEDULERS = "false";
    expect(stockTransferOrderWaDeliveryEnabled()).toBe(false);
    queueStockTransferOrderWaDeliveries(1);
    startStockTransferOrderWaDeliveryWorker();
    expect(wa.send).not.toHaveBeenCalled();
  });
});

describe("approved workbook delivery", () => {
  it("renders once and delivers to the group and the frozen destination", async () => {
    const batchId = await approvedBatch();
    const group = await delivery(batchId, "approval_group", STO_GROUP_CHAT);
    const dest = await delivery(batchId, "destination", STO_DEST_CHAT);
    expect(await sweepStockTransferOrderWaDeliveries()).toBeGreaterThanOrEqual(2);
    expect(await deliveryRow(group)).toMatchObject({
      status: "accepted",
      provider_message_id: expect.stringMatching(/^BAE5-/),
      attempt_count: 1,
    });
    expect(await deliveryRow(dest)).toMatchObject({ status: "accepted" });
    expect(wa.send).toHaveBeenCalledTimes(2);
    const [instance, chat, buffer, filename] = wa.send.mock.calls[0];
    expect([instance, chat]).toEqual(["inst-1", STO_GROUP_CHAT]);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(filename).toMatch(/^Truck_Trip_Main_Depot_2026-03-01_[0-9a-f]{8}_approved\.xlsx$/);
    const wb = await pool.query(
      "SELECT workbook_sha256 IS NOT NULL AS stored FROM stock_transfer_order_approval_workbooks WHERE batch_id=$1",
      [batchId]
    );
    expect(wb.rows[0].stored).toBe(true);
    expect(await events(batchId)).toEqual(["draft_created", "delivery_accepted", "delivery_accepted"]);
  });

  it("re-sends the persisted workbook bytes instead of rendering again", async () => {
    const batchId = await approvedBatch({ workbook: "rendered" });
    const group = await delivery(batchId, "approval_group", STO_GROUP_CHAT);
    await sweepStockTransferOrderWaDeliveries();
    expect(await deliveryRow(group)).toMatchObject({ status: "accepted", filename: "persisted.xlsx" });
    expect(wa.send.mock.calls[0][2].toString()).toBe("persisted workbook");
  });

  it("refuses to send when the snapshot or stored workbook checksum does not match", async () => {
    for (const workbook of ["bad-snapshot", "rendered-bad"] as const) {
      const batchId = await approvedBatch({ workbook });
      const group = await delivery(batchId, "approval_group", STO_GROUP_CHAT);
      await sweepStockTransferOrderWaDeliveries();
      expect(await deliveryRow(group)).toMatchObject({ status: "pending", attempt_count: 0 });
    }
    expect(wa.send).not.toHaveBeenCalled();
  });

  it("waits while no workbook is frozen or the batch has no request instance", async () => {
    const noWorkbook = await approvedBatch({ workbook: "none" });
    const a = await delivery(noWorkbook, "approval_group", STO_GROUP_CHAT);
    const noInstance = await approvedBatch({ instance: null });
    const b = await delivery(noInstance, "approval_group", STO_GROUP_CHAT);
    await sweepStockTransferOrderWaDeliveries();
    expect(await deliveryRow(a)).toMatchObject({ status: "pending", attempt_count: 0 });
    expect(await deliveryRow(b)).toMatchObject({ status: "pending", attempt_count: 0 });
    expect(wa.send).not.toHaveBeenCalled();
  });

  it("records a rejected upload as failed with backoff, and a thrown upload as uncertain", async () => {
    wa.send.mockResolvedValueOnce({ outcome: "failed", error: "GREEN API rejected the upload (HTTP 400)." });
    const first = await approvedBatch();
    const failed = await delivery(first, "approval_group", STO_GROUP_CHAT);
    await sweepStockTransferOrderWaDeliveries();
    expect(await deliveryRow(failed)).toMatchObject({ status: "failed", attempt_count: 1, backed_off: true });
    expect(await events(first)).toContain("delivery_failed");

    wa.send.mockRejectedValueOnce(new Error("socket hang up"));
    const second = await approvedBatch();
    const uncertain = await delivery(second, "approval_group", STO_GROUP_CHAT);
    await sweepStockTransferOrderWaDeliveries();
    expect(await deliveryRow(uncertain)).toMatchObject({ status: "uncertain", last_error: "socket hang up" });
    await sweepStockTransferOrderWaDeliveries();
    expect(wa.send).toHaveBeenCalledTimes(2);
  });

  it("refuses a destination that no longer matches the frozen recipient", async () => {
    const batchId = await approvedBatch({ frozenDest: "243810000555@c.us" });
    const dest = await delivery(batchId, "destination", STO_DEST_CHAT);
    await sweepStockTransferOrderWaDeliveries();
    expect(await deliveryRow(dest)).toMatchObject({
      status: "failed",
      attempt_count: 3,
      last_error: "Recipient no longer matches the originally approved destination",
    });
    expect(await events(batchId)).toContain("delivery_failed");
    expect(wa.send).not.toHaveBeenCalled();
  });
});

describe("concurrent renderers", () => {
  it("sends the copy another worker persisted first", async () => {
    const batchId = await approvedBatch();
    const group = await delivery(batchId, "approval_group", STO_GROUP_CHAT);
    const winner = Buffer.from("rendered by another worker");
    wa.beforeRender = async () => {
      await pool.query(
        `UPDATE stock_transfer_order_approval_workbooks SET workbook_bytes=$2,workbook_sha256=$3,filename='winner.xlsx',
           rendered_at=now() WHERE batch_id=$1`,
        [batchId, winner, createHash("sha256").update(winner).digest("hex")]
      );
    };
    await sweepStockTransferOrderWaDeliveries();
    expect(await deliveryRow(group)).toMatchObject({ status: "accepted", filename: "winner.xlsx" });
    expect(wa.send.mock.calls[0][2].toString()).toBe("rendered by another worker");
  });

  it("refuses an empty rendered workbook", async () => {
    const batchId = await approvedBatch();
    const group = await delivery(batchId, "approval_group", STO_GROUP_CHAT);
    wa.beforeRender = async () => Buffer.alloc(0);
    await sweepStockTransferOrderWaDeliveries();
    expect(await deliveryRow(group)).toMatchObject({ status: "pending", attempt_count: 0 });
    expect(wa.send).not.toHaveBeenCalled();
  });
});

describe("same chat for group and destination", () => {
  it("re-uses the group upload instead of sending twice", async () => {
    const batchId = await approvedBatch({ frozenDest: STO_GROUP_CHAT });
    await delivery(batchId, "approval_group", STO_GROUP_CHAT);
    const dest = await delivery(batchId, "destination", STO_GROUP_CHAT);
    await sweepStockTransferOrderWaDeliveries();
    expect(wa.send).toHaveBeenCalledTimes(1);
    const primary = await pool.query(
      "SELECT provider_message_id FROM stock_transfer_order_approval_deliveries WHERE batch_id=$1 AND recipient_kind='approval_group'",
      [batchId]
    );
    expect(await deliveryRow(dest)).toMatchObject({
      status: "accepted",
      provider_message_id: primary.rows[0].provider_message_id,
    });
  });

  it("follows the group delivery when it was verified, failed for good or uncertain", async () => {
    const cases = [
      { primary: { status: "verified" }, expected: "verified" },
      { primary: { status: "failed", attempt_count: 3 }, expected: "failed" },
      { primary: { status: "uncertain" }, expected: "uncertain" },
      { primary: { status: "pending", available_at: "2999-01-01" }, expected: "pending" },
    ];
    for (const c of cases) {
      const batchId = await approvedBatch({ frozenDest: STO_GROUP_CHAT });
      await delivery(batchId, "approval_group", STO_GROUP_CHAT, c.primary);
      const dest = await delivery(batchId, "destination", STO_GROUP_CHAT);
      await sweepStockTransferOrderWaDeliveries();
      expect((await deliveryRow(dest)).status, JSON.stringify(c.primary)).toBe(c.expected);
    }
    expect(wa.send).not.toHaveBeenCalled();
  });
});

describe("expired claims", () => {
  it("quarantines a send whose claim expired as uncertain, with an event", async () => {
    const batchId = await approvedBatch();
    const id = await delivery(batchId, "approval_group", STO_GROUP_CHAT, {
      status: "sending",
      claim_token: randomUUID(),
      claim_expires_at: "2000-01-01T00:00:00Z",
      attempt_count: 1,
    });
    expect(await quarantineExpiredStockTransferOrderWaClaims()).toBeGreaterThanOrEqual(1);
    expect(await deliveryRow(id)).toMatchObject({ status: "uncertain" });
    expect(await events(batchId)).toContain("delivery_uncertain");
  });

  it("queues a sweep for a valid batch id and ignores invalid ones", async () => {
    const batchId = await approvedBatch();
    const id = await delivery(batchId, "approval_group", STO_GROUP_CHAT);
    queueStockTransferOrderWaDeliveries(0);
    queueStockTransferOrderWaDeliveries(batchId);
    await vi.waitFor(async () => expect((await deliveryRow(id)).status).toBe("accepted"));
  });

  it("starts the interval worker once", async () => {
    const batchId = await approvedBatch();
    const id = await delivery(batchId, "approval_group", STO_GROUP_CHAT);
    startStockTransferOrderWaDeliveryWorker();
    startStockTransferOrderWaDeliveryWorker();
    await vi.waitFor(async () => expect((await deliveryRow(id)).status).toBe("accepted"));
    expect(wa.send).toHaveBeenCalledTimes(1);
    // The unref'd timer stays; it sweeps nothing once the gate is closed.
    restoreEnv();
  });
});
