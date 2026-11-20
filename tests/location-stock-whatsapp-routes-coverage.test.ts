/**
 * Location stock WhatsApp routes (server/routes/location/locationReportRoutes.ts)
 * over HTTP in one rolled-back company per test. The WhatsApp delivery service
 * is mocked at its module boundary. Refusals first: missing export or cost
 * permissions, invalid / unknown / other-company locations, invalid or foreign
 * stock groups; then every delivery outcome (running, empty, failed, sent) and
 * the audit row for a sent report.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const delivery = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("../server/services/locationStockWhatsAppDelivery", () => ({
  deliverLocationStockWhatsApp: delivery.deliver,
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const send = (w: FactoryWorld, locationId: number | string, body: Record<string, unknown> = {}) =>
  w.agent.post(`/api/locations/${locationId}/send-stock-whatsapp`).send(body);

const sent = {
  status: "sent",
  deliveryId: 41,
  duplicate: false,
  itemCount: 3,
  pageCount: 1,
  destinationGroupName: "Yard Group",
  fileName: "stock.pdf",
};

async function deniedAgent(w: FactoryWorld, keys: string[]) {
  for (const key of keys) {
    await w.q(
      `INSERT INTO role_feature_permissions (company_id, role, feature_key, enabled) VALUES ($1, 'Manager', $2, false)
       ON CONFLICT DO NOTHING`,
      [w.companyId, key]
    );
  }
  return w.agentFor("Manager");
}

beforeEach(() => {
  delivery.deliver.mockReset().mockResolvedValue(sent);
});

describe("permission refusals", () => {
  it("refuses the cost probe and cost reports without cost permissions, and sends without export permission", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get("/api/location-inventory/whatsapp/cost-capability")).body).toEqual({
        canSendWithCost: true,
      });
      const noCost = await deniedAgent(w, ["fld_total_value"]);
      expect((await noCost.get("/api/location-inventory/whatsapp/cost-capability")).status).toBe(403);
      const costReport = await noCost
        .post(`/api/locations/${w.locationId}/send-stock-whatsapp`)
        .send({ includeCost: "true" });
      expect(costReport.status).toBe(403);
      await w.q(`DELETE FROM role_feature_permissions WHERE company_id = $1 AND role = 'Manager'`, [w.companyId]);
      const noExport = await deniedAgent(w, ["exp_whatsapp_send"]);
      expect((await noExport.post(`/api/locations/${w.locationId}/send-stock-whatsapp`).send({})).status).toBe(403);
      expect(delivery.deliver).not.toHaveBeenCalled();
    }));
});

describe("request refusals", () => {
  it("refuses invalid, unknown and other-company locations and bad stock groups", () =>
    withFactoryWorld(async (w) => {
      expect((await send(w, "abc")).status).toBe(400);
      expect((await send(w, 2147483000)).status).toBe(404);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const foreignLocation = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Other') RETURNING id`,
        [other, `${w.tag}OL`]
      );
      expect((await send(w, foreignLocation)).status).toBe(404);
      const bad = await send(w, w.locationId, { stockGroupId: "zero" });
      expect(bad.status).toBe(400);
      expect(bad.body.message).toBe("Invalid stock group ID");
      const foreignGroup = await w.one(
        `INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, 'Foreign Group') RETURNING id`,
        [other, `${w.tag}FG`]
      );
      const missing = await send(w, w.locationId, { stockGroupId: foreignGroup });
      expect(missing.status).toBe(404);
      expect(delivery.deliver).not.toHaveBeenCalled();
    }));
});

describe("delivery outcomes", () => {
  it("reports a running, empty or failed delivery", () =>
    withFactoryWorld(async (w) => {
      delivery.deliver.mockResolvedValueOnce({ status: "running", deliveryId: 5 });
      const running = await send(w, w.locationId);
      expect(running.status).toBe(202);
      expect(running.body).toEqual({
        message: "This stock report is already being sent.",
        deliveryId: 5,
        duplicate: true,
      });

      delivery.deliver.mockResolvedValueOnce({ status: "skipped_empty", deliveryId: 6 });
      const emptyAll = await send(w, w.locationId);
      expect(emptyAll.status).toBe(400);
      expect(emptyAll.body.message).toBe("No stock items matched this report for the location.");

      delivery.deliver.mockResolvedValueOnce({ status: "skipped_empty", deliveryId: 7 });
      const emptyGroup = await send(w, w.locationId, { stockGroupId: "none" });
      expect(emptyGroup.body.message).toBe("No stock items matched Unassigned for this location.");

      delivery.deliver.mockResolvedValueOnce({ status: "failed", deliveryId: 8, error: "GREEN API down" });
      const failed = await send(w, w.locationId);
      expect(failed.status).toBe(502);
      expect(failed.body.message).toBe("GREEN API down");
      delivery.deliver.mockResolvedValueOnce({ status: "failed", deliveryId: 9 });
      expect((await send(w, w.locationId)).body.message).toBe("WhatsApp send failed");

      delivery.deliver.mockRejectedValueOnce(new Error("renderer crashed"));
      const crashed = await send(w, w.locationId);
      expect(crashed.status).toBe(500);
      expect(crashed.body.message).toBe("renderer crashed");
    }));

  it("sends a grouped cost report with a supplied idempotency key and audits it", () =>
    withFactoryWorld(async (w) => {
      const groupId = await w.one(
        `INSERT INTO stock_groups (company_id, code, name) VALUES ($1, $2, 'Shoes') RETURNING id`,
        [w.companyId, `${w.tag}SG`]
      );
      const res = await send(w, w.locationId, {
        includeCost: 1,
        stockGroupId: String(groupId),
        idempotencyKey: "abc:1",
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        message: "Stock PDF sent to Yard Group",
        deliveryId: 41,
        includeCost: true,
        stockGroupId: groupId,
        stockGroupName: "Shoes",
      });
      expect(delivery.deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: w.companyId,
          locationId: w.locationId,
          includeCost: true,
          stockGroupId: groupId,
          source: "manual",
          idempotencyKey: `manual:${w.companyId}:${w.locationId}:abc:1`,
        })
      );
      const audit = await w.q(
        `SELECT action, record_identifier FROM audit_log WHERE company_id = $1 AND action = 'send_location_stock_whatsapp'`,
        [w.companyId]
      );
      expect(audit).toEqual([{ action: "send_location_stock_whatsapp", record_identifier: "Yard" }]);
    }));

  it("generates a key for an unsafe idempotency key and names the default group", () =>
    withFactoryWorld(async (w) => {
      delivery.deliver.mockResolvedValueOnce({ ...sent, destinationGroupName: null });
      const res = await send(w, w.locationId, { idempotencyKey: "bad key!", stockGroupId: null });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        message: "Stock PDF sent to the linked WhatsApp group",
        includeCost: false,
        stockGroupId: null,
        stockGroupName: "Unassigned",
      });
      const key = delivery.deliver.mock.calls[0][0].idempotencyKey as string;
      expect(key).toMatch(new RegExp(`^manual:${w.companyId}:${w.locationId}:[0-9a-f-]{36}$`));
    }));
});
