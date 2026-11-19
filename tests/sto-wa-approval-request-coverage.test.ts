/**
 * Stock Transfer Order WhatsApp approval settings, request and cancel routes
 * (stockTransferOrderWaApprovalRoutes.ts) through the real HTTP app, one
 * rolled-back transaction per test. GREEN API calls are mocked at the
 * whatsappService boundary. Pins every feature gate, the MAIN-instance state
 * refusals, the group visibility check, the frozen draft (accepted, failed and
 * uncertain sends), cancel refusals - and that refusals create no batch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({
  settings: vi.fn(),
  state: vi.fn(),
  chats: vi.fn(),
  sendApproval: vi.fn(),
}));
vi.mock("../server/services/whatsappService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/whatsappService")>()),
  getWaSettings: wa.settings,
  getStrictGreenMainInstanceState: wa.state,
  fetchStrictGreenMainChats: wa.chats,
  sendStockTransferOrderApprovalRequest: wa.sendApproval,
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const GROUP = "120363000000000999@g.us";
const PHONE = "+243810000999";
const BASE = "/api/stock-transfer-order/wa-approval";
const ENV_KEYS = [
  "STO_WA_PRODUCTION_ACTIVATED",
  "STO_WA_APPROVAL_EXECUTION_ENABLED",
  "STO_WA_DELIVERY_ENABLED",
  "ENABLE_SCHEDULERS",
  "STO_WA_GREEN_API_WEBHOOK_TOKEN",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function enableAll() {
  process.env.STO_WA_PRODUCTION_ACTIVATED = "true";
  process.env.STO_WA_APPROVAL_EXECUTION_ENABLED = "true";
  process.env.STO_WA_DELIVERY_ENABLED = "true";
  process.env.ENABLE_SCHEDULERS = "true";
  process.env.STO_WA_GREEN_API_WEBHOOK_TOKEN = "t".repeat(40);
}

beforeEach(() => {
  wa.settings.mockReset().mockResolvedValue({ enabled: true, instanceId: "1101", apiToken: "tok" });
  wa.state.mockReset().mockResolvedValue("authorized");
  wa.chats.mockReset().mockResolvedValue([{ id: GROUP }]);
  wa.sendApproval.mockReset().mockResolvedValue({ outcome: "accepted", instanceId: "1101", idMessage: "BAE5-1" });
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function seed(w: FactoryWorld) {
  const destinationId = await w.one(
    `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Depot') RETURNING id`,
    [w.companyId, `${w.tag}D`]
  );
  const itemId = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Sacks', 'PCS') RETURNING id`,
    [w.companyId, `${w.tag}I`]
  );
  await w.q(`INSERT INTO stock_transfer_export_wa_groups (company_id, name, chat_id) VALUES ($1, 'Approvers', $2)`, [
    w.companyId,
    GROUP,
  ]);
  await w.q(
    `INSERT INTO stock_transfer_order_approval_settings (company_id, enabled, approval_group_chat_id, authorized_phone_e164)
     VALUES ($1, true, $2, $3)`,
    [w.companyId, GROUP, PHONE]
  );
  await w.q(
    `INSERT INTO stock_transfer_order_destination_recipients (company_id, destination_location_id, chat_id, enabled)
     VALUES ($1, $2, '243810000999@c.us', true)`,
    [w.companyId, destinationId]
  );
  const voucherId = await w.one(
    `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount)
     VALUES ($1, 'Stock Transfer', $2, '2026-03-01', 0) RETURNING id`,
    [w.companyId, `${w.tag}-STO`]
  );
  const transferId = await w.one(
    `INSERT INTO stock_transfer_vouchers (voucher_id, source_location_id, destination_location_id, workflow_origin)
     VALUES ($1, $2, $3, 'stock_transfer_order') RETURNING id`,
    [voucherId, w.locationId, destinationId]
  );
  await w.q(
    `INSERT INTO stock_transfer_items (transfer_id, stock_item_id, source_location_id, quantity, rate, total_amount)
     VALUES ($1, $2, $3, '5.000', '2.00', '10.00')`,
    [transferId, itemId, w.locationId]
  );
  const revisionId = await w.one(
    `INSERT INTO stock_transfer_revisions (transfer_id, revision_number, status, payload_hash)
     VALUES ($1, 1, 'pending', $2) RETURNING id`,
    [transferId, "a".repeat(64)]
  );
  await w.q(
    `INSERT INTO stock_transfer_revision_items (revision_id, stock_item_id, stock_item_name, source_location_id,
       original_quantity, new_quantity, delta) VALUES ($1, $2, 'Sacks', $3, 5, 7, 2)`,
    [revisionId, itemId, w.locationId]
  );
  return { destinationId, transferId };
}

const batches = (w: FactoryWorld) =>
  w.q<{ id: string; status: string; request_message_id: string | null }>(
    `SELECT id, status, request_message_id FROM stock_transfer_order_approval_batches WHERE company_id = $1 ORDER BY id`,
    [w.companyId]
  );

describe("STO WhatsApp approval settings", () => {
  it("reads the defaults and saves only valid, company-linked settings", async () => {
    await withFactoryWorld(async (w) => {
      const empty = await w.agent.get(`${BASE}/settings`);
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({
        settings: { enabled: false, approvalGroupChatId: null },
        canConfigure: true,
        connected: true,
        executionEnabled: false,
      });
      const put = (body: object) => w.agent.put(`${BASE}/settings`).send(body);
      expect((await put({ enabled: "yes" })).status).toBe(400);
      expect((await put({ enabled: true, approvalGroupChatId: GROUP })).status).toBe(400);
      expect((await put({ enabled: false, approvalGroupChatId: "bad" })).status).toBe(400);
      expect((await put({ enabled: false, authorizedPhoneE164: "0810" })).status).toBe(400);
      const unlinked = await put({ enabled: true, approvalGroupChatId: GROUP, authorizedPhoneE164: PHONE });
      expect(unlinked.status).toBe(400);
      expect(unlinked.body.message).toContain("company-linked");
      expect(
        await w.q(`SELECT 1 FROM stock_transfer_order_approval_settings WHERE company_id = $1`, [w.companyId])
      ).toEqual([]);

      await w.q(`INSERT INTO stock_transfer_export_wa_groups (company_id, name, chat_id) VALUES ($1, 'G', $2)`, [
        w.companyId,
        GROUP,
      ]);
      expect((await put({ enabled: true, approvalGroupChatId: GROUP, authorizedPhoneE164: PHONE })).status).toBe(200);
      const after = await w.agent.get(`${BASE}/settings`);
      expect(after.body.settings).toEqual({ enabled: true, approvalGroupChatId: GROUP, authorizedPhoneE164: PHONE });
      expect(after.body.groups).toEqual([expect.objectContaining({ chatId: GROUP })]);

      const manager = await w.agentFor("Manager");
      expect((await manager.put(`${BASE}/settings`).send({ enabled: false })).status).toBe(403);
      const managerView = await manager.get(`${BASE}/settings`);
      expect(managerView.status).toBe(200);
      expect(managerView.body.canConfigure).toBe(false);
    });
  });
});

describe("STO WhatsApp approval request: gates", () => {
  it("validates the selection and refuses while each feature gate is off", async () => {
    await withFactoryWorld(async (w) => {
      const { destinationId, transferId } = await seed(w);
      const post = (body: object) => w.agent.post(`${BASE}/requests`).send(body);
      const ok = { destinationLocationId: destinationId, transferIds: [transferId] };
      expect((await post({ destinationLocationId: destinationId, transferIds: [] })).status).toBe(400);
      expect((await post({ destinationLocationId: destinationId, transferIds: [1, 1] })).status).toBe(400);
      expect((await post({ destinationLocationId: "x", transferIds: [1] })).status).toBe(400);

      const exec = await post(ok);
      expect(exec.status).toBe(409);
      expect(exec.body.message).toContain("execution is not enabled");
      enableAll();
      process.env.STO_WA_DELIVERY_ENABLED = "false";
      expect((await post(ok)).body.message).toContain("delivery is paused");
      process.env.STO_WA_DELIVERY_ENABLED = "true";
      process.env.STO_WA_GREEN_API_WEBHOOK_TOKEN = "short";
      expect((await post(ok)).body.message).toContain("webhook token");
      enableAll();
      wa.settings.mockResolvedValue({ enabled: false, instanceId: "1", apiToken: "t" });
      expect((await post(ok)).body.code).toBe("STO_WA_MAIN_NOT_CONFIGURED");
      expect(await batches(w)).toEqual([]);
    });
  });

  it("maps every MAIN instance state and checks the group and destination", async () => {
    await withFactoryWorld(async (w) => {
      const { destinationId, transferId } = await seed(w);
      enableAll();
      const post = (body: object = { destinationLocationId: destinationId, transferIds: [transferId] }) =>
        w.agent.post(`${BASE}/requests`).send(body);
      for (const [state, status, text] of [
        ["invalidCredentials", 409, "rejected the MAIN"],
        ["notAuthorized", 409, "disconnected"],
        ["unknown", 503, "Unable to verify"],
        ["starting", 409, "not ready (starting)"],
      ] as const) {
        wa.state.mockResolvedValueOnce(state);
        const res = await post();
        expect(res.status).toBe(status);
        expect(res.body).toMatchObject({ code: "STO_WA_MAIN_NOT_AUTHORIZED", state });
        expect(res.body.message).toContain(text);
      }
      wa.chats.mockResolvedValueOnce([{ id: "999999@g.us" }]);
      expect((await post()).body.message).toContain("not visible");
      const missing = await post({ destinationLocationId: 999999999, transferIds: [transferId] });
      expect(missing.status).toBe(404);
      const wrongDestination = await post({ destinationLocationId: w.locationId, transferIds: [transferId] });
      expect(wrongDestination.status).toBe(409);
      expect(wrongDestination.body.code).toBe("STO_WA_DESTINATION_NOT_CONFIGURED");
      await w.q(`UPDATE stock_transfer_order_approval_settings SET enabled = false WHERE company_id = $1`, [
        w.companyId,
      ]);
      expect((await post()).body.message).toContain("approval group first");
      expect(await batches(w)).toEqual([]);
      expect(wa.sendApproval).not.toHaveBeenCalled();
    });
  });
});

describe("STO WhatsApp approval request: sending", () => {
  it("records the accepted request and refuses to reserve the order twice", async () => {
    await withFactoryWorld(async (w) => {
      const { destinationId, transferId } = await seed(w);
      enableAll();
      const body = { destinationLocationId: destinationId, transferIds: [transferId] };
      const res = await w.agent.post(`${BASE}/requests`).send(body);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, orders: 1, revisions: 1, messageId: "BAE5-1" });
      const [chatId, message] = wa.sendApproval.mock.calls[0];
      expect(chatId).toBe(GROUP);
      expect(message).toContain("Destination: Depot");
      expect(await batches(w)).toEqual([
        { id: String(res.body.batchId), status: "requested", request_message_id: "BAE5-1" },
      ]);

      const again = await w.agent.post(`${BASE}/requests`).send(body);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("STO_WA_ALREADY_RESERVED");

      expect((await w.agent.post(`${BASE}/requests/${res.body.batchId}/cancel`)).status).toBe(200);
      expect((await batches(w))[0].status).toBe("cancelled");
      const twice = await w.agent.post(`${BASE}/requests/${res.body.batchId}/cancel`);
      expect(twice.status).toBe(409);
      expect((await w.agent.post(`${BASE}/requests/abc/cancel`)).status).toBe(400);
    });
  });

  it("cancels the draft on a provider failure and keeps it on an uncertain send", async () => {
    await withFactoryWorld(async (w) => {
      const { destinationId, transferId } = await seed(w);
      enableAll();
      const body = { destinationLocationId: destinationId, transferIds: [transferId] };
      wa.sendApproval.mockResolvedValueOnce({ outcome: "failed", instanceId: "1101", error: "Group closed" });
      const failed = await w.agent.post(`${BASE}/requests`).send(body);
      expect(failed.status).toBe(502);
      expect(failed.body.message).toBe("Group closed");
      expect((await batches(w)).map((b) => b.status)).toEqual(["cancelled"]);

      wa.sendApproval.mockResolvedValueOnce({ outcome: "uncertain", instanceId: "1101", error: "timeout" });
      const uncertain = await w.agent.post(`${BASE}/requests`).send(body);
      expect(uncertain.status).toBe(202);
      expect(uncertain.body).toMatchObject({ ok: false, uncertain: true });
      const rows = await batches(w);
      expect(rows.map((b) => b.status)).toEqual(["cancelled", "draft"]);
      const events = await w.q(
        `SELECT details->>'reason' AS reason FROM stock_transfer_order_approval_events
          WHERE company_id = $1 AND batch_id = $2 AND event_type = 'ignored'`,
        [w.companyId, rows[1].id]
      );
      expect(events).toEqual([{ reason: "request_send_uncertain" }]);
    });
  });

  it("cancels the draft when the request throws before WhatsApp accepts it", async () => {
    await withFactoryWorld(async (w) => {
      const { destinationId, transferId } = await seed(w);
      enableAll();
      wa.sendApproval.mockRejectedValueOnce(new Error("socket hang up"));
      const res = await w.agent
        .post(`${BASE}/requests`)
        .send({ destinationLocationId: destinationId, transferIds: [transferId] });
      expect(res.status).toBe(500);
      expect((await batches(w)).map((b) => b.status)).toEqual(["cancelled"]);
    });
  });

  it("refuses a Viewer and a Manager cancel", async () => {
    await withFactoryWorld(async (w) => {
      const viewer = await w.agentFor("Viewer");
      expect((await viewer.post(`${BASE}/requests`).send({})).status).toBe(403);
      const manager = await w.agentFor("Manager");
      expect((await manager.post(`${BASE}/requests/1/cancel`)).status).toBe(403);
    });
  });
});
