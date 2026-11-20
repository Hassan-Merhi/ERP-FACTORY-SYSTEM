/**
 * server/routes/retailFinancialRoutes.ts refusal and edge paths over HTTP
 * against PostgreSQL, one rolled-back retail company per test.
 *
 * Pinned: every route refuses a non-retail company (409); settings and
 * reconciliation refuse another company's location, ledger or bank account
 * and malformed input; the drawer balance needs a location, a valid cash
 * account and, for a POS user, an assigned location; shift summary and cash
 * movements refuse bad ids, unknown shifts and another POS user's shift; a
 * cash movement refuses a closed shift, a malformed or sub-cent amount and an
 * unmapped reason, posts a mapped one once, replays the same key and refuses
 * the same key with different data.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { nextSeq, otherCompany } from "./helpers/voucherReadFixture";

const retail = (w: FactoryWorld) => w.q(`UPDATE companies SET company_type = 'retail' WHERE id = $1`, [w.companyId]);

async function shift(w: FactoryWorld, status = "open", userId = w.userId) {
  return w.one(
    `INSERT INTO pos_shifts (company_id, location_id, user_id, username, status, opening_cash)
     VALUES ($1, $2, $3, 'cashier', $4, 0) RETURNING id`,
    [w.companyId, w.locationId, userId, status]
  );
}

async function foreignRefs(w: FactoryWorld) {
  const other = await otherCompany(w);
  const ledger = await w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2::varchar, $2::text, 'Cash') RETURNING id`,
    [other, `${w.tag}FL`]
  );
  const bank = await w.one(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'B', 'B', '1') RETURNING id`,
    [other, `${w.tag}FB`]
  );
  const location = await w.one(`INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Far') RETURNING id`, [
    other,
    `${w.tag}FLOC`,
  ]);
  return { ledger, bank, location };
}

describe("retail financial settings and reports", () => {
  it("refuses a company that is not a retail company on every route", () =>
    withFactoryWorld(async (w) => {
      for (const res of [
        await w.agent.get("/api/retail/financial/accounts"),
        await w.agent.get("/api/retail/financial/settings"),
        await w.agent.put("/api/retail/financial/settings").send({}),
        await w.agent.get("/api/retail/financial/reconciliation"),
        await w.agent.get("/api/pos/retail/shift-ledger-balance"),
        await w.agent.get("/api/pos/retail/shifts/1/summary"),
        await w.agent.post("/api/pos/retail/shifts/1/cash-movements").send({}),
      ]) {
        expect(res.status).toBe(409);
      }
    }));

  it("refuses another company's location, ledger and bank account in settings", () =>
    withFactoryWorld(async (w) => {
      await retail(w);
      const foreign = await foreignRefs(w);
      expect((await w.agent.get("/api/retail/financial/accounts")).status).toBe(200);
      expect((await w.agent.get("/api/retail/financial/settings").query({ locationId: "x" })).status).toBe(200);
      expect((await w.agent.get("/api/retail/financial/settings").query({ locationId: w.locationId })).status).toBe(
        200
      );
      const farGet = await w.agent.get("/api/retail/financial/settings").query({ locationId: foreign.location });
      expect(farGet.status).toBe(400);
      for (const body of [
        { cashLedgerAccountId: "abc" },
        { cashLedgerAccountId: foreign.ledger },
        { bankAccountId: foreign.bank },
        { locationId: foreign.location },
      ]) {
        const res = await w.agent.put("/api/retail/financial/settings").send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      const own = await w.one(
        `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'Mine', 'B', '2') RETURNING id`,
        [w.companyId, `${w.tag}OB`]
      );
      const saved = await w.agent
        .put("/api/retail/financial/settings")
        .send({ locationId: w.locationId, bankAccountId: own, cashLedgerAccountId: null });
      expect(saved.status, saved.text).toBe(200);
    }));

  it("validates reconciliation dates and location", () =>
    withFactoryWorld(async (w) => {
      await retail(w);
      const foreign = await foreignRefs(w);
      const bad = await w.agent.get("/api/retail/financial/reconciliation").query({ from: "not-a-date" });
      expect(bad.status).toBe(400);
      expect(bad.body.message).toBe("Invalid reconciliation date");
      expect(
        (await w.agent.get("/api/retail/financial/reconciliation").query({ locationId: foreign.location })).status
      ).toBe(400);
      const ok = await w.agent
        .get("/api/retail/financial/reconciliation")
        .query({ locationId: w.locationId, from: "2026-01-01", to: "2026-12-31" });
      expect(ok.status).toBe(200);
    }));
});

describe("retail drawer balance and shifts", () => {
  it("validates the drawer balance request and a POS user's location", () =>
    withFactoryWorld(async (w) => {
      await retail(w);
      const foreign = await foreignRefs(w);
      const url = "/api/pos/retail/shift-ledger-balance";
      expect((await w.agent.get(url)).status).toBe(400);
      expect((await w.agent.get(url).query({ locationId: foreign.location })).status).toBe(400);
      expect((await w.agent.get(url).query({ locationId: w.locationId, cashAccountId: "-2" })).status).toBe(400);
      expect((await w.agent.get(url).query({ locationId: w.locationId })).status).toBe(200);
      const pos = await w.agentFor("POS");
      const unassigned = await pos.get(url).query({ locationId: w.locationId });
      expect(unassigned.status).toBe(403);
      const [posUser] = await w.q(`SELECT id FROM users WHERE username = $1`, [`${w.tag.toLowerCase()}_u1`]);
      await w.q(`INSERT INTO user_locations (company_id, user_id, location_id) VALUES ($1, $2, $3)`, [
        w.companyId,
        posUser.id,
        w.locationId,
      ]);
      expect((await pos.get(url).query({ locationId: w.locationId })).status).toBe(200);
    }));

  it("refuses bad, unknown and another POS user's shifts", () =>
    withFactoryWorld(async (w) => {
      await retail(w);
      const mine = await shift(w);
      expect((await w.agent.get("/api/pos/retail/shifts/abc/summary")).status).toBe(400);
      const unknown = await w.agent.get("/api/pos/retail/shifts/999999999/summary");
      expect(unknown.status).toBe(400);
      expect(unknown.body.message).toBe("Shift not found");
      expect((await w.agent.get(`/api/pos/retail/shifts/${mine}/summary`)).status).toBe(200);
      const pos = await w.agentFor("POS");
      expect((await pos.get(`/api/pos/retail/shifts/${mine}/summary`)).status).toBe(403);
      const movement = await pos
        .post(`/api/pos/retail/shifts/${mine}/cash-movements`)
        .send({ movementType: "cash_in", amount: "5", reason: "float", idempotencyKey: `${w.tag}-POS` });
      expect(movement.status).toBe(403);
    }));
});

describe("retail cash movements", () => {
  it("refuses closed shifts, malformed amounts and unmapped reasons", () =>
    withFactoryWorld(async (w) => {
      await retail(w);
      const closed = await shift(w, "closed");
      const open = await shift(w);
      const post = (id: number | string, body: Record<string, unknown>) =>
        w.agent.post(`/api/pos/retail/shifts/${id}/cash-movements`).send(body);
      const base = {
        movementType: "cash_in",
        amount: "5",
        reason: "Float top-up",
        idempotencyKey: `${w.tag}-K${nextSeq()}`,
      };
      expect((await post("x", base)).status).toBe(400);
      expect((await post(closed, base)).status).toBe(409);
      for (const amount of ["abc", "0", "-1", "2000000000", 1.005, "1.005"]) {
        const res = await post(open, { ...base, amount });
        expect(res.status, String(amount)).toBe(400);
      }
      const unmapped = await post(open, base);
      expect(unmapped.status).toBe(409);
      expect(unmapped.body.code).toBe("RETAIL_CASH_REASON_UNMAPPED");
      const rows = await w.q(`SELECT 1 FROM retail_cash_movements WHERE company_id = $1`, [w.companyId]);
      expect(rows).toEqual([]);
    }));

  it("posts a mapped movement once, replays it and refuses a reused key with different data", () =>
    withFactoryWorld(async (w) => {
      await retail(w);
      const open = await shift(w);
      const key = `${w.tag}-OWNER`;
      const body = {
        movementType: "cash_in",
        amount: 25,
        reason: "Owner float",
        reasonCode: "owner_funding",
        idempotencyKey: key,
      };
      const first = await w.agent.post(`/api/pos/retail/shifts/${open}/cash-movements`).send(body);
      expect(first.status, first.text).toBe(201);
      expect(first.body.replayed).toBe(false);
      const replay = await w.agent.post(`/api/pos/retail/shifts/${open}/cash-movements`).send(body);
      expect(replay.status).toBe(200);
      expect(replay.body.replayed).toBe(true);
      for (const change of [
        { amount: 26 },
        { reason: "Different" },
        { reasonCode: "expense", movementType: "cash_out" },
      ]) {
        const res = await w.agent.post(`/api/pos/retail/shifts/${open}/cash-movements`).send({ ...body, ...change });
        expect(res.status, JSON.stringify(change)).toBe(409);
      }
      const other = await shift(w);
      const moved = await w.agent.post(`/api/pos/retail/shifts/${other}/cash-movements`).send(body);
      expect(moved.status).toBe(409);
      expect(moved.body.message).toMatch(/reused with different data/);
    }));
});
