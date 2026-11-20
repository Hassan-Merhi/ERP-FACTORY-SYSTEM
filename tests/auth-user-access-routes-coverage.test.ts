/**
 * User access routes (user locations, location cash accounts, my-locations,
 * user preferences) over real HTTP in one rolled-back transaction per test.
 * Pins validation refusals, role refusals, the assigned-location fallback,
 * preference create / update paths and that another company's id is refused
 * before any write.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const location = (w: FactoryWorld, name: string, active = true, companyId = w.companyId) =>
  w.one(`INSERT INTO locations (company_id, code, name, active) VALUES ($1, $2, $3, $4) RETURNING id`, [
    companyId,
    `${w.tag}${name}`,
    name,
    active,
  ]);
const ledger = (w: FactoryWorld, name: string, type: string, companyId = w.companyId) =>
  w.one(`INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, $4) RETURNING id`, [
    companyId,
    `${w.tag}${name}`,
    name,
    type,
  ]);
const otherCompany = (w: FactoryWorld) =>
  w.one(`INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`, [
    `${w.tag}OC`,
  ]);

describe("user locations", () => {
  it("replaces, clears and validates a user's locations and sets the assigned location", () =>
    withFactoryWorld(async (w) => {
      const base = `/api/user-locations/${w.userId}/${w.companyId}`;
      expect((await w.agent.put(base).send({ locationIds: "x" })).status).toBe(400);
      const second = await location(w, "Second");
      const put = await w.agent.put(base).send({ locationIds: [second, w.locationId] });
      expect(put.status).toBe(200);
      expect(put.body.map((r: { locationId: number }) => r.locationId).sort()).toEqual([w.locationId, second].sort());
      const [role] = await w.q(
        `SELECT assigned_location_id FROM user_company_roles WHERE user_id = $1 AND company_id = $2`,
        [w.userId, w.companyId]
      );
      expect(role.assigned_location_id).toBe(second);
      expect((await w.agent.get(base)).body).toHaveLength(2);
      expect((await w.agent.put(base).send({ locationIds: [] })).body).toEqual([]);
    }));

  it("refuses another company's id and foreign locations without writing", () =>
    withFactoryWorld(async (w) => {
      const other = await otherCompany(w);
      const foreignLoc = await location(w, "Foreign", true, other);
      const read = await w.agent.get(`/api/user-locations/${w.userId}/${other}`);
      expect([403, 404]).toContain(read.status);
      const write = await w.agent.put(`/api/user-locations/${w.userId}/${other}`).send({ locationIds: [foreignLoc] });
      expect([403, 404]).toContain(write.status);
      const own = await w.agent
        .put(`/api/user-locations/${w.userId}/${w.companyId}`)
        .send({ locationIds: [foreignLoc] });
      expect(own.status).toBe(400);
      expect(await w.q(`SELECT id FROM user_locations WHERE user_id = $1`, [w.userId])).toEqual([]);
    }));

  it("refuses non-admin writers", () =>
    withFactoryWorld(async (w) => {
      const clerk = await w.agentFor("Accountant");
      const res = await clerk.put(`/api/user-locations/${w.userId}/${w.companyId}`).send({ locationIds: [] });
      expect(res.status).toBe(403);
    }));
});

describe("user location cash accounts", () => {
  it("saves and lists cash mappings, defaulting the POS station to null", () =>
    withFactoryWorld(async (w) => {
      const base = `/api/user-location-cash-accounts/${w.userId}/${w.companyId}`;
      const cash = await ledger(w, "Till", "Cash");
      expect((await w.agent.put(base).send({ mappings: "x" })).status).toBe(400);
      const ok = await w.agent.put(base).send({ mappings: [{ locationId: w.locationId, cashAccountId: cash }] });
      expect(ok.body).toEqual({ success: true });
      expect((await w.agent.get(base)).body).toEqual([
        { id: expect.any(Number), locationId: w.locationId, cashAccountId: cash, posStation: null },
      ]);
      await w.agent.put(base).send({ mappings: [{ locationId: w.locationId, cashAccountId: cash, posStation: 2 }] });
      expect((await w.agent.get(base)).body[0].posStation).toBe(2);
      expect((await w.agent.put(base).send({ mappings: [] })).body).toEqual({ success: true });
      expect((await w.agent.get(base)).body).toEqual([]);
    }));

  it("refuses non-cash, foreign and incomplete mappings without writing", () =>
    withFactoryWorld(async (w) => {
      const base = `/api/user-location-cash-accounts/${w.userId}/${w.companyId}`;
      const bank = await ledger(w, "Bank", "Bank");
      const other = await otherCompany(w);
      const foreignCash = await ledger(w, "ForeignTill", "Cash", other);
      for (const mappings of [
        [{ locationId: w.locationId, cashAccountId: bank }],
        [{ locationId: w.locationId, cashAccountId: foreignCash }],
        [{ locationId: w.locationId }],
      ]) {
        expect((await w.agent.put(base).send({ mappings })).status).toBe(400);
      }
      const cross = await w.agent
        .put(`/api/user-location-cash-accounts/${w.userId}/${other}`)
        .send({ mappings: [{ locationId: w.locationId, cashAccountId: foreignCash }] });
      expect([403, 404]).toContain(cross.status);
      expect(await w.q(`SELECT id FROM user_location_cash_accounts WHERE user_id = $1`, [w.userId])).toEqual([]);
    }));

  it("refuses the listing to non-admin roles, even for their own mappings", () =>
    withFactoryWorld(async (w) => {
      const clerk = await w.agentFor("Accountant");
      const me = await clerk.get("/api/auth/me");
      const ownId = me.body?.user?.id ?? me.body?.id;
      const own = await clerk.get(`/api/user-location-cash-accounts/${ownId}/${w.companyId}`);
      expect(own.status).toBe(403);
      const other = await clerk.get(`/api/user-location-cash-accounts/${w.userId}/${w.companyId}`);
      expect(other.status).toBe(403);
    }));
});

describe("my locations", () => {
  it("lists assigned active locations with their cash account", () =>
    withFactoryWorld(async (w) => {
      const cash = await ledger(w, "MyTill", "Cash");
      const closed = await location(w, "Closed", false);
      await w.q(`INSERT INTO user_locations (user_id, company_id, location_id) VALUES ($1, $2, $3), ($1, $2, $4)`, [
        w.userId,
        w.companyId,
        w.locationId,
        closed,
      ]);
      await w.q(
        `INSERT INTO user_location_cash_accounts (user_id, company_id, location_id, cash_account_id) VALUES ($1, $2, $3, $4)`,
        [w.userId, w.companyId, w.locationId, cash]
      );
      const res = await w.agent.get("/api/my-locations");
      expect(res.body).toEqual([
        expect.objectContaining({ id: w.locationId, cashAccountId: cash, cashAccountName: "MyTill" }),
      ]);
    }));

  it("falls back to the assigned location once and records it", () =>
    withFactoryWorld(async (w) => {
      await w.q(`UPDATE user_company_roles SET assigned_location_id = $1 WHERE user_id = $2 AND company_id = $3`, [
        w.locationId,
        w.userId,
        w.companyId,
      ]);
      const first = await w.agent.get("/api/my-locations");
      expect(first.body).toEqual([expect.objectContaining({ id: w.locationId, cashAccountId: null })]);
      expect(await w.q(`SELECT location_id FROM user_locations WHERE user_id = $1`, [w.userId])).toEqual([
        { location_id: w.locationId },
      ]);
    }));

  it("returns nothing without assignments or when the assigned location is inactive", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get("/api/my-locations")).body).toEqual([]);
      const closed = await location(w, "Shut", false);
      await w.q(`UPDATE user_company_roles SET assigned_location_id = $1 WHERE user_id = $2 AND company_id = $3`, [
        closed,
        w.userId,
        w.companyId,
      ]);
      expect((await w.agent.get("/api/my-locations")).body).toEqual([]);
      expect(await w.q(`SELECT id FROM user_locations WHERE user_id = $1`, [w.userId])).toEqual([]);
    }));
});

describe("user preferences", () => {
  it("defaults, creates and then updates preferences", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get("/api/user-preferences")).body).toEqual({ dateFormat: "MM/DD/YYYY" });
      const created = await w.agent.put("/api/user-preferences").send({});
      expect(created.body).toMatchObject({
        dateFormat: "MM/DD/YYYY",
        preferredCurrency: null,
        showChatWidget: true,
        factoryNetPositionValuationMode: "cost",
        hiddenTransactionJournalVoucherIds: [],
      });
      const updated = await w.agent.put("/api/user-preferences").send({
        dateFormat: "DD/MM/YYYY",
        preferredCurrency: "CFA",
        showProfitComparisonOnPOS: true,
        showChatWidget: false,
        showNotesPanel: false,
        factoryNetPositionValuationMode: "selling",
        factoryMhdViewDefault: true,
        hiddenTransactionJournalVoucherIds: [5, 5, 9],
      });
      expect(updated.body).toMatchObject({
        dateFormat: "DD/MM/YYYY",
        preferredCurrency: "CFA",
        showProfitComparisonOnPOS: true,
        showChatWidget: false,
        showNotesPanel: false,
        factoryNetPositionValuationMode: "selling",
        factoryMhdViewDefault: true,
        hiddenTransactionJournalVoucherIds: [5, 9],
      });
      expect((await w.agent.get("/api/user-preferences")).body.dateFormat).toBe("DD/MM/YYYY");
      const touch = await w.agent.put("/api/user-preferences").send({});
      expect(touch.body.dateFormat).toBe("DD/MM/YYYY");
    }));

  it("creates preferences from the first full payload", () =>
    withFactoryWorld(async (w) => {
      const res = await w.agent.put("/api/user-preferences").send({
        dateFormat: "DD/MM/YYYY",
        preferredCurrency: "USD",
        showProfitComparisonOnPOS: true,
        showChatWidget: false,
        showNotesPanel: false,
        factoryNetPositionValuationMode: "selling",
        factoryMhdViewDefault: true,
        hiddenTransactionJournalVoucherIds: [3],
      });
      expect(res.body).toMatchObject({
        dateFormat: "DD/MM/YYYY",
        preferredCurrency: "USD",
        factoryMhdViewDefault: true,
      });
    }));

  it.each([
    [{ dateFormat: "YYYY" }, "Invalid date format"],
    [{ preferredCurrency: "EUR" }, "Invalid currency"],
    [{ factoryNetPositionValuationMode: "market" }, "Invalid factory net position valuation mode"],
    [{ factoryMhdViewDefault: "yes" }, "Invalid Factory MHD view preference"],
    [{ hiddenTransactionJournalVoucherIds: "1" }, "Invalid hidden transaction journal voucher IDs"],
    [{ hiddenTransactionJournalVoucherIds: [0] }, "Invalid hidden transaction journal voucher IDs"],
    [{ hiddenTransactionJournalVoucherIds: [1.5] }, "Invalid hidden transaction journal voucher IDs"],
    [{ hiddenTransactionJournalVoucherIds: Array(5001).fill(1) }, "Invalid hidden transaction journal voucher IDs"],
  ])("refuses %j", (body, message) =>
    withFactoryWorld(async (w) => {
      const res = await w.agent.put("/api/user-preferences").send(body);
      expect([res.status, res.body.message]).toEqual([400, message]);
      expect(await w.q(`SELECT id FROM user_preferences WHERE user_id = $1`, [w.userId])).toEqual([]);
    })
  );
});
