/**
 * Refusal and currency branches of server/routes/vouchers/voucherCreateRoutes.ts
 * not covered by voucher-with-entries-create-route.test.ts: POS and stock
 * type refusals, body companyId of another company, total and optional
 * validation, ZMW header totals at the approved rate (and refusals without
 * one), caller-supplied dual-currency lines, idempotent replay by header,
 * and a non-ZMW line on a ZMW voucher. Rolled back per test.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const today = new Date().toISOString().slice(0, 10);

async function ledgers(w: FactoryWorld) {
  const mk = (code: string, name: string, type: string) =>
    w.one(`INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, $4) RETURNING id`, [
      w.companyId,
      `${w.tag}${code}`,
      name,
      type,
    ]);
  return { cash: await mk("C", "Cash", "Cash"), rent: await mk("R", "Rent", "Expense") };
}

async function zambia(w: FactoryWorld, rate = "25") {
  await w.q(`UPDATE companies SET display_currency = 'ZMW' WHERE id = $1`, [w.companyId]);
  await w.q(
    `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date) VALUES ($1, 'USD', 'ZMW', $2, '2020-01-01')`,
    [w.companyId, rate]
  );
}

describe("POST /api/vouchers", () => {
  const header = (w: FactoryWorld, over: Record<string, unknown> = {}) => ({
    voucherNumber: `${w.tag}-H`,
    voucherType: "Journal",
    voucherDate: today,
    totalAmount: "10",
    ...over,
  });

  it("refuses stock types, missing fields, bad totals and a non-boolean optional", async () => {
    await withFactoryWorld(async (w) => {
      const post = (body: Record<string, unknown>) => w.agent.post("/api/vouchers").send(body);
      expect((await post(header(w, { voucherType: "Consumption" }))).status).toBe(400);
      const missing = await post(header(w, { voucherNumber: "" }));
      expect(missing.body).toEqual({ message: "Invalid request data", field: "voucherNumber" });
      expect((await post(header(w, { totalAmount: "abc" }))).body.field).toBe("totalAmount");
      expect((await post(header(w, { totalAmount: "-5" }))).body.field).toBe("totalAmount");
      expect((await post(header(w, { optional: "yes" }))).body.field).toBe("optional");
      // Mixed is a stock type, so the route's signed-total allowance for it is never reached.
      expect((await post(header(w, { voucherType: "Mixed", totalAmount: "-293.9" }))).body.code).toBe(
        "STOCK_VOUCHER_TYPE_NOT_ALLOWED"
      );
      const sameCompany = await post(header(w, { companyId: w.companyId, totalAmount: " 12.345 " }));
      expect(sameCompany.status).toBe(200);
      expect(sameCompany.body.totalAmount).toBe("12.35");
      const rows = await w.q(`SELECT 1 FROM vouchers WHERE company_id = $1`, [w.companyId]);
      expect(rows).toHaveLength(1);
    });
  });

  it("refuses a body companyId of another company", async () => {
    await withFactoryWorld(async (w) => {
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const res = await w.agent.post("/api/vouchers").send(header(w, { companyId: other }));
      expect(res.status).toBe(403);
      expect(await w.q(`SELECT 1 FROM vouchers WHERE company_id = ANY($1::int[])`, [[w.companyId, other]])).toEqual([]);
    });
  });

  it("refuses POS users for anything but a stock transfer", async () => {
    await withFactoryWorld(async (w) => {
      const pos = await w.agentFor("POS");
      const res = await pos.post("/api/vouchers").send(header(w));
      expect(res.status).toBe(403);
    });
  });

  it("stores a ZMW header total as historical USD at the approved rate and refuses a mismatched rate", async () => {
    await withFactoryWorld(async (w) => {
      await zambia(w);
      const ok = await w.agent.post("/api/vouchers").send(
        header(w, {
          currency: "ZMW",
          exchangeRate: "25",
          totalAmount: "250",
          description: "  ",
          locationId: w.locationId,
          locationName: "Yard",
          effectiveDate: today,
        })
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ currency: "ZMW", totalAmount: "10.00", locationId: w.locationId });
      expect(Number(ok.body.exchangeRate)).toBe(25);
      expect(ok.body.description).toBeNull();

      const wrongRate = await w.agent
        .post("/api/vouchers")
        .send(header(w, { voucherNumber: `${w.tag}-H2`, currency: "ZMW", exchangeRate: "26" }));
      expect(wrongRate.status).toBeGreaterThanOrEqual(400);
      expect(wrongRate.body.message).toMatch(/differs from the approved historical rate/);

      const lower = await w.agent
        .post("/api/vouchers")
        .send(header(w, { voucherNumber: `${w.tag}-H3`, currency: "usd" }));
      expect(lower.body.currency).toBe("USD");
    });
  });
});

describe("POST /api/vouchers/with-entries", () => {
  const body = (
    w: FactoryWorld,
    acc: { cash: number; rent: number },
    voucher: Record<string, unknown> = {},
    lines?: unknown[]
  ) => ({
    voucher: { voucherType: "Journal", voucherDate: today, ...voucher },
    entries: lines ?? [
      { ledgerAccountId: acc.rent, debitAmount: "40" },
      { ledgerAccountId: acc.cash, creditAmount: "40" },
    ],
  });

  it("refuses a stock type and replays the same idempotency key without a second voucher", async () => {
    await withFactoryWorld(async (w) => {
      const acc = await ledgers(w);
      const refused = await w.agent
        .post("/api/vouchers/with-entries")
        .send(body(w, acc, { voucherType: "Production" }));
      expect(refused.status).toBe(400);

      const key = `${w.tag}-idem`;
      const first = await w.agent.post("/api/vouchers/with-entries").set("X-Idempotency-Key", key).send(body(w, acc));
      expect(first.status).toBe(200);
      const second = await w.agent.post("/api/vouchers/with-entries").set("X-Idempotency-Key", key).send(body(w, acc));
      expect(second.status).toBe(200);
      expect(second.body.voucher.id).toBe(first.body.voucher.id);
      expect(await w.q(`SELECT 1 FROM vouchers WHERE company_id = $1`, [w.companyId])).toHaveLength(1);
    });
  });

  it("keeps caller-supplied dual-currency fields and an explicit header rate", async () => {
    await withFactoryWorld(async (w) => {
      const acc = await ledgers(w);
      const res = await w.agent.post("/api/vouchers/with-entries").send(
        body(w, acc, { currency: "USD", exchangeRate: "1", description: "dual", voucherNumber: `${w.tag}-DN` }, [
          {
            ledgerAccountId: acc.rent,
            debitAmount: "40",
            transactionCurrency: "USD",
            transactionDebitAmount: "40",
            baseDebitAmount: "40",
            historicalExchangeRate: "1",
            rateConvention: "IDENTITY",
            narration: "rent",
          },
          { ledgerAccountId: acc.cash, creditAmount: "40", transactionCurrency: "USD", transactionCreditAmount: "40" },
        ])
      );
      expect(res.status).toBe(200);
      const lines = await w.q(
        `SELECT transaction_currency, narration FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [res.body.voucher.id]
      );
      expect(lines.map((l) => l.transaction_currency)).toEqual(["USD", "USD"]);
    });
  });

  it("converts ZMW lines on the server and refuses a non-ZMW line on a ZMW voucher", async () => {
    await withFactoryWorld(async (w) => {
      const acc = await ledgers(w);
      await zambia(w, "20");
      const ok = await w.agent.post("/api/vouchers/with-entries").send(
        body(w, acc, { currency: "ZMW", exchangeRate: "20" }, [
          { ledgerAccountId: acc.rent, debitAmount: "200" },
          {
            ledgerAccountId: acc.cash,
            transactionCreditAmount: "200",
            creditAmount: "200",
            transactionCurrency: "ZMW",
          },
        ])
      );
      expect(ok.status).toBe(200);
      const lines = await w.q(
        `SELECT debit_amount::text, credit_amount::text, transaction_currency FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [ok.body.voucher.id]
      );
      expect(lines).toEqual([
        { debit_amount: "10.00", credit_amount: "0.00", transaction_currency: "ZMW" },
        { debit_amount: "0.00", credit_amount: "10.00", transaction_currency: "ZMW" },
      ]);

      const mixed = await w.agent.post("/api/vouchers/with-entries").send(
        body(w, acc, { currency: "ZMW", exchangeRate: "20" }, [
          { ledgerAccountId: acc.rent, debitAmount: "200", transactionCurrency: "USD", transactionDebitAmount: "200" },
          { ledgerAccountId: acc.cash, creditAmount: "200" },
        ])
      );
      expect(mixed.status).toBe(400);
      expect(mixed.body.code).toBe("POSTING_CURRENCY_INVALID");
      expect(await w.q(`SELECT 1 FROM vouchers WHERE company_id = $1`, [w.companyId])).toHaveLength(1);
    });
  });

  it("refuses an EUR voucher without any rate", async () => {
    await withFactoryWorld(async (w) => {
      const acc = await ledgers(w);
      const res = await w.agent.post("/api/vouchers/with-entries").send(body(w, acc, { currency: "EUR" }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("POSTING_EXCHANGE_RATE_REQUIRED");
      expect(await w.q(`SELECT 1 FROM vouchers WHERE company_id = $1`, [w.companyId])).toEqual([]);
    });
  });
});
