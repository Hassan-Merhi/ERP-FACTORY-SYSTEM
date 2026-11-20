/**
 * Factory container update input preparation (`prepareFactoryContainerUpdate`):
 * request coercion, the no-op goods/charge field pruning, commission FX and
 * container FX resolution, and every refusal it returns before the update
 * transaction runs. Each case runs inside one rolled-back transaction and
 * drives the function with a minimal request/response pair, so the result is
 * the prepared update itself.
 */
import { describe, expect, it } from "vitest";
import type { PoolClient, QueryResult } from "pg";
import type { Request, Response } from "express";

import { prepareFactoryContainerUpdate } from "../server/routes/factory/containers/updateInput";
import { CONTAINER_MANUAL_FX_INVALID } from "../server/services/factory/containerManualFxRate";
import { withRolledBackPool } from "./helpers/routedPoolClient";

let seq = 0;
const idOf = async (result: Promise<QueryResult>) => Number((await result).rows[0].id);

interface Seed {
  currencyCode?: string | null;
  fxRateToUsd?: string;
  fxRateConfirmed?: boolean | null;
  fxRateSource?: string | null;
  ratePerKg?: string;
  totalKg?: string;
  arrivalDate?: string | null;
  commissionAmount?: string;
  commissionCurrencyCode?: string | null;
}

async function world(client: PoolClient) {
  const tag = `CUI${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase().slice(0, 18);
  const companyId = await idOf(
    client.query(
      `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
      [tag]
    )
  );
  const container = (seed: Seed = {}) =>
    idOf(
      client.query(
        `INSERT INTO factory_containers
         (company_id, container_number, currency_code, fx_rate_to_usd, fx_rate_confirmed, fx_rate_source,
          rate_per_kg, total_kg, status, arrival_date, commission_amount, commission_currency_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9, $10, $11) RETURNING id`,
        [
          companyId,
          `${tag}-${++seq}`,
          seed.currencyCode === undefined ? "USD" : seed.currencyCode,
          seed.fxRateToUsd ?? "1",
          seed.fxRateConfirmed === undefined ? true : seed.fxRateConfirmed,
          seed.fxRateSource === undefined ? "manual" : seed.fxRateSource,
          seed.ratePerKg ?? "2",
          seed.totalKg ?? "100",
          seed.arrivalDate === undefined ? "2026-06-08" : seed.arrivalDate,
          seed.commissionAmount ?? "0",
          seed.commissionCurrencyCode ?? null,
        ]
      )
    );
  const rate = (currency: string, value: string, date = "2026-01-01") =>
    client.query(
      `INSERT INTO factory_fx_rates (company_id, currency_code, rate_to_usd, effective_date, source) VALUES ($1, $2, $3, $4, 'manual')`,
      [companyId, currency, value, date]
    );
  return { companyId, container, rate };
}

function call(input: { companyId?: number | null; id: string | number; body?: unknown; clientDate?: string }) {
  const sent: { status?: number; body?: { message?: string } } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: { message?: string }) {
      sent.body = body;
      return this;
    },
  } as unknown as Response;
  const req = {
    session: { factoryCompanyId: input.companyId ?? undefined },
    params: { id: String(input.id) },
    body: input.body,
    headers: input.clientDate ? { "x-client-date": input.clientDate } : {},
  } as unknown as Request;
  return prepareFactoryContainerUpdate({ req, res }).then((result) => ({ result, sent }));
}

async function prepared(input: Parameters<typeof call>[0]) {
  const { result, sent } = await call(input);
  if (result.done) throw new Error(`refused ${sent.status}: ${JSON.stringify(sent.body)}`);
  return result;
}

