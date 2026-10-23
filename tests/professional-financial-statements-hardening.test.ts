/**
 * Phase 11 hardening contract for the professional financial statements.
 *
 *   - a cash journal with two cash/bank lines and one noncash line is never
 *     given a simple-counterparty cash-flow label;
 *   - unclassified financial-position accounts that offset to zero still keep
 *     the balance sheet from reporting `balanced`, and the reported and
 *     ledger-residual differences are both exposed;
 *   - the comparison period's historical FX readiness is assessed at its own
 *     accounting cutoff rather than copied from the current period.
 *
 * The report is read-only: every test also checks the financial rows it reads
 * are unchanged afterwards.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "uafsh";
const FROM = "2026-09-01";
const AS_OF = "2026-09-30";
// priorClosingPeriod(FROM, AS_OF) is the 30 days ending the day before FROM.
const COMPARISON_AS_OF = "2026-08-31";

let ctx: TestContext;
let admin: request.SuperAgentTest;
let expenseId: number;
let mysteryDebitId: number;
let mysteryCreditId: number;
let bankAId: number;
let bankBId: number;
let simpleVoucherId: number;
let twoBankVoucherId: number;

async function ledger(code: string, name: string, accountType: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ctx.companyId, `${PREFIX}_${code}`, name, accountType]
  );
  return rows[0].id;
}

async function bank(code: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number)
     VALUES ($1, $2, $3, 'Hardening Bank', $4) RETURNING id`,
    [ctx.companyId, `${PREFIX}${code}`, `Hardening ${code}`, `${PREFIX}-${code}-0001`]
  );
  return rows[0].id;
}

async function voucher(
  number: string,
  date: string,
  lines: Array<Record<string, unknown>>,
  currency = "USD",
  rate: string | null = null
) {
  return withFixtureTransaction(async (client) => {
    const created = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate)
       VALUES ($1, $2, 'Journal', $3, 0, $4, $5) RETURNING id`,
      [ctx.companyId, `${PREFIX}-${number}`, date, currency, rate]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, company_id, ledger_account_id, bank_account_id,
           debit_amount, credit_amount, transaction_currency, transaction_debit_amount, transaction_credit_amount,
           base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          created.rows[0].id,
          ctx.companyId,
          line.ledger ?? null,
          line.bank ?? null,
          line.debit ?? "0",
          line.credit ?? "0",
          line.currency ?? null,
          line.currency ? (line.nativeDebit ?? "0") : null,
          line.currency ? (line.nativeCredit ?? "0") : null,
          line.baseDebit ?? null,
          line.baseCredit ?? null,
          line.currency ? "0.9" : null,
          line.currency ? "TRANSACTION_PER_BASE" : null,
        ]
      );
    }
    return created.rows[0].id;
  });
}

async function voucherChecksum() {
  const { rows } = await pool.query<{ h: string | null }>(
    `SELECT md5(string_agg(t::text, ';' ORDER BY t::text)) AS h
       FROM (SELECT v.*, e.* FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
              WHERE v.company_id = $1) t`,
    [ctx.companyId]
  );
  return rows[0].h;
}

async function statements(compare: boolean) {
  const before = await voucherChecksum();
  const res = await admin.get(
    `/api/accounting/statements/professional?fromDate=${FROM}&asOfDate=${AS_OF}&compare=${compare}`
  );
  expect(res.status).toBe(200);
  expect(await voucherChecksum()).toBe(before);
  return res.body;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  admin = request.agent(ctx.app);
  expect(
    (await admin.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await admin.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  expenseId = await ledger("EXP", "Hardening Expense", "Expense");
  mysteryDebitId = await ledger("MYS_D", "Unknown Debit", "Mystery Type");
  mysteryCreditId = await ledger("MYS_C", "Unknown Credit", "Mystery Type");
  bankAId = await bank("BA");
  bankBId = await bank("BB");

  // A simple single-cash-line payment: the only voucher allowed a named class.
  simpleVoucherId = await voucher("SIMPLE", "2026-09-10", [
    { ledger: expenseId, debit: "30.00" },
    { bank: bankAId, credit: "30.00" },
  ]);
  // One noncash line paid from two banks: a mixed cash journal.
  twoBankVoucherId = await voucher("TWOBANK", "2026-09-12", [
    { ledger: expenseId, debit: "100.00" },
    { bank: bankAId, credit: "60.00" },
    { bank: bankBId, credit: "40.00" },
  ]);
  // Two unclassified financial-position accounts that offset to zero.
  await voucher("MYSTERY", "2026-09-14", [
    { ledger: mysteryDebitId, debit: "50.00" },
    { ledger: mysteryCreditId, credit: "50.00" },
  ]);
  // Historical FX: the backfill started before the comparison cutoff, and only
  // the current period holds a non-USD entry with no historical base value.
  await voucher(
    "EURBASED",
    "2026-07-15",
    [
      { ledger: expenseId, debit: "20.00", currency: "EUR", nativeDebit: "18.00", baseDebit: "20.00", baseCredit: "0" },
      { bank: bankAId, credit: "20.00", currency: "EUR", nativeCredit: "18.00", baseDebit: "0", baseCredit: "20.00" },
    ],
    "EUR",
    "0.9"
  );
  const legacyId = await voucher(
    "EURMISSING",
    "2026-09-20",
    [
      { ledger: expenseId, debit: "10.00", currency: "EUR", nativeDebit: "9.00", baseDebit: "10.00", baseCredit: "0" },
      {
        ledger: mysteryDebitId,
        credit: "10.00",
        currency: "EUR",
        nativeCredit: "9.00",
        baseDebit: "0",
        baseCredit: "10.00",
      },
    ],
    "EUR",
    "0.9"
  );
  // New lines always get a base value from the currency trigger; recreate a
  // legacy unbackfilled row the only way it exists: base cleared without
  // touching the voucher, amounts or transaction currency.
  await withFixtureTransaction((client) =>
    client.query(
      `UPDATE voucher_entries SET base_debit_amount = NULL, base_credit_amount = NULL WHERE voucher_id = $1`,
      [legacyId]
    )
  );
});

afterAll(async () => {
  await cleanupTestData(PREFIX);
  await closeTestServer();
});

describe("cash-flow classification", () => {
  it("labels only the single-cash-line voucher and leaves the two-bank journal unclassified", async () => {
    const body = await statements(false);
    const sample: Array<{ voucherId: number; classification: string; changeUsd: string }> =
      body.current.cashFlow.sourceSample;
    const simple = sample.find((row) => row.voucherId === simpleVoucherId);
    const twoBank = sample.find((row) => row.voucherId === twoBankVoucherId);
    expect(simple).toMatchObject({ classification: "operating", changeUsd: "-30.00" });
    expect(twoBank).toMatchObject({ classification: "unclassified", changeUsd: "-100.00" });
    // The mixed journal stays in the cash movement as unclassified, never dropped.
    expect(Number(body.current.cashFlow.unclassifiedUsd)).toBeLessThanOrEqual(-100);
  });
});

describe("balance sheet with unclassified accounts", () => {
  it("never reports balanced while unclassified rows exist, and exposes both differences", async () => {
    const body = await statements(false);
    const position = body.current.financialPosition;
    expect(position.unclassified.lines.length).toBeGreaterThanOrEqual(2);
    expect(position.balanced).toBe(false);
    const reported = Number(position.reportedBalanceSheetDifferenceUsd);
    const residual = Number(position.assetsMinusLiabilitiesAndEquityUsd);
    expect(reported - residual).toBeCloseTo(Number(position.unclassified.totalUsd), 2);
  });
});

describe("comparison-period historical FX readiness", () => {
  it("assesses the comparison period at its own cutoff", async () => {
    const body = await statements(true);
    expect(body.comparisonPeriod.asOfDate).toBe(COMPARISON_AS_OF);
    expect(body.historicalFx.ready).toBe(false);
    expect(body.historicalFx.legacyCompatibilityMode).toBe(false);
    expect(body.comparisonHistoricalFx).toMatchObject({
      asOfDate: COMPARISON_AS_OF,
      ready: true,
      legacyCompatibilityMode: false,
      certified: false,
    });
    expect(body.current.controls.blockers).toContain(
      "Current-period historical currency data is incomplete; financial statement amounts require review"
    );
    expect(body.comparison.controls.blockers).not.toContain(
      "Comparison-period historical currency data is incomplete; comparison amounts require review"
    );
  });

  it("returns no comparison readiness when comparison is off", async () => {
    const body = await statements(false);
    expect(body.comparison).toBeNull();
    expect(body.comparisonHistoricalFx).toBeNull();
  });
});
