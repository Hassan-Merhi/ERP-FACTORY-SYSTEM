/**
 * Stock Transfer Order WhatsApp approval snapshots
 * (server/services/stockTransferOrderWhatsAppApprovalBatch.ts) against the real
 * database: every refusal of createStockTransferOrderApprovalDraft, and every
 * staleness check of assertStockTransferOrderApprovalBatchCurrent. Nothing here
 * sends a message; the service never does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../server/db";
import {
  assertStockTransferOrderApprovalBatchCurrent,
  createStockTransferOrderApprovalDraft,
  stockTransferOrderIntegerIdArray,
  StockTransferOrderApprovalError,
} from "../server/services/stockTransferOrderWhatsAppApprovalBatch";
import {
  createStoWaFixture,
  STO_DEST_CHAT,
  STO_GROUP_CHAT,
  type StoWaFixture,
} from "./helpers/stockTransferOrderWaFixture";

let fx: StoWaFixture;

beforeAll(async () => {
  fx = await createStoWaFixture("stobat");
});
afterAll(async () => {
  await fx?.cleanup();
});

async function draft(
  transferIds: number[],
  overrides: Partial<{ companyId: number; destinationLocationId: number; actorUserId: string }> = {}
) {
  return createStockTransferOrderApprovalDraft({
    companyId: fx.companyId,
    destinationLocationId: fx.destinationId,
    transferIds,
    actorUserId: "tester",
    ...overrides,
  });
}

async function refusal(work: Promise<unknown>): Promise<{ code: string; step?: string }> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(StockTransferOrderApprovalError);
    const e = error as StockTransferOrderApprovalError & { stoApprovalStep?: string };
    return { code: e.code, step: e.stoApprovalStep };
  }
  throw new Error("expected a refusal");
}

async function assertCurrent(batchId: number) {
  return db.transaction((tx) => assertStockTransferOrderApprovalBatchCurrent(tx, fx.companyId, batchId));
}

async function batchCount(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM stock_transfer_order_approval_batches WHERE company_id=$1",
    [fx.companyId]
  );
  return rows[0].n;
}

describe("createStockTransferOrderApprovalDraft refusals", () => {
  it("refuses an empty, invalid, duplicate or oversized selection", async () => {
    expect(() => stockTransferOrderIntegerIdArray([])).toThrow(StockTransferOrderApprovalError);
    for (const ids of [[], [0], [1.5], [7, 7], Array.from({ length: 101 }, (_, i) => i + 1)]) {
      expect((await refusal(draft(ids))).code).toBe("STO_WA_BAD_SELECTION");
    }
  });

  it("refuses a missing company, destination or user", async () => {
    expect((await refusal(draft([1], { companyId: 0 }))).code).toBe("STO_WA_INVALID_CONTEXT");
    expect((await refusal(draft([1], { destinationLocationId: -1 }))).code).toBe("STO_WA_INVALID_CONTEXT");
    expect((await refusal(draft([1], { actorUserId: "  " }))).code).toBe("STO_WA_INVALID_CONTEXT");
    expect((await refusal(draft([1], { actorUserId: "x".repeat(256) }))).code).toBe("STO_WA_INVALID_CONTEXT");
  });

  it("refuses while approval is not configured, and records the failed step", async () => {
    const order = await fx.addOrder();
    const result = await refusal(draft([order.transferId]));
    expect(result).toEqual({ code: "STO_WA_NOT_CONFIGURED", step: "read_approval_settings" });
    await fx.configure({ enabled: false, recipient: false });
    expect((await refusal(draft([order.transferId]))).code).toBe("STO_WA_NOT_CONFIGURED");
  });

  it("refuses a destination without an enabled WhatsApp recipient", async () => {
    await fx.configure({ enabled: true, recipient: false });
    const order = await fx.addOrder();
    const result = await refusal(draft([order.transferId]));
    expect(result).toEqual({ code: "STO_WA_DESTINATION_NOT_CONFIGURED", step: "read_destination_recipient" });
    await fx.configure({ enabled: true, recipient: true });
  });

  it("refuses orders for another destination or company", async () => {
    const other = await fx.addOrder({ destinationId: fx.otherDestinationId });
    expect((await refusal(draft([other.transferId]))).code).toBe("STO_WA_SCOPE");
    expect((await refusal(draft([2_147_000_001]))).code).toBe("STO_WA_SCOPE");
    expect(await batchCount()).toBe(0);
  });

  it("refuses orders without pending revisions or without stock lines", async () => {
    const noRevision = await fx.addOrder({ revision: false });
    expect((await refusal(draft([noRevision.transferId]))).code).toBe("STO_WA_NO_REVISIONS");
    const noLines = await fx.addOrder({ lines: false });
    const empty = await refusal(draft([noLines.transferId]));
    expect(empty).toEqual({ code: "STO_WA_EMPTY_ORDER", step: "read_current_stock_transfer_lines" });
    expect(await batchCount()).toBe(0);
  });

  it("freezes a draft once and refuses a second live request for the same order", async () => {
    const a = await fx.addOrder();
    const b = await fx.addOrder();
    const created = await draft([b.transferId, a.transferId]);
    expect(created).toMatchObject({
      destinationLocationId: fx.destinationId,
      transferCount: 2,
      revisionCount: 2,
      approvalGroupChatId: STO_GROUP_CHAT,
    });
    const event = await pool.query(
      "SELECT details FROM stock_transfer_order_approval_events WHERE company_id=$1 AND batch_id=$2",
      [fx.companyId, created.batchId]
    );
    expect(event.rows[0].details).toEqual({ destinationRecipientChatId: STO_DEST_CHAT });
    expect((await refusal(draft([a.transferId]))).code).toBe("STO_WA_ALREADY_RESERVED");
    expect(await batchCount()).toBe(1);

    const snapshot = await assertCurrent(created.batchId);
    expect(snapshot).toMatchObject({
      batchId: created.batchId,
      batchKey: created.batchKey,
      transferIds: [a.transferId, b.transferId].sort((x, y) => x - y),
      status: "draft",
    });
    expect(snapshot.revisionIds).toHaveLength(2);
    // Release the reservation so later cases may freeze new batches.
    await pool.query(
      "UPDATE stock_transfer_order_approval_batch_items SET reservation_active=false WHERE batch_id=$1",
      [created.batchId]
    );
    expect((await refusal(assertCurrent(created.batchId))).code).toBe("STO_WA_BATCH_STALE");
  });
});

describe("assertStockTransferOrderApprovalBatchCurrent staleness checks", () => {
  async function freshBatch() {
    const order = await fx.addOrder();
    const created = await draft([order.transferId]);
    return { ...order, batchId: created.batchId };
  }
  async function release(batchId: number) {
    await pool.query(
      "UPDATE stock_transfer_order_approval_batch_items SET reservation_active=false WHERE batch_id=$1",
      [batchId]
    );
  }

  it("refuses a missing or no longer pending batch", async () => {
    expect((await refusal(assertCurrent(2_147_000_002))).code).toBe("STO_WA_BATCH_INACTIVE");
    const { batchId } = await freshBatch();
    await pool.query("UPDATE stock_transfer_order_approval_batches SET status='cancelled' WHERE id=$1", [batchId]);
    expect((await refusal(assertCurrent(batchId))).code).toBe("STO_WA_BATCH_INACTIVE");
    await release(batchId);
  });

  it("refuses when an order moved to another destination", async () => {
    const { batchId, transferId } = await freshBatch();
    await pool.query("UPDATE stock_transfer_vouchers SET destination_location_id=$1 WHERE id=$2", [
      fx.otherDestinationId,
      transferId,
    ]);
    expect((await refusal(assertCurrent(batchId))).code).toBe("STO_WA_BATCH_STALE");
    await release(batchId);
  });

  it("refuses when the order lines changed", async () => {
    const { batchId, transferId } = await freshBatch();
    await pool.query("UPDATE stock_transfer_items SET quantity='6.000' WHERE transfer_id=$1", [transferId]);
    expect((await refusal(assertCurrent(batchId))).code).toBe("STO_WA_BATCH_STALE");
    await release(batchId);
  });

  it("refuses when a pending revision was reviewed meanwhile", async () => {
    const { batchId, revisionId } = await freshBatch();
    await pool.query("UPDATE stock_transfer_revisions SET status='rejected' WHERE id=$1", [revisionId]);
    expect((await refusal(assertCurrent(batchId))).code).toBe("STO_WA_BATCH_STALE");
    await release(batchId);
  });

  it("refuses after the approval settings changed", async () => {
    const { batchId } = await freshBatch();
    await pool.query(
      "UPDATE stock_transfer_order_approval_settings SET updated_at=now()+interval '1 minute' WHERE company_id=$1",
      [fx.companyId]
    );
    expect((await refusal(assertCurrent(batchId))).code).toBe("STO_WA_AUTH_CHANGED");
    await pool.query(
      "UPDATE stock_transfer_order_approval_settings SET updated_at=now()-interval '1 hour' WHERE company_id=$1",
      [fx.companyId]
    );
    await release(batchId);
  });

  it("refuses after the destination recipient changed", async () => {
    const { batchId } = await freshBatch();
    await pool.query(
      "UPDATE stock_transfer_order_destination_recipients SET chat_id='243810000999@c.us' WHERE company_id=$1",
      [fx.companyId]
    );
    expect((await refusal(assertCurrent(batchId))).code).toBe("STO_WA_DESTINATION_CHANGED");
    await release(batchId);
  });
});