describe("container update input refusals", () => {
  it("refuses without a company, with a bad id, and for a missing or foreign container", async () => {
    await withRolledBackPool(async (client) => {
      const a = await world(client);
      const b = await world(client);
      const id = await a.container();
      expect((await call({ companyId: null, id })).sent).toEqual({
        status: 400,
        body: { message: "No company selected" },
      });
      expect((await call({ companyId: a.companyId, id: "abc" })).sent).toEqual({
        status: 400,
        body: { message: "Invalid id" },
      });
      expect((await call({ companyId: a.companyId, id: id + 100000 })).sent.status).toBe(404);
      const foreign = await call({ companyId: b.companyId, id, body: { notes: "x" } });
      expect(foreign.sent).toEqual({ status: 404, body: { message: "Container not found" } });
    });
  });

  it("refuses commission in the container currency while the container rate is not set", async () => {
    await withRolledBackPool(async (client) => {
      const a = await world(client);
      const id = await a.container({ currencyCode: "EUR", fxRateToUsd: "0", fxRateConfirmed: false });
      const { sent } = await call({
        companyId: a.companyId,
        id,
        body: { commissionAmount: "50", commissionCurrencyCode: "eur" },
      });
      expect(sent.status).toBe(400);
      expect(sent.body?.message).toBe("Cannot resolve commission FX for EUR: container FX rate is not confirmed.");
    });
  });

  it("refuses a commission in a third currency without a dated factory rate", async () => {
    await withRolledBackPool(async (client) => {
      const a = await world(client);
      const id = await a.container();
      await expect(
        call({ companyId: a.companyId, id, body: { commissionAmount: "5", commissionCurrencyCode: "GBP" } })
      ).rejects.toMatchObject({ code: "FACTORY_FX_RATE_REQUIRED", currency: "GBP" });
    });
  });

  it("refuses an invalid explicit manual rate and an unconfirmed stored rate", async () => {
    await withRolledBackPool(async (client) => {
      const a = await world(client);
      const eur = await a.container({ currencyCode: "EUR", fxRateToUsd: "1.1", fxRateConfirmed: true });
      const bad = await call({ companyId: a.companyId, id: eur, body: { fxRateToUsd: "1.2abc" } });
      expect(bad.sent).toEqual({ status: 400, body: { message: CONTAINER_MANUAL_FX_INVALID } });

      const unset = await a.container({ currencyCode: "EUR", fxRateToUsd: "0", fxRateConfirmed: false });
      const missing = await call({ companyId: a.companyId, id: unset, body: { ratePerKg: "3" } });
      expect(missing.sent.status).toBe(400);
      expect(missing.sent.body?.message).toMatch(/EUR/);
    });
  });
});

