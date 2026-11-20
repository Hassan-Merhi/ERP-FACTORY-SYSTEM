/**
 * POST /api/pos-transfer-approval/destination/:id/approve-send: the delegated
 * POS user approves every selected pending transfer to one destination and
 * the server sends one cost-free workbook to the configured WhatsApp group.
 *
 * Real HTTP in one rolled-back transaction per test; only the WhatsApp
 * provider boundary is mocked. Pinned: every preflight refusal approves
 * nothing, a failing revision rolls the whole batch back, and delivery
 * outcomes after approval.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({
  settings: vi.fn(),
  state: vi.fn(),
  chats: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../server/services/whatsappService", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWaSettings: wa.settings,
  getGreenInstanceState: wa.state,
  fetchGreenApiChats: wa.chats,
  sendWhatsAppFileToChatId: wa.send,
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const CHAT = "120363000000000999@g.us";

async function world(w: FactoryWorld, { configured = true } = {}) {
  const pos = await w.agentFor("POS");
  const [posUser] = await w.q<{ user_id: string }>(
    `SELECT user_id FROM user_company_roles WHERE company_id = $1 AND role = 'POS'`,
    [w.companyId]
  );
  const destinationId = await w.one(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop A') RETURNING id`,
    [w.companyId, `${w.tag}D`]
  );
  const stockItemId = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Sacks', 'PCS') RETURNING id`,
    [w.companyId, `${w.tag}I`]
  );
  if (configured) {
    const groupId = await w.one(
      `INSERT INTO stock_transfer_export_wa_groups (company_id, name, chat_id) VALUES ($1, 'Drivers', $2) RETURNING id`,
      [w.companyId, CHAT]
    );
    await w.q(`INSERT INTO pos_transfer_approval_settings (company_id, user_id, group_id) VALUES ($1, $2, $3)`, [
      w.companyId,
      posUser.user_id,
      groupId,
    ]);
  }
  let seq = 0;
  const addTransfer = async ({ quantity = "5.000", originalQuantity = "5.000" } = {}) => {
    seq += 1;
    const voucherId = await w.one(
      `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount)
       VALUES ($1, 'Stock Transfer', $2, '2026-03-01', 0) RETURNING id`,
      [w.companyId, `${w.tag}-ST-${seq}`]
    );
    const transferId = await w.one(
      `INSERT INTO stock_transfer_vouchers (voucher_id, source_location_id, destination_location_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [voucherId, w.locationId, destinationId]
    );
    await w.q(
      `INSERT INTO stock_transfer_items (transfer_id, stock_item_id, source_location_id, quantity, rate, total_amount)
       VALUES ($1, $2, $3, $4, '0', '0')`,
      [transferId, stockItemId, w.locationId, quantity]
    );
    const revisionId = await w.one(
      `INSERT INTO stock_transfer_revisions (transfer_id, revision_number, status) VALUES ($1, 1, 'pending') RETURNING id`,
      [transferId]
    );
    await w.q(
      `INSERT INTO stock_transfer_revision_items
         (revision_id, stock_item_id, stock_item_name, source_location_id, original_quantity, new_quantity, delta)
       VALUES ($1, $2, 'Sacks', $3, $4, $5, 0)`,
      [revisionId, stockItemId, w.locationId, originalQuantity, quantity]
    );
    return { transferId, revisionId };
  };
  const approve = (transferIds: unknown, id: number | string = destinationId) =>
    pos.post(`/api/pos-transfer-approval/destination/${id}/approve-send`).send({ transferIds });
  const statuses = async () =>
    (
      await w.q<{ status: string }>(
        `SELECT r.status FROM stock_transfer_revisions r JOIN stock_transfer_vouchers t ON t.id = r.transfer_id
          WHERE t.destination_location_id = $1 ORDER BY r.id`,
        [destinationId]
      )
    ).map((r) => r.status);
  return { pos, destinationId, addTransfer, approve, statuses };
}

beforeEach(() => {
  wa.settings.mockReset().mockResolvedValue({ instanceId: "1", apiToken: "t", enabled: true });
  wa.state.mockReset().mockResolvedValue("authorized");
  wa.chats.mockReset().mockResolvedValue([{ id: CHAT }]);
  wa.send.mockReset().mockResolvedValue({ success: true });
});

describe("destination approve-send refusals", () => {
  it("403s for non-POS roles and 400s for a bad destination or selection", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.post("/api/pos-transfer-approval/destination/1/approve-send").send({})).status).toBe(403);
      const s = await world(w);
      expect((await s.approve([1], "x")).status).toBe(400);
      for (const bad of [undefined, [], [1, 1], [0], Array.from({ length: 101 }, (_, i) => i + 1)]) {
        const res = await s.approve(bad);
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/between 1 and 100/);
      }
    });
  });

  it("403s for a POS user who is not the delegated approver", async () => {
    await withFactoryWorld(async (w) => {
      const s = await world(w, { configured: false });
      const { transferId } = await s.addTransfer();
      const res = await s.approve([transferId]);
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/not assigned/);
      expect(await s.statuses()).toEqual(["pending"]);
    });
  });

  it("409s and approves nothing while WhatsApp is disconnected, unauthorized or cannot see the group", async () => {
    await withFactoryWorld(async (w) => {
      const s = await world(w);
      const { transferId } = await s.addTransfer();
      wa.settings.mockResolvedValueOnce({ instanceId: "1", apiToken: "t", enabled: false });
      expect((await s.approve([transferId])).body.message).toMatch(/WhatsApp is disconnected/);
      wa.state.mockResolvedValueOnce("notAuthorized");
      expect((await s.approve([transferId])).body.message).toMatch(/state: notAuthorized/);
      wa.chats.mockResolvedValueOnce([{ id: "other@g.us" }]);
      expect((await s.approve([transferId])).body.message).toMatch(/not visible to the connected account/);
      wa.chats.mockRejectedValueOnce(new Error("timeout"));
      const res = await s.approve([transferId]);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/Could not verify access/);
      expect(await s.statuses()).toEqual(["pending"]);
      expect(wa.send).not.toHaveBeenCalled();
    });
  });

  it("409s when a selected transfer is not pending for this destination", async () => {
    await withFactoryWorld(async (w) => {
      const s = await world(w);
      const { transferId } = await s.addTransfer();
      const res = await s.approve([transferId, 999999999]);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/no longer pending/);
      expect(await s.statuses()).toEqual(["pending"]);
    });
  });

  it("rolls every approval back when one revision is stale", async () => {
    await withFactoryWorld(async (w) => {
      const s = await world(w);
      const good = await s.addTransfer();
      const stale = await s.addTransfer({ originalQuantity: "9.000" });
      const res = await s.approve([good.transferId, stale.transferId]);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/All changes were rolled back/);
      expect(await s.statuses()).toEqual(["pending", "pending"]);
      expect(wa.send).not.toHaveBeenCalled();
    });
  });
});

describe("destination approve-send after approval", () => {
  it("approves the batch and sends one consolidated workbook", async () => {
    await withFactoryWorld(async (w) => {
      const s = await world(w);
      const a = await s.addTransfer();
      const b = await s.addTransfer();
      const res = await s.approve([a.transferId, b.transferId]);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ approved: 2, total: 2, sent: true });
      expect(await s.statuses()).toEqual(["approved", "approved"]);
      expect(wa.send).toHaveBeenCalledTimes(1);
      expect(wa.send.mock.calls[0][0]).toBe(CHAT);
      expect(wa.send.mock.calls[0][2]).toMatch(/^Truck_Trip_Shop_A_.*_approved\.xlsx$/);
      const audit = await w.q(
        `SELECT id FROM audit_log WHERE company_id = $1 AND table_name = 'stock_transfer_revisions' AND action = 'approve'`,
        [w.companyId]
      );
      expect(audit).toHaveLength(2);
    });
  });

  it("reports rejected, uncertain and failed deliveries after approving", async () => {
    await withFactoryWorld(async (w) => {
      const s = await world(w);
      wa.send.mockResolvedValueOnce({ success: false, deliveryOutcome: "rejected" });
      const r1 = await s.approve([(await s.addTransfer()).transferId]);
      expect(r1.body).toMatchObject({ approved: 1, sent: false });
      expect(r1.body.message).toMatch(/did not accept/);
      wa.send.mockResolvedValueOnce({ success: false, deliveryOutcome: "uncertain" });
      const r2 = await s.approve([(await s.addTransfer()).transferId]);
      expect(r2.body.message).toMatch(/UNKNOWN/);
      wa.send.mockRejectedValueOnce(new Error("socket hang up"));
      const r3 = await s.approve([(await s.addTransfer()).transferId]);
      expect(r3.status).toBe(200);
      expect(r3.body.message).toMatch(/could not be confirmed/);
      expect(await s.statuses()).toEqual(["approved", "approved", "approved"]);
    });
  });

  it("approves without sending when no quantities remain", async () => {
    await withFactoryWorld(async (w) => {
      const s = await world(w);
      const { transferId } = await s.addTransfer({ quantity: "0", originalQuantity: "0" });
      const res = await s.approve([transferId]);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ approved: 1, sent: false });
      expect(res.body.message).toMatch(/no item quantities remained/);
      expect(wa.send).not.toHaveBeenCalled();
    });
  });
});
