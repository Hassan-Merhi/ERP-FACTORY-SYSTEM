/**
 * Company exchange-rate routes (server/routes/exchangeRateRoutes.ts) over HTTP
 * in one rolled-back company per test: another company's id on every read,
 * unconfigured and configured pairs, pair-filter refusals, asOf validation and
 * future dates, check-today with today's, an older and an invalid stored rate,
 * and every save refusal (read-only role, validation, unconfigured pair,
 * changed business date, non-editor back-dating, wrong pair) before the
 * audited save. Refusals write no rate rows.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/exchange-rates";

const configure = (w: FactoryWorld, display: string | null) =>
  w.q(`UPDATE companies SET base_currency = 'USD', display_currency = $2 WHERE id = $1`, [w.companyId, display]);

const addRate = (w: FactoryWorld, date: string, rate: string, from = "USD", to = "ZMW") =>
  w.q(
    `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date) VALUES ($1, $2, $3, $4, $5)`,
    [w.companyId, from, to, rate, date]
  );

const rateRows = async (w: FactoryWorld) =>
  Number(
    (await w.q<{ n: number }>(`SELECT count(*)::int AS n FROM exchange_rates WHERE company_id = $1`, [w.companyId]))[0]
      .n
  );

async function today(w: FactoryWorld): Promise<string> {
  return (await w.agent.get(`${BASE}/check-today`)).body.today as string;
}

describe("exchange-rate reads", () => {
  it("refuses another company's id on every read", () =>
    withFactoryWorld(async (w) => {
      // The company-scope guard refuses any companyId other than the active
      // one (even a company the user belongs to); a repeated active id
      // the guard rejects as malformed, so the route's own mismatch check is a
      // second line of defence that HTTP requests do not reach.
      const repeated = { companyId: [String(w.companyId), String(w.companyId)] };
      expect((await w.agent.get(BASE).query(repeated)).status).toBe(400);
      const member = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'sales', 'USD') RETURNING id`,
        [`${w.tag}M`]
      );
      await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
        w.userId,
        member,
      ]);
      for (const path of [BASE, `${BASE}/latest`, `${BASE}/check-today`]) {
        const res = await w.agent.get(path).query({ companyId: String(member) });
        expect(res.status, path).toBe(403);
        const foreign = await w.agent.get(path).query({ companyId: String(w.companyId + 100000) });
        expect(foreign.status, path).toBe(403);
        const same = await w.agent.get(path).query({ companyId: String(w.companyId) });
        expect(same.status, path).not.toBe(403);
      }
      expect(
        (
          await w.agent
            .post(BASE)
            .query({ companyId: String(member) })
            .send({})
        ).status
      ).toBe(403);
    }));

  it("treats a company without a display pair as always having a rate and refuses pair filters", () =>
    withFactoryWorld(async (w) => {
      for (const display of [null, "none", "USD"]) {
        await configure(w, display);
        const check = await w.agent.get(`${BASE}/check-today`);
        expect(check.body, String(display)).toMatchObject({ hasRate: true, latestRate: null });
      }
      await addRate(w, "2026-01-01", "20", "USD", "EUR");
      expect((await w.agent.get(BASE)).body).toHaveLength(1);
      const filtered = await w.agent.get(BASE).query({ fromCurrency: "USD", toCurrency: "EUR" });
      expect(filtered.status).toBe(400);
      expect(filtered.body.code).toBe("EXCHANGE_RATE_PAIR_MISMATCH");
      expect((await w.agent.get(`${BASE}/latest`)).status).toBe(400);
    }));

  it("filters history and resolves latest and dated rates for the configured pair", () =>
    withFactoryWorld(async (w) => {
      await configure(w, "ZMW");
      await addRate(w, "2026-01-01", "20");
      await addRate(w, "2026-01-05", "21.5");
      await addRate(w, "2026-01-01", "0.05", "ZMW", "USD");

      expect((await w.agent.get(BASE)).body).toHaveLength(3);
      const pair = await w.agent.get(BASE).query({ fromCurrency: "usd", toCurrency: "ZMW" });
      expect(pair.body.map((r: { rate: string }) => Number(r.rate)).sort()).toEqual([20, 21.5]);
      expect((await w.agent.get(BASE).query({ fromCurrency: "USD" })).body.message).toMatch(/Both fromCurrency/);
      expect((await w.agent.get(BASE).query({ toCurrency: "ZMW" })).status).toBe(400);
      const wrong = await w.agent.get(BASE).query({ fromCurrency: "ZMW", toCurrency: "USD" });
      expect(wrong.body.code).toBe("EXCHANGE_RATE_PAIR_MISMATCH");
      expect((await w.agent.get(BASE).query({ fromCurrency: "USD", toCurrency: "EUR" })).status).toBe(400);

      const latestQuery = { fromCurrency: "USD", toCurrency: "ZMW" };
      expect((await w.agent.get(`${BASE}/latest`).query({ fromCurrency: "USD" })).status).toBe(400);
      const latest = await w.agent.get(`${BASE}/latest`).query(latestQuery);
      expect(Number(latest.body.rate)).toBe(21.5);
      const dated = await w.agent.get(`${BASE}/latest`).query({ ...latestQuery, asOf: "2026-01-03" });
      expect(Number(dated.body.rate)).toBe(20);
      const before = await w.agent.get(`${BASE}/latest`).query({ ...latestQuery, asOf: "2025-12-31" });
      expect(before.body).toBeNull();
      const invalid = await w.agent.get(`${BASE}/latest`).query({ ...latestQuery, asOf: "2026-02-30" });
      expect(invalid.body.code).toBe("EXCHANGE_RATE_DATE_INVALID");
      const twice = await w.agent.get(`${BASE}/latest?fromCurrency=USD&toCurrency=ZMW&asOf=2026-01-01&asOf=2026-01-02`);
      expect(twice.body.code).toBe("EXCHANGE_RATE_DATE_INVALID");
      const future = await w.agent.get(`${BASE}/latest`).query({ ...latestQuery, asOf: "2999-01-01" });
      expect(future.body.code).toBe("EXCHANGE_RATE_FUTURE_DATE");
    }));

  it("reports today's rate, an older rate and an unusable stored rate in check-today", () =>
    withFactoryWorld(async (w) => {
      await configure(w, "ZMW");
      const missing = await w.agent.get(`${BASE}/check-today`);
      expect(missing.body).toMatchObject({ hasRate: false, missingRate: true });
      await addRate(w, "2026-01-01", "0");
      expect((await w.agent.get(`${BASE}/check-today`)).body).toMatchObject({ hasRate: false, missingRate: true });
      await addRate(w, "2026-01-02", "19");
      const older = await w.agent.get(`${BASE}/check-today`);
      expect(older.body).toMatchObject({ hasRate: false, missingRate: false });
      expect(Number(older.body.latestRate.rate)).toBe(19);
      await addRate(w, older.body.today, "22");
      const current = await w.agent.get(`${BASE}/check-today`);
      expect(current.body).toMatchObject({ hasRate: true, missingRate: false, today: older.body.today });
    }));
});

describe("exchange-rate saves", () => {
  it("refuses read-only roles, invalid bodies, unconfigured and wrong pairs and stale daily dates", () =>
    withFactoryWorld(async (w) => {
      const viewer = await w.agentFor("View Only");
      expect((await viewer.post(BASE).send({})).status).toBe(403);
      expect((await w.agent.post(BASE).query({ companyId: "999999" }).send({})).status).toBe(403);

      const date = await today(w);
      const body = { fromCurrency: "USD", toCurrency: "ZMW", rate: "21", effectiveDate: date };
      const invalid = await w.agent.post(BASE).send({ ...body, rate: "-1" });
      expect(invalid.status).toBe(400);
      expect(invalid.body.message).toBe("Validation error");

      await configure(w, null);
      for (const patch of [{ fromCurrency: "EUR" }, { toCurrency: "USD" }]) {
        const res = await w.agent.post(BASE).send({ ...body, ...patch });
        expect(res.status, JSON.stringify(patch)).toBe(409);
        expect(res.body.code).toBe("EXCHANGE_RATE_NOT_CONFIGURED");
      }

      await configure(w, "ZMW");
      const stale = await w.agent.post(BASE).send({ ...body, daily: true, effectiveDate: "2026-01-01" });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: "EXCHANGE_RATE_BUSINESS_DATE_CHANGED", today: date });
      const wrongPair = await w.agent.post(BASE).send({ ...body, toCurrency: "EUR" });
      expect(wrongPair.status).toBe(400);
      expect(wrongPair.body.code).toBe("EXCHANGE_RATE_PAIR_MISMATCH");

      const manager = await w.agentFor("Manager");
      expect((await manager.post(BASE).send({ ...body, effectiveDate: "2026-01-01" })).status).toBe(403);
      expect(await rateRows(w)).toBe(0);
    }));

  it("saves today's rate for a non-editor and any date for an editor without a configured pair", () =>
    withFactoryWorld(async (w) => {
      await configure(w, "ZMW");
      const date = await today(w);
      const manager = await w.agentFor("Manager");
      const saved = await manager
        .post(BASE)
        .send({ fromCurrency: "USD", toCurrency: "ZMW", rate: "21.25", effectiveDate: date, daily: true });
      expect(saved.status).toBe(200);
      expect(saved.headers["cache-control"]).toBe("private, no-store");
      expect(Number(saved.body.rate)).toBe(21.25);

      await configure(w, null);
      const editor = await w.agent
        .post(BASE)
        .send({ fromCurrency: "USD", toCurrency: "EUR", rate: "0.9", effectiveDate: "2026-01-01" });
      expect(editor.status).toBe(200);
      expect(editor.body).toMatchObject({ fromCurrency: "USD", toCurrency: "EUR" });
      expect(await rateRows(w)).toBe(2);
    }));
});
