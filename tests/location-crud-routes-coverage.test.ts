/**
 * Location CRUD and Location Inventory WhatsApp settings routes
 * (server/routes/location/locationCrudRoutes.ts) over HTTP with the real
 * database. The GREEN API chat list, POS WhatsApp credentials and the test
 * send are mocked at the whatsappService boundary. Covers validation and
 * conflict refusals on create/rename, permission refusals, and every refusal
 * of the group link and test-send flows (not a group, no credentials, group
 * gone, provider failure).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({
  getPosWaSettings: vi.fn(),
  fetchGreenApiChats: vi.fn(),
  sendWhatsAppTextToChatIdPos: vi.fn(),
}));
vi.mock("../server/services/whatsappService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/whatsappService")>();
  return { ...actual, ...wa };
});

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import { otherCompanyLocation, signInAdmin, signInRole, type Agent } from "./helpers/routeCoverageSession";

const PREFIX = "loccrud";
const GROUP = { id: "120363000000000042@g.us", name: "Depot Stock", type: "group" };
let ctx: TestContext;
let admin: Agent;
let manager: Agent;
let otherCode: string;

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  admin = await signInAdmin(ctx, PREFIX);
  manager = await signInRole(ctx, PREFIX, "Manager", ["exp_whatsapp_send"]);
  const other = await otherCompanyLocation(PREFIX);
  const { rows } = await pool.query("SELECT code FROM locations WHERE id=$1", [other.locationId]);
  otherCode = rows[0].code;
}, 60000);

afterAll(async () => {
  await pool.query("DELETE FROM location_whatsapp_stock_reports WHERE company_id=$1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

beforeEach(() => {
  wa.getPosWaSettings.mockReset().mockResolvedValue({ instanceId: "1101", apiToken: "tok" });
  wa.fetchGreenApiChats
    .mockReset()
    .mockResolvedValue([GROUP, { id: "243810000001@c.us", name: "Someone", type: "contact" }]);
  wa.sendWhatsAppTextToChatIdPos.mockReset().mockResolvedValue({ success: true });
});

describe("create and read", () => {
  it("refuses an invalid body and a duplicate explicit code", async () => {
    const invalid = await admin.post("/api/locations").send({ name: "" });
    expect([invalid.status, invalid.body.message]).toEqual([
      400,
      "Invalid location information. Please check the name and try again.",
    ]);
    const { rows } = await pool.query("SELECT code FROM locations WHERE id=$1", [ctx.locationId]);
    const dup = await admin.post("/api/locations").send({ name: "Dup", code: rows[0].code });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toContain("Location code already exists");
  });

  it("turns a code owned by another company into a conflict without revealing it", async () => {
    const res = await admin.post("/api/locations").send({ name: "Clash", code: otherCode });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("That location code is already in use. Try again.");
    const count = await pool.query("SELECT count(*)::int AS n FROM locations WHERE company_id=$1 AND name='Clash'", [
      ctx.companyId,
    ]);
    expect(count.rows[0].n).toBe(0);
  });

  it("generates company-scoped codes and suffixes collisions", async () => {
    const a = await admin.post("/api/locations").send({ name: "North Depot" });
    const b = await admin.post("/api/locations").send({ name: "North Depot" });
    const c = await admin.post("/api/locations").send({ name: "###", city: "Lubumbashi" });
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    expect(a.body.code).toBe(`C${ctx.companyId}-NORTHD`);
    expect(b.body.code).toBe(`C${ctx.companyId}-NORTHD1`);
    expect(c.body).toMatchObject({ code: `C${ctx.companyId}-LOC`, city: "Lubumbashi" });
  });

  it("returns locations with their WhatsApp report settings", async () => {
    await pool.query(
      `INSERT INTO location_whatsapp_stock_reports(location_id,company_id,whatsapp_group_chat_id,whatsapp_group_name,enabled)
       VALUES($1,$2,$3,$4,true)`,
      [ctx.location2Id, ctx.companyId, GROUP.id, GROUP.name]
    );
    const list = await admin.get("/api/locations");
    expect(list.status).toBe(200);
    const second = list.body.find((l: { id: number }) => l.id === ctx.location2Id);
    expect(second).toMatchObject({ whatsappGroupName: GROUP.name, whatsappStockReportsEnabled: true });
    const first = list.body.find((l: { id: number }) => l.id === ctx.locationId);
    expect(first).toMatchObject({ whatsappGroupName: null, whatsappStockReportsEnabled: false });
    const one = await admin.get(`/api/locations/${ctx.location2Id}`);
    expect(one.body).toMatchObject({ id: ctx.location2Id, whatsappGroupChatId: GROUP.id });
    expect((await admin.get("/api/locations/abc")).status).toBe(400);
  });
});

describe("rename", () => {
  const patch = (body: Record<string, unknown>, id: number | string = ctx.locationId) =>
    admin.patch(`/api/locations/${id}`).send(body);

  it("refuses WhatsApp fields, a missing name and a bad deduction", async () => {
    expect((await patch({ name: "x" }, "abc")).status).toBe(400);
    // whatsappGroupChatId writes are taken by the legacy compatibility route registered first.
    for (const field of ["whatsappGroupName", "whatsappStockReportsEnabled"]) {
      const res = await patch({ name: "x", [field]: field === "whatsappStockReportsEnabled" ? false : "x" });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("Use the location WhatsApp settings endpoint");
    }
    expect((await patch({ name: "   " })).body.message).toBe("name is required");
    expect((await patch({ name: 5 })).status).toBe(400);
    for (const value of ["-1", "abc"]) {
      const res = await patch({ name: "Renamed", supplierPartnerPayableDeductionPerQty: value });
      expect(res.body.message).toBe("supplierPartnerPayableDeductionPerQty must be >= 0");
    }
    const { rows } = await pool.query("SELECT name FROM locations WHERE id=$1", [ctx.locationId]);
    expect(rows[0].name).toBe(`${PREFIX}_Warehouse1`);
  });

  it("renames, clears the transfer group and stores the deduction", async () => {
    const res = await patch({
      name: "  Main Store ",
      transferWaGroupChatId: "",
      supplierPartnerPayableDeductionPerQty: "1.25",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Main Store", transferWaGroupChatId: null });
    const { rows } = await pool.query(
      "SELECT supplier_partner_payable_deduction_per_qty AS d FROM locations WHERE id=$1",
      [ctx.locationId]
    );
    expect(rows[0].d).toBe("1.2500");
    const same = await patch({ name: "Main Store" });
    expect(same.status).toBe(200);
  });
});

describe("WhatsApp management permission", () => {
  it("lets Admin probe and list groups, and refuses a role without the permission", async () => {
    expect((await admin.get("/api/location-inventory/whatsapp/capability")).body).toEqual({ canManage: true });
    expect((await manager.get("/api/location-inventory/whatsapp/capability")).status).toBe(403);
    expect((await manager.get("/api/location-inventory/whatsapp/groups")).status).toBe(403);
    expect((await manager.put(`/api/locations/${ctx.locationId}/whatsapp-settings`).send({})).status).toBe(403);
    expect((await manager.post(`/api/locations/${ctx.locationId}/whatsapp-test`).send({})).status).toBe(403);
    expect(wa.fetchGreenApiChats).not.toHaveBeenCalled();
  });

  it("lists only groups, and refuses without credentials or when GREEN API fails", async () => {
    const groups = await admin.get("/api/location-inventory/whatsapp/groups");
    expect(groups.body).toEqual([GROUP]);
    wa.getPosWaSettings.mockResolvedValueOnce(null);
    expect((await admin.get("/api/location-inventory/whatsapp/groups")).status).toBe(400);
    wa.fetchGreenApiChats.mockRejectedValueOnce(new Error("GREEN API unreachable"));
    const failed = await admin.get("/api/location-inventory/whatsapp/groups");
    expect([failed.status, failed.body.message]).toEqual([502, "GREEN API unreachable"]);
  });
});

describe("WhatsApp settings", () => {
  const put = (body: Record<string, unknown>, id: number | string = ctx.locationId) =>
    admin.put(`/api/locations/${id}/whatsapp-settings`).send(body);

  it("refuses enabling without a group, a contact chat, missing credentials and a vanished group", async () => {
    expect((await put({}, "abc")).status).toBe(400);
    expect(
      (await pool.query("SELECT 1 FROM location_whatsapp_stock_reports WHERE location_id=$1", [ctx.locationId]))
        .rowCount
    ).toBe(0);
    expect((await put({ enabled: true, whatsappGroupChatId: " " })).body.message).toBe(
      "Link a WhatsApp group before enabling stock reports"
    );
    expect((await put({ whatsappGroupChatId: "243810000001@c.us" })).body.message).toBe(
      "A WhatsApp group must be selected"
    );
    wa.getPosWaSettings.mockResolvedValueOnce({ instanceId: "", apiToken: "" });
    expect((await put({ whatsappGroupChatId: GROUP.id })).body.message).toBe("WhatsApp credentials are not configured");
    wa.fetchGreenApiChats.mockResolvedValueOnce([]);
    const gone = await put({ whatsappGroupChatId: GROUP.id });
    expect([gone.status, gone.body.message]).toEqual([
      400,
      "The selected WhatsApp group is no longer available on the connected account",
    ]);
    const stored = await pool.query("SELECT 1 FROM location_whatsapp_stock_reports WHERE location_id=$1", [
      ctx.locationId,
    ]);
    expect(stored.rowCount).toBe(0);
  });

  it("links a verified group, syncs the location and audits; unlinking clears it", async () => {
    const res = await put({ whatsappGroupChatId: ` ${GROUP.id} `, enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      whatsappGroupChatId: GROUP.id,
      whatsappGroupName: GROUP.name,
      whatsappStockReportsEnabled: true,
    });
    const loc = await pool.query("SELECT whatsapp_group_chat_id FROM locations WHERE id=$1", [ctx.locationId]);
    expect(loc.rows[0].whatsapp_group_chat_id).toBe(GROUP.id);
    const off = await put({ enabled: false });
    expect(off.body).toMatchObject({ whatsappGroupChatId: null, whatsappStockReportsEnabled: false });
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE company_id=$1 AND action='update_location_whatsapp_stock_reports'",
      [ctx.companyId]
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it("answers 500 for an unexpected failure", async () => {
    wa.fetchGreenApiChats.mockRejectedValueOnce(new Error("socket reset"));
    const res = await put({ whatsappGroupChatId: GROUP.id });
    expect([res.status, res.body.message]).toEqual([500, "socket reset"]);
  });
});

describe("WhatsApp test send", () => {
  const post = (body: Record<string, unknown>, id: number | string = ctx.location2Id) =>
    admin.post(`/api/locations/${id}/whatsapp-test`).send(body);

  it("refuses a location without a linked group and an unverified chat", async () => {
    expect((await post({}, "abc")).status).toBe(400);
    const none = await post({}, ctx.locationId);
    expect(none.body.message).toBe("No WhatsApp group is linked to this location");
    const contact = await post({ whatsappGroupChatId: "243810000001@c.us" });
    expect(contact.body.message).toBe("A WhatsApp group must be selected");
    expect(wa.sendWhatsAppTextToChatIdPos).not.toHaveBeenCalled();
  });

  it("sends a test text to the stored group and audits it", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: `Test sent to ${GROUP.name}`, groupId: GROUP.id, groupName: GROUP.name });
    expect(wa.sendWhatsAppTextToChatIdPos.mock.calls[0][0]).toBe(GROUP.id);
  });

  it("reports provider failures and unexpected errors", async () => {
    wa.sendWhatsAppTextToChatIdPos.mockResolvedValueOnce({ success: false, error: "Instance offline" });
    expect((await post({ whatsappGroupChatId: GROUP.id })).body.message).toBe("Instance offline");
    wa.sendWhatsAppTextToChatIdPos.mockResolvedValueOnce({ success: false });
    const generic = await post({});
    expect([generic.status, generic.body.message]).toEqual([502, "WhatsApp test send failed"]);
    wa.fetchGreenApiChats.mockRejectedValueOnce(new Error("socket reset"));
    expect((await post({})).status).toBe(500);
  });
});
