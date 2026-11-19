/**
 * Factory report image sender (server/routes/factory-reports/whatsapp.ts):
 * the default weekly-report group, the attendance override and the production
 * group on the POS instance. Runs the registered handler with the real
 * database (factory settings and the shared whatsapp_settings row, restored
 * afterwards); the GREEN API sends are mocked at the whatsappService boundary.
 * Covers missing image, company, group, credentials and disabled sending,
 * credential whitespace normalisation, the 401 fallback to the POS instance,
 * and provider failures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({
  sendWhatsAppFileToChatId: vi.fn(),
  sendWhatsAppFileToChatIdPos: vi.fn(),
  getWaSettingsById: vi.fn(),
}));
vi.mock("../server/services/whatsappService", () => wa);

import { db, pool } from "../server/db";
import { registerFactoryMixBatchWhatsappRoutes } from "../server/routes/factory-reports/whatsapp";
import { createFakeRouteApp } from "./helpers/fakeRouteApp";

const ROUTE = "POST /api/factory/send-mix-batch-image-whatsapp";
const IMAGE = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;
const tag = `frw${Date.now().toString(36)}`;
let companyId = 0;
let saved: Record<string, unknown> | undefined;
const passThrough = (_req: unknown, _res: unknown, next?: () => unknown) => next?.();
const { app, call } = createFakeRouteApp(() => ({ companyId, today: "2026-03-01" }));
registerFactoryMixBatchWhatsappRoutes(app, passThrough as never, db);

const send = (body: Record<string, unknown>, session: Record<string, unknown> = {}) => call(ROUTE, { body, session });

async function mainSettings(values: { group?: string; instance?: string; token?: string; enabled?: boolean }) {
  await pool.query(
    "UPDATE whatsapp_settings SET weekly_report_wa_group_chat_id=$1,instance_id=$2,api_token=$3,enabled=$4 WHERE id=1",
    [values.group ?? "", values.instance ?? "", values.token ?? "", values.enabled ?? false]
  );
}

async function extra(settings: Record<string, unknown>) {
  await pool.query(
    `INSERT INTO factory_settings(company_id,extra_settings) VALUES($1,$2::jsonb)
     ON CONFLICT (company_id) DO UPDATE SET extra_settings=EXCLUDED.extra_settings`,
    [companyId, JSON.stringify(settings)]
  );
}

beforeAll(async () => {
  const { rows } = await pool.query("SELECT * FROM whatsapp_settings WHERE id=1");
  saved = rows[0];
  const company = await pool.query<{ id: number }>(
    "INSERT INTO companies(code,name,company_type) VALUES($1,$2,'factory') RETURNING id",
    [tag.toUpperCase(), `${tag}_Factory`]
  );
  companyId = company.rows[0].id;
});

afterAll(async () => {
  if (saved) {
    await pool.query(
      "UPDATE whatsapp_settings SET weekly_report_wa_group_chat_id=$1,instance_id=$2,api_token=$3,enabled=$4 WHERE id=1",
      [saved.weekly_report_wa_group_chat_id, saved.instance_id, saved.api_token, saved.enabled]
    );
  }
  await pool.query("DELETE FROM audit_log WHERE company_id=$1", [companyId]).catch(() => undefined);
  await pool.query("DELETE FROM factory_settings WHERE company_id=$1", [companyId]);
  await pool.query("DELETE FROM companies WHERE id=$1", [companyId]);
});

beforeEach(async () => {
  wa.sendWhatsAppFileToChatId.mockReset().mockResolvedValue({ success: true });
  wa.sendWhatsAppFileToChatIdPos.mockReset().mockResolvedValue({ success: true });
  wa.getWaSettingsById.mockReset().mockResolvedValue({ instanceId: "2202", apiToken: "pos", enabled: true });
  await mainSettings({ group: "111@g.us", instance: "1101", token: "tok", enabled: true });
  await extra({});
});

describe("refusals", () => {
  it("requires an image and a selected company", async () => {
    expect((await send({})).statusCode).toBe(400);
    for (const recipient of ["production", "attendance"]) {
      const res = await send(
        { imageBase64: IMAGE, recipient },
        { factoryCompanyId: undefined, currentCompanyId: undefined }
      );
      expect(res.body.message).toBe("No company selected");
    }
  });

  it("refuses the production group when it, its credentials or sending are missing", async () => {
    expect((await send({ imageBase64: IMAGE, recipient: "production" })).body.message).toContain(
      "No Production WhatsApp group"
    );
    await extra({ productionWorkerMatrixWhatsappGroupId: " 333@g.us " });
    wa.getWaSettingsById.mockResolvedValueOnce(null);
    expect((await send({ imageBase64: IMAGE, recipient: "production" })).body.message).toBe(
      "Production WhatsApp credentials are not configured."
    );
    wa.getWaSettingsById.mockResolvedValueOnce({ instanceId: "2202", apiToken: "pos", enabled: false });
    expect((await send({ imageBase64: IMAGE, recipient: "production" })).body.message).toBe(
      "Production WhatsApp sending is disabled."
    );
    expect(wa.sendWhatsAppFileToChatIdPos).not.toHaveBeenCalled();
  });

  it("refuses without a default or attendance group, credentials or enabled sending", async () => {
    await mainSettings({ group: "", instance: "1101", token: "tok", enabled: true });
    expect((await send({ imageBase64: IMAGE })).body.message).toContain("No WhatsApp group configured");
    expect((await send({ imageBase64: IMAGE, destination: "attendance" })).body.message).toContain(
      "No Attendance WhatsApp group"
    );
    await mainSettings({ group: "111@g.us", instance: "", token: "tok", enabled: true });
    expect((await send({ imageBase64: IMAGE })).body.message).toBe("WhatsApp credentials not configured.");
    await mainSettings({ group: "111@g.us", instance: "1101", token: "tok", enabled: false });
    expect((await send({ imageBase64: IMAGE })).body.message).toBe("WhatsApp sending is disabled.");
    expect(wa.sendWhatsAppFileToChatId).not.toHaveBeenCalled();
  });
});

describe("sending", () => {
  it("sends production images on the POS instance and reports its failure", async () => {
    await extra({ productionWorkerMatrixWhatsappGroupId: "333@g.us" });
    const ok = await send({ imageBase64: IMAGE, recipient: "production", date: "2026-03-02" });
    expect(ok.body).toMatchObject({ ok: true, usedFallback: false });
    expect(wa.sendWhatsAppFileToChatIdPos.mock.calls[0]).toEqual([
      "333@g.us",
      Buffer.from("png"),
      "Production_2026-03-02.png",
      "Production Targets — 2026-03-02",
      "image/png",
    ]);
    wa.sendWhatsAppFileToChatIdPos.mockResolvedValueOnce({ success: false });
    const failed = await send({ imageBase64: IMAGE, recipient: "production" });
    expect([failed.statusCode, failed.body.message]).toEqual([502, "Failed to send production image to WhatsApp."]);
  });

  it("sends to the default group and trims stored credentials", async () => {
    await mainSettings({ group: " 111@g.us ", instance: " 1101 ", token: " tok ", enabled: true });
    const res = await send({
      imageBase64: IMAGE,
      fileName: "Weekly.png",
      caption: "Weekly",
      reportLabel: "Weekly report",
    });
    expect(res.body).toEqual({ ok: true, message: "Mix batch image sent to WhatsApp group.", usedFallback: false });
    expect(wa.sendWhatsAppFileToChatId.mock.calls[0].slice(0, 1)).toEqual(["111@g.us"]);
    const { rows } = await pool.query(
      "SELECT weekly_report_wa_group_chat_id,instance_id,api_token FROM whatsapp_settings WHERE id=1"
    );
    expect(rows[0]).toEqual({ weekly_report_wa_group_chat_id: "111@g.us", instance_id: "1101", api_token: "tok" });
  });

  it("sends attendance images to the attendance group only", async () => {
    await extra({ attendanceWhatsappGroupId: "444@g.us" });
    const res = await send({ imageBase64: IMAGE, recipient: "attendance" });
    expect(res.body.message).toBe("Attendance image sent to WhatsApp group.");
    expect(wa.sendWhatsAppFileToChatId.mock.calls[0][0]).toBe("444@g.us");
    const { rows } = await pool.query("SELECT weekly_report_wa_group_chat_id FROM whatsapp_settings WHERE id=1");
    expect(rows[0].weekly_report_wa_group_chat_id).toBe("111@g.us");
  });

  it("falls back to the POS instance on a 401 and reports when both are rejected", async () => {
    wa.sendWhatsAppFileToChatId.mockResolvedValue({ success: false, error: "Green API 401 Unauthorized" });
    const fallback = await send({ imageBase64: IMAGE });
    expect(fallback.body).toMatchObject({
      usedFallback: true,
      message: "Mix batch image sent to WhatsApp group using the backup WhatsApp instance.",
    });
    wa.sendWhatsAppFileToChatIdPos.mockResolvedValueOnce({ success: false, error: "Green API 401" });
    const both = await send({ imageBase64: IMAGE });
    expect([both.statusCode, both.body.code]).toEqual([502, "WHATSAPP_AUTH_REJECTED"]);
    wa.getWaSettingsById.mockResolvedValueOnce({ instanceId: "", apiToken: "", enabled: true });
    expect((await send({ imageBase64: IMAGE })).body.code).toBe("WHATSAPP_AUTH_REJECTED");
  });

  it("reports other provider failures and unexpected errors", async () => {
    wa.sendWhatsAppFileToChatId.mockResolvedValueOnce({ success: false, error: "Group not found" });
    expect((await send({ imageBase64: IMAGE })).body.message).toBe("Group not found");
    wa.sendWhatsAppFileToChatId.mockResolvedValueOnce({ success: false });
    expect((await send({ imageBase64: IMAGE })).body.message).toBe("Failed to send");
    wa.sendWhatsAppFileToChatId.mockRejectedValueOnce(new Error("socket closed"));
    const thrown = await send({ imageBase64: IMAGE });
    expect([thrown.statusCode, thrown.body.message]).toEqual([500, "socket closed"]);
  });
});
