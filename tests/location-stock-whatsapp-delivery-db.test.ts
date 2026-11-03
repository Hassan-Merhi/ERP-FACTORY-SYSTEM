/**
 * Per-location WhatsApp stock report deliveries against PostgreSQL: the
 * idempotent claim, every destination and PDF guard, the send outcome and the
 * stale-delivery recovery. The PDF renderer and WhatsApp send are stubbed; the
 * delivery rows are real, in a rolled-back transaction.
 */
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const h = vi.hoisted(() => ({ pdf: vi.fn(), send: vi.fn(), release: vi.fn() }));
vi.mock("../server/helpers/generateStockPdf", () => ({ generateStockPdf: (...args: unknown[]) => h.pdf(...args) }));
vi.mock("../server/helpers/exportAttachmentSource", () => ({
  releaseManagedExportAttachment: (...args: unknown[]) => h.release(...args),
}));
vi.mock("../server/services/whatsappService", () => ({
  sendWhatsAppFileToChatIdPos: (...args: unknown[]) => h.send(...args),
}));

import { logger } from "../server/lib/logger";
import {
  deliverLocationStockWhatsApp,
  recordLocationStockDeliveryFailure,
  recoverStaleLocationStockDeliveries,
  type LocationStockDeliveryRequest,
} from "../server/services/locationStockWhatsAppDelivery";

let seq = 0;
const PDF = Buffer.from("%PDF-stock");

interface World {
  companyId: number;
  locationId: number;
}