describe("container update input preparation", () => {
  it("coerces blanks, keeps only changed goods fields and passes plain fields through", async () => {
    await withRolledBackPool(async (client) => {
      const a = await world(client);
      const id = await a.container();
      const result = await prepared({
        companyId: a.companyId,
        id,
        body: {
          containerNumber: "",
          supplierId: "",
          origin: "",
          totalKg: "100",
          ratePerKg: "2.000",
          arrivalDate: null,
          destination: "Port",
          notes: undefined,
          status: "",
          currencyCode: "usd",
          fxRateSource: "manual",
          fxRateToUsd: "",
          freight: "",
          freightCurrencyCode: "",
          freightAccountId: "abc",
          freightSupplierId: "",
          freightPaidBy: "",
          freightOwnAccountId: null,
          otherCharges: "",
          otherChargesCurrencyCode: "EUR",
          otherChargesAccountId: "7",
          otherChargesSupplierId: "",
          commissionAmount: "",
          commissionCurrencyCode: "",
          commissionAccountId: "",
          commissionSupplierId: "",
          commissionNotes: "",
          dutyAmount: "",
          dutyAccountId: "",
          dutyStatus: "",
          dutyNotes: "duty",
          otwNote: "",
          otwDocsReceived: 1,
        },
      });
      const data = result.updateData as Record<string, unknown>;
      expect(data).toMatchObject({
        containerNumber: "",
        origin: null,
        arrivalDate: null,
        destination: "Port",
        status: "PENDING",
        otherCharges: "0",
        otherChargesCurrencyCode: "EUR",
        otherChargesAccountId: 7,
        otherChargesSupplierId: null,
        dutyAmount: null,
        dutyAccountId: null,
        dutyStatus: "NONE",
        dutyNotes: "duty",
        otwNote: null,
        otwDocsReceived: true,
      });
      // Unchanged goods and charge fields are dropped so they cannot look like a new event.
      for (const key of [
        "totalKg",
        "ratePerKg",
        "currencyCode",
        "fxRateSource",
        "fxRateToUsd",
        "freight",
        "freightPaidBy",
        "freightOwnAccountId",
        "commissionAmount",
      ]) {
        expect(data).not.toHaveProperty(key);
      }
      expect(data).not.toHaveProperty("commissionFxRateToUsd");
      expect(data).not.toHaveProperty("ratePerKgUsd");
      expect(result.int("12x")).toBe(12);
      expect(result.dec(0)).toBe("0");
    });
  });

  it("treats a missing body as an empty edit", async () => {
    await withRolledBackPool(async (client) => {
      const a = await world(client);
      const id = await a.container();
      const result = await prepared({ companyId: a.companyId, id, body: undefined });
      expect(Object.keys(result.updateData)).toEqual(["updatedAt"]);
      expect(result.b).toEqual({});
    });
  });

  it("keeps genuine freight changes and the payer defaults", async () => {
    await withRolledBackPool(async (client) => {
      const a = await world(client);
      const id = await a.container();
      const result = await prepared({
        companyId: a.companyId,
        id,
        body: { freight: "25", freightPaidBy: "own", freightOwnAccountId: "9", freightCurrencyCode: "EUR" },
      });
      expect(result.updateData).toMatchObject({
        freight: "25",
        freightPaidBy: "own",
        freightOwnAccountId: 9,
        freightCurrencyCode: "EUR",
      });
    });
  });

  it("resolves commission FX for USD, the container currency, a third currency and clears it on zero", async () => {
    await withRolledBackPool(async (client) => {
      const a = await world(client);
      const usd = await a.container();
      const usdResult = await prepared({ companyId: a.companyId, id: usd, body: { commissionAmount: "10" } });
      expect(usdResult.updateData).toMatchObject({
        commissionFxRateToUsd: "1",
        commissionFxRateConfirmed: true,
        commissionFxRateDate: "2026-06-08",
      });

      const eur = await a.container({ currencyCode: "EUR", fxRateToUsd: "1.1", commissionAmount: "40" });
      const sameCcy = await prepared({ companyId: a.companyId, id: eur, body: { commissionCurrencyCode: "EUR" } });
      expect(sameCcy.updateData.commissionFxRateToUsd).toBe("1.1");

      await a.rate("GBP", "1.25");
      const third = await prepared({
        companyId: a.companyId,
        id: usd,
        body: { commissionAmount: "10", commissionCurrencyCode: "GBP", arrivalDate: "2026-02-01" },
      });
      expect(third.updateData).toMatchObject({ commissionFxRateToUsd: "1.25", commissionFxRateDate: "2026-02-01" });

      const withCommission = await a.container({ commissionAmount: "30", commissionCurrencyCode: "USD" });
      const zeroed = await prepared({ companyId: a.companyId, id: withCommission, body: { commissionAmount: "0" } });
      expect(zeroed.updateData).toMatchObject({
        commissionAmount: "0",
        commissionFxRateToUsd: null,
        commissionFxRateConfirmed: false,
        commissionFxRateDate: null,
      });
    });
  });

  it("uses the client date when the container has no arrival date", async () => {
    await withRolledBackPool(async (client) => {
      const a = await world(client);
      const id = await a.container({ arrivalDate: null, currencyCode: null, fxRateSource: null });
      const result = await prepared({
        companyId: a.companyId,
        id,
        clientDate: "2026-03-04",
        body: { commissionAmount: "5", ratePerKg: "4" },
      });
      expect(result.updateData).toMatchObject({
        commissionFxRateDate: "2026-03-04",
        fxRateSource: "auto",
        fxRateDateImport: "2026-03-04",
        fxRateToUsd: "1",
        ratePerKgUsd: "4",
      });
    });
  });

  it("auto FX takes the dated factory rate and converts the kg rate", async () => {
    await withRolledBackPool(async (client) => {
      const a = await world(client);
      await a.rate("EUR", "1.2");
      const id = await a.container();
      const result = await prepared({
        companyId: a.companyId,
        id,
        body: { currencyCode: "EUR", fxRateSource: "auto", ratePerKg: "3" },
      });
      expect(result.updateData).toMatchObject({
        currencyCode: "EUR",
        fxRateSource: "auto",
        fxRateToUsd: "1.20000000",
        fxRateToUsdImport: "1.20000000",
        fxRateConfirmed: true,
        ratePerKgUsd: "3.6",
      });
    });
  });

  it("manual FX trusts an explicit rate, else carries forward a confirmed stored rate", async () => {
    await withRolledBackPool(async (client) => {
      const a = await world(client);
      const id = await a.container({ currencyCode: "EUR", fxRateToUsd: "1.1", fxRateConfirmed: true });
      const explicit = await prepared({ companyId: a.companyId, id, body: { fxRateToUsd: "1.3" } });
      expect(explicit.updateData).toMatchObject({
        fxRateToUsd: "1.3",
        fxRateConfirmed: true,
        fxRateSource: "manual",
        ratePerKgUsd: "2.6",
      });

      const carried = await prepared({ companyId: a.companyId, id, body: { ratePerKg: "5" } });
      expect(carried.updateData).toMatchObject({ fxRateToUsd: "1.1", ratePerKgUsd: "5.5", fxRateSource: "manual" });
      expect(carried.updateData).not.toHaveProperty("fxRateConfirmed");

      // Switching auto -> manual with the same numeric rate is still a real FX edit.
      const auto = await a.container({ currencyCode: "EUR", fxRateToUsd: "1.1", fxRateSource: "auto" });
      const switched = await prepared({
        companyId: a.companyId,
        id: auto,
        body: { fxRateSource: "MANUAL", fxRateToUsd: "1.1" },
      });
      expect(switched.updateData).toMatchObject({ fxRateToUsd: "1.1", fxRateConfirmed: true });

      const usd = await a.container();
      const usdManual = await prepared({ companyId: a.companyId, id: usd, body: { ratePerKg: "7" } });
      expect(usdManual.updateData).toMatchObject({ fxRateToUsd: "1", ratePerKgUsd: "7" });
    });
  });
});
