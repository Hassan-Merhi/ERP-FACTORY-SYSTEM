/**
 * Owner "Accounting clean-up" page, card 2: dated rate files.
 *
 *   POST /api/factory/fx-rates/batch   factory_fx_rates (USD per unit), Admin/Owner
 *   POST /api/exchange-rates/batch     exchange_rates (company pairs), Admin/Owner
 *
 * Each validates every row before writing, refuses a date after the company's
 * business date, skips rows equal to the rate recorded on their date, refuses
 * differing rows unless replaceConflicts, and writes the rates with one audit
 * row in one transaction (nothing written on a refusal).
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { companyBusinessDate } from "../server/services/accounting/companyBusinessDate";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "ownercleanuprates";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let today: string;

const asMaintenance = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("owner-cleanup-rates-test", work);

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
}

async function factoryRates() {
  return (
    await asMaintenance(() =>
      pool.query(
        `SELECT currency_code, rate_to_usd::text AS rate, effective_date::text AS date, source
           FROM factory_fx_rates WHERE company_id = $1 ORDER BY currency_code, effective_date, id`,
        [ctx.companyId]
      )
    )
  ).rows;
}

async function companyRates() {
  return (
    await asMaintenance(() =>
      pool.query(
        `SELECT from_currency, to_currency, rate::text AS rate, effective_date::text AS date
           FROM exchange_rates WHERE company_id = $1 ORDER BY from_currency, effective_date, id`,
        [ctx.companyId]
      )
    )
  ).rows;
}

async function importAudits(tableName: string) {
  return (
    await pool.query(
      `SELECT action, record_identifier, changes FROM audit_log
        WHERE company_id = $1 AND table_name = $2 AND record_identifier LIKE 'rates-file-import:%' ORDER BY id`,
      [ctx.companyId, tableName]
    )
  ).rows;
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  await setRole("Owner");
  today = await companyBusinessDate(ctx.companyId);
}, 120000);

afterAll(async () => {
  await withFixtureTransaction(async (client) => {
    await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
    await client.query(`DELETE FROM exchange_rates WHERE company_id = $1`, [ctx.companyId]);
    await client.query(`DELETE FROM factory_fx_rates WHERE company_id = $1`, [ctx.companyId]);
  });
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  await closeTestServer();
}, 120000);

describe("factory rates file", () => {
  const rows = [
    { currencyCode: "EUR", effectiveDate: "2026-03-26", rateToUsd: "1.153900" },
    { currencyCode: "AUD", effectiveDate: "2026-03-26", rateToUsd: "0.691248" },
  ];

  it("is Admin/Owner only and validates every row before writing", async () => {
    await setRole("Manager");
    expect((await agent.post("/api/factory/fx-rates/batch").send({ rows })).status).toBe(403);
    await setRole("Owner");

    const empty = await agent.post("/api/factory/fx-rates/batch").send({ rows: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("RATE_IMPORT_EMPTY");

    const invalid = await agent
      .post("/api/factory/fx-rates/batch")
      .send({ rows: [...rows, { currencyCode: "EUR", effectiveDate: "2026-02-30", rateToUsd: "1.1" }] });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: "RATE_IMPORT_INVALID_ROW", rows: [{ row: 3, field: "effectiveDate" }] });

    const negative = await agent
      .post("/api/factory/fx-rates/batch")
      .send({ rows: [{ currencyCode: "EUR", effectiveDate: "2026-03-27", rateToUsd: "-1" }] });
    expect(negative.body.code).toBe("RATE_IMPORT_INVALID_ROW");

    const future = await agent
      .post("/api/factory/fx-rates/batch")
      .send({ rows: [...rows, { currencyCode: "EUR", effectiveDate: "2999-01-01", rateToUsd: "1.1" }] });
    expect(future.status).toBe(400);
    expect(future.body).toMatchObject({ code: "RATE_IMPORT_FUTURE_DATE", rows: [{ row: 3, businessDate: today }] });

    const duplicate = await agent.post("/api/factory/fx-rates/batch").send({ rows: [...rows, rows[0]] });
    expect(duplicate.body.code).toBe("RATE_IMPORT_DUPLICATE_ROW");

    expect(await factoryRates()).toEqual([]);
    expect(await importAudits("factory_fx_rates")).toEqual([]);
  });

  it("saves new rows as manual rates with one audit row in the same transaction", async () => {
    const saved = await agent.post("/api/factory/fx-rates/batch").send({ rows });
    expect(saved.status).toBe(200);
    expect(saved.body.inserted).toHaveLength(2);
    expect(saved.body.identical).toEqual([]);
    expect(await factoryRates()).toEqual([
      { currency_code: "AUD", rate: "0.69124800", date: "2026-03-26", source: "manual" },
      { currency_code: "EUR", rate: "1.15390000", date: "2026-03-26", source: "manual" },
    ]);
    const audits = await importAudits("factory_fx_rates");
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("create");
    expect(audits[0].changes.rates.new).toHaveLength(2);
    expect(audits[0].changes.rates.old).toEqual([]);
  });

  it("skips identical rows, refuses a differing row, and replaces it only when asked", async () => {
    const again = await agent.post("/api/factory/fx-rates/batch").send({ rows });
    expect(again.status).toBe(200);
    expect(again.body.inserted).toEqual([]);
    expect(again.body.identical).toHaveLength(2);
    expect(await importAudits("factory_fx_rates")).toHaveLength(1);

    const changed = [
      { currencyCode: "EUR", effectiveDate: "2026-03-26", rateToUsd: "1.16" },
      { currencyCode: "EUR", effectiveDate: "2026-04-02", rateToUsd: "1.1525" },
    ];
    const conflict = await agent.post("/api/factory/fx-rates/batch").send({ rows: changed });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({
      code: "RATE_IMPORT_CONFLICT",
      rows: [{ row: 1, currencyCode: "EUR", effectiveDate: "2026-03-26", recorded: "1.15390000" }],
    });
    expect(await factoryRates()).toHaveLength(2);

    const replaced = await agent.post("/api/factory/fx-rates/batch").send({ rows: changed, replaceConflicts: true });
    expect(replaced.status).toBe(200);
    expect(replaced.body.inserted.map((row: { replaced: string | null }) => row.replaced)).toEqual([
      "1.15390000",
      null,
    ]);
    // The resolver reads the latest manual row of a date: the replacement wins.
    const read = await agent.get("/api/factory/fx-rates/EUR/2026-03-26");
    expect(read.body).toMatchObject({ rate: "1.16000000", saved: true });
    const audits = await importAudits("factory_fx_rates");
    expect(audits).toHaveLength(2);
    expect(audits[1].changes.rates.old).toHaveLength(1);
  });
});

describe("company rates file", () => {
  const rows = [
    { fromCurrency: "EUR", toCurrency: "USD", effectiveDate: "2026-03-26", rate: "1.153900" },
    { fromCurrency: "AUD", toCurrency: "USD", effectiveDate: "2026-03-26", rate: "0.691248" },
  ];

  it("refuses an invalid or future row and writes nothing", async () => {
    await setRole("Manager");
    expect((await agent.post("/api/exchange-rates/batch").send({ rows })).status).toBe(403);
    await setRole("Owner");
    const same = await agent
      .post("/api/exchange-rates/batch")
      .send({ rows: [{ fromCurrency: "USD", toCurrency: "USD", effectiveDate: "2026-03-26", rate: "1" }] });
    expect(same.body).toMatchObject({ code: "RATE_IMPORT_INVALID_ROW", rows: [{ row: 1, field: "toCurrency" }] });
    const future = await agent
      .post("/api/exchange-rates/batch")
      .send({ rows: [...rows, { fromCurrency: "EUR", toCurrency: "USD", effectiveDate: "2999-01-01", rate: "1" }] });
    expect(future.body.code).toBe("RATE_IMPORT_FUTURE_DATE");
    expect(await companyRates()).toEqual([]);
  });

  it("saves, skips identical rows, and replaces a differing rate on its date only when asked", async () => {
    const saved = await agent.post("/api/exchange-rates/batch").send({ rows });
    expect(saved.status).toBe(200);
    expect(saved.body.inserted).toHaveLength(2);
    expect(await companyRates()).toEqual([
      { from_currency: "AUD", to_currency: "USD", rate: "0.691248", date: "2026-03-26" },
      { from_currency: "EUR", to_currency: "USD", rate: "1.153900", date: "2026-03-26" },
    ]);

    const again = await agent.post("/api/exchange-rates/batch").send({ rows });
    expect(again.body.identical).toHaveLength(2);

    const changed = [{ fromCurrency: "EUR", toCurrency: "USD", effectiveDate: "2026-03-26", rate: "1.2" }];
    expect((await agent.post("/api/exchange-rates/batch").send({ rows: changed })).status).toBe(409);
    const replaced = await agent.post("/api/exchange-rates/batch").send({ rows: changed, replaceConflicts: true });
    expect(replaced.status).toBe(200);
    // One row per company, date and pair: the rate is updated in place.
    expect(await companyRates()).toEqual([
      { from_currency: "AUD", to_currency: "USD", rate: "0.691248", date: "2026-03-26" },
      { from_currency: "EUR", to_currency: "USD", rate: "1.200000", date: "2026-03-26" },
    ]);
    const audits = await importAudits("exchange_rates");
    expect(audits).toHaveLength(2);
    expect(audits[1].changes.rates.old).toEqual([
      expect.objectContaining({ fromCurrency: "EUR", effectiveDate: "2026-03-26", replaced: "1.153900" }),
    ]);
  });
});