async function world(
  client: PoolClient,
  destination: { chatId?: string | null; groupName?: string | null; enabled?: boolean } | null = {}
): Promise<World> {
  const tag = `LSW${process.pid}x${++seq}`;
  const companyId = Number(
    (await client.query("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [tag, "Acme Ltd"])).rows[0].id
  );
  const locationId = Number(
    (
      await client.query("INSERT INTO locations(company_id,code,name) VALUES($1,$2,$3) RETURNING id", [
        companyId,
        tag,
        "Main Store / Kitwe",
      ])
    ).rows[0].id
  );
  if (destination) {
    await client.query(
      `INSERT INTO location_whatsapp_stock_reports(location_id,company_id,whatsapp_group_chat_id,whatsapp_group_name,enabled)
       VALUES($1,$2,$3,$4,$5)`,
      [
        locationId,
        companyId,
        destination.chatId === undefined ? " 120363@g.us " : destination.chatId,
        destination.groupName === undefined ? "Kitwe stock" : destination.groupName,
        destination.enabled ?? true,
      ]
    );
  }
  return { companyId, locationId };
}

const request = (w: World, over: Partial<LocationStockDeliveryRequest> = {}): LocationStockDeliveryRequest => ({
  companyId: w.companyId,
  locationId: w.locationId,
  includeCost: false,
  source: "manual",
  idempotencyKey: `lsw-${process.pid}-${++seq}`,
  reportDate: "2026-10-20",
  ...over,
});

async function delivery(client: PoolClient, id: number) {
  return (
    await client.query(
      `SELECT status, error, item_count, page_count, file_name, include_cost, include_zero_stock, include_negative_stock,
              stock_group_id, stock_group_unassigned, category_id, destination_chat_id, destination_group_name,
              report_generated_at IS NOT NULL AS generated, completed_at IS NOT NULL AS completed, source, retry_of_id
         FROM location_whatsapp_stock_deliveries WHERE id=$1`,
      [id]
    )
  ).rows[0];
}

beforeEach(() => {
  h.pdf.mockReset().mockResolvedValue({ buffer: PDF, pageCount: 2, rowCount: 25 });
  h.send.mockReset().mockResolvedValue({ success: true });
  h.release.mockReset().mockResolvedValue(undefined);
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
  vi.spyOn(logger, "error").mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deliverLocationStockWhatsApp", () => {
  it("renders the location's PDF, sends it to the linked group and records the delivery", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const outcome = await deliverLocationStockWhatsApp(
        request(w, { includeCost: true, includeZeroStock: true, stockGroupId: null, initiatedByUserId: null })
      );
      expect(outcome).toEqual({
        deliveryId: expect.any(Number),
        status: "sent",
        duplicate: false,
        itemCount: 25,
        pageCount: 2,
        fileName: "Main_Store___Kitwe_Godown_20261020_with_cost.pdf",
        error: null,
        destinationGroupName: "Kitwe stock",
      });
      expect(h.pdf).toHaveBeenCalledWith(w.companyId, "Acme Ltd", w.locationId, "Main Store / Kitwe", true, null, {
        includeZeroStock: true,
        includeNegativeStock: true,
        categoryId: null,
      });
      expect(h.send).toHaveBeenCalledWith(
        "120363@g.us",
        PDF,
        "Main_Store___Kitwe_Godown_20261020_with_cost.pdf",
        "Stock Report — Main Store / Kitwe — With Cost",
        "application/pdf"
      );
      expect(h.release).toHaveBeenCalledWith(PDF);
      expect(await delivery(client, outcome.deliveryId)).toMatchObject({
        status: "sent",
        error: null,
        item_count: 25,
        page_count: 2,
        include_cost: true,
        include_zero_stock: true,
        include_negative_stock: true,
        stock_group_id: null,
        stock_group_unassigned: true,
        destination_chat_id: "120363@g.us",
        destination_group_name: "Kitwe stock",
        generated: true,
        completed: true,
      });
      expect(logger.info).toHaveBeenCalledWith(
        "[LocationStockWhatsAppDelivery] sent",
        expect.objectContaining({ deliveryId: outcome.deliveryId, rowCount: 25, groupName: "Kitwe stock" })
      );
    });
  });

  it("returns the first result for a repeated idempotency key without sending again", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const req = request(w, { includeNegativeStock: false, categoryId: null });
      const first = await deliverLocationStockWhatsApp(req);
      const again = await deliverLocationStockWhatsApp(req);
      expect(again).toEqual({ ...first, duplicate: true });
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.pdf.mock.calls[0][6]).toMatchObject({ includeZeroStock: false, includeNegativeStock: false });
      expect(await delivery(client, first.deliveryId)).toMatchObject({
        include_negative_stock: false,
        stock_group_unassigned: false,
      });
    });
  });

  it("fails without sending when the location has no usable destination", async () => {
    await withRolledBackPool(async (client) => {
      const cases: Array<[Parameters<typeof world>[1], string]> = [
        [null, "No WhatsApp group is linked to this location"],
        [{ chatId: "   ", enabled: false }, "No WhatsApp group is linked to this location"],
        [{ chatId: "260971234567@c.us" }, "The linked WhatsApp destination is not a valid group"],
        [{ enabled: false }, "WhatsApp stock reports are disabled for this location"],
      ];
      for (const [destination, error] of cases) {
        const w = await world(client, destination);
        const outcome = await deliverLocationStockWhatsApp(request(w));
        expect(outcome).toMatchObject({ status: "failed", duplicate: false, itemCount: null, fileName: null, error });
        expect(await delivery(client, outcome.deliveryId)).toMatchObject({ status: "failed", error, completed: true });
      }
      expect(h.pdf).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    });
  });

  it("records an empty report as skipped without sending it", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      h.pdf.mockResolvedValue({ buffer: PDF, pageCount: 1, rowCount: 0 });
      const outcome = await deliverLocationStockWhatsApp(request(w, { reportDate: "" }));
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      expect(outcome).toMatchObject({
        status: "skipped_empty",
        itemCount: 0,
        pageCount: 1,
        fileName: `Main_Store___Kitwe_Godown_${today}_no_cost.pdf`,
        error: null,
      });
      expect(await delivery(client, outcome.deliveryId)).toMatchObject({
        status: "skipped_empty",
        item_count: 0,
        generated: true,
      });
      expect(h.send).not.toHaveBeenCalled();
      expect(h.release).toHaveBeenCalledWith(PDF);
    });
  });

  it("rejects a PDF with far more pages than its rows need", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      // 40 rows allow ceil(40 / 20) + 5 = 7 pages.
      h.pdf.mockResolvedValue({ buffer: PDF, pageCount: 7, rowCount: 40 });
      expect((await deliverLocationStockWhatsApp(request(w))).status).toBe("sent");
      h.pdf.mockResolvedValue({ buffer: PDF, pageCount: 8, rowCount: 40 });
      const outcome = await deliverLocationStockWhatsApp(request(w));
      expect(outcome).toMatchObject({
        status: "failed",
        itemCount: 40,
        pageCount: 8,
        error: "PDF safety guard rejected 8 pages for 40 rows",
      });
      expect(await delivery(client, outcome.deliveryId)).toMatchObject({
        status: "failed",
        page_count: 8,
        generated: true,
      });
      expect(h.send).toHaveBeenCalledTimes(1);
    });
  });

  it("records a failed WhatsApp send", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      h.send.mockResolvedValueOnce({ success: false, error: "Group not found" });
      const failed = await deliverLocationStockWhatsApp(request(w));
      expect(failed).toMatchObject({ status: "failed", itemCount: 25, error: "Group not found" });
      expect(await delivery(client, failed.deliveryId)).toMatchObject({ status: "failed", error: "Group not found" });

      h.send.mockResolvedValueOnce({ success: false });
      expect((await deliverLocationStockWhatsApp(request(w))).error).toBe("WhatsApp send failed");
      expect(h.release).toHaveBeenCalledTimes(2);
    });
  });

  it("records a thrown error as a failed delivery, trimming long messages", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      h.pdf.mockRejectedValueOnce(new Error("x".repeat(1200)));
      const outcome = await deliverLocationStockWhatsApp(request(w));
      expect(outcome).toMatchObject({ status: "failed", itemCount: null, error: "x".repeat(1200) });
      expect((await delivery(client, outcome.deliveryId)).error).toBe("x".repeat(1000));
      expect(logger.error).toHaveBeenCalledWith(
        "[LocationStockWhatsAppDelivery] failed",
        expect.objectContaining({ deliveryId: outcome.deliveryId, source: "manual" })
      );

      h.send.mockRejectedValueOnce("");
      const blank = await deliverLocationStockWhatsApp(request(w));
      expect(blank.error).toBe("Unexpected server error");
      expect(h.release).toHaveBeenCalledWith(PDF);
    });
  });

  it("refuses a location outside the company", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const other = await world(client);
      await expect(deliverLocationStockWhatsApp(request({ ...w, companyId: other.companyId }))).rejects.toThrow(
        "Location not found for the active company"
      );
    });
  });
});

describe("recordLocationStockDeliveryFailure", () => {
  it("stores a failure once per idempotency key", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const req = request(w, { source: "scheduled", scheduledFor: "2026-10-20T16:00:00Z", stockGroupId: undefined });
      const failed = await recordLocationStockDeliveryFailure(req, "Schedule misconfigured");
      expect(failed).toEqual({
        deliveryId: expect.any(Number),
        status: "failed",
        duplicate: false,
        itemCount: null,
        pageCount: null,
        fileName: null,
        error: "Schedule misconfigured",
        destinationGroupName: "Kitwe stock",
      });
      expect(await delivery(client, failed.deliveryId)).toMatchObject({
        status: "failed",
        source: "scheduled",
        stock_group_unassigned: false,
      });
      expect(await recordLocationStockDeliveryFailure(req, "other")).toEqual({ ...failed, duplicate: true });

      const retry = await recordLocationStockDeliveryFailure(
        request(w, { source: "retry", retryOfId: failed.deliveryId }),
        "still broken"
      );
      expect((await delivery(client, retry.deliveryId)).retry_of_id).toBe(String(failed.deliveryId));
    });
  });
});

describe("recoverStaleLocationStockDeliveries", () => {
  it("fails deliveries left running for over twenty minutes and their schedules", async () => {
    await withRolledBackPool(async (client) => {
      await client.query("UPDATE location_whatsapp_stock_deliveries SET status='failed' WHERE status='running'");
      expect(await recoverStaleLocationStockDeliveries()).toBe(0);
      expect(logger.warn).not.toHaveBeenCalled();

      const w = await world(client);
      await client.query(
        "INSERT INTO location_whatsapp_stock_schedules(location_id,company_id,enabled,last_status) VALUES($1,$2,true,'running')",
        [w.locationId, w.companyId]
      );
      const insert = (key: string, startedAgo: string, error: string | null = null) =>
        client.query(
          `INSERT INTO location_whatsapp_stock_deliveries(company_id,location_id,source,idempotency_key,status,started_at,error)
           VALUES($1,$2,'scheduled',$3,'running',now() - $4::interval,$5) RETURNING id`,
          [w.companyId, w.locationId, `${key}-${process.pid}-${++seq}`, startedAgo, error]
        );
      const stale = Number((await insert("stale", "21 minutes")).rows[0].id);
      const noted = Number((await insert("noted", "1 hour", "PDF timed out")).rows[0].id);
      const fresh = Number((await insert("fresh", "19 minutes")).rows[0].id);

      expect(await recoverStaleLocationStockDeliveries()).toBe(2);
      expect(await delivery(client, stale)).toMatchObject({
        status: "failed",
        error: "Delivery interrupted before completion; retry manually if needed",
        completed: true,
      });
      expect((await delivery(client, noted)).error).toBe("PDF timed out");
      expect((await delivery(client, fresh)).status).toBe("running");
      expect(
        (
          await client.query(
            "SELECT last_status, last_error FROM location_whatsapp_stock_schedules WHERE location_id=$1",
            [w.locationId]
          )
        ).rows[0]
      ).toEqual({
        last_status: "failed",
        last_error: "Delivery interrupted before completion; retry manually if needed",
      });
      expect(logger.warn).toHaveBeenCalledWith("[LocationStockWhatsAppDelivery] recovered stale running deliveries", {
        count: 2,
      });
    });
  });
});
