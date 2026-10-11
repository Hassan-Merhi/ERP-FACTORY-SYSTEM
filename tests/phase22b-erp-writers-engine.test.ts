/**
 * Phase 22 (B) — the ERP writers on the central posting engine.
 *
 * A representative writer per group posts through `postBalancedVoucherTx`:
 * balanced, exact Decimal amounts, the engine-allocated number
 * (TYPE-<company>-YYYY-NNNNNN, or the kept family prefix where readers find the
 * voucher by its number), a posting identity so a replay posts nothing twice,
 * and the correction policy on edits (closed period → 409, reverse instead).
 * Plus D6 (the Golden Coast owner-withdrawal template is confirmed, never
 * silent), D7 (one intercompany POS journal per sale, the destination cash
 * account by configured link) and D8 (the counterpart rescale in Decimal with
 * the remainder on the last line, the transfer link following the edit).
 */
import { randomUUID } from "node:crypto";

import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { getCompanyBusinessDate } from "../server/lib/dateUtils";
import { MoneyDecimal } from "../server/lib/money";
import { postRentAccrualForCompany } from "../server/routes/rental/shared";
import { ensureMonthlyLedgerRows } from "../server/routes/rental/shared/monthly-rows";
import {
  recalculateIntercompanyForDate,
  runIntercompanyPosTransfer,
} from "../server/routes/helpers/intercompanyHelpers";
import { rescaleWithRemainderOnLast } from "../server/routes/vouchers/intercompanyCounterpartRescale";
import { buildErpVoucherEntries, postErpVoucherTx } from "../server/services/accounting/erpVoucherPosting";
import {
  runRecurringJournal,
  upsertRecurringJournalFromVoucher,
} from "../server/services/accounting/recurringJournalService";
import { runInCompanyPostingScope } from "../server/services/accounting/scheduledPostingScope";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "ph22berp";
const PREFIX_B = "ph22berpb";
const ENGINE_NUMBER = /^[A-Z0-9]+-\d+-\d{4}-\d{6}$/;

let ctx: TestContext;
let other: TestContext;
let agent: request.SuperAgentTest;
let sequence = 0;
const contractIds: number[] = [];
const unitIds: number[] = [];
const employeeIds: number[] = [];

const asScheduler = <T>(work: () => Promise<T>) => runWithDatabaseMaintenanceScope("scheduler:phase22b-test", work);

function engineNumber(number: string, prefix: string, companyId = ctx.companyId) {
  expect(number).toMatch(ENGINE_NUMBER);
  expect(number.startsWith(`${prefix}-${companyId}-`)).toBe(true);
}

const linesOf = async (voucherId: number) =>
  (
    await pool.query<{ ledger_account_id: number | null; employee_id: number | null; debit: string; credit: string }>(
      `SELECT ledger_account_id, employee_id, debit_amount::text AS debit, credit_amount::text AS credit
         FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [voucherId]
    )
  ).rows;

async function expectBalanced(voucherId: number, total: string) {
  const lines = await linesOf(voucherId);
  const debit = lines.reduce((sum, line) => sum.plus(line.debit), new MoneyDecimal(0));
  const credit = lines.reduce((sum, line) => sum.plus(line.credit), new MoneyDecimal(0));
  expect(debit.toFixed(2)).toBe(total);
  expect(credit.toFixed(2)).toBe(total);
}

const postedFor = async (companyId: number, sourceType: string, sourceIdLike = "%") =>
  (
    await pool.query<{ id: number; voucher_number: string; total_amount: string; voucher_date: string }>(
      `SELECT v.id, v.voucher_number, v.total_amount::text AS total_amount, v.voucher_date::text AS voucher_date
         FROM accounting_posting_requests apr JOIN vouchers v ON v.id = apr.voucher_id
        WHERE apr.company_id = $1 AND apr.source_type = $2 AND apr.source_id LIKE $3 AND v.deleted_at IS NULL
        ORDER BY v.id`,
      [companyId, sourceType, sourceIdLike]
    )
  ).rows;

async function ledger(companyId: number, code: string, accountType: string, subType: string | null = null) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, active)
     VALUES ($1, $2, $3, $4, $5, 0, true) RETURNING id`,
    [companyId, code, code === "GCSC" ? "GC Sales Cash" : `${PREFIX} ${code}`, accountType, subType]
  );
  return rows[0].id;
}

async function fixtureJournal(
  companyId: number,
  date: string,
  lines: Array<{ accountId: number; debit?: string; credit?: string }>
) {
  sequence += 1;
  const total = lines.reduce((sum, line) => sum.plus(line.debit ?? 0), new MoneyDecimal(0)).toFixed(2);
  return withFixtureTransaction(async (client) => {
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, source_module)
       VALUES ($1, $2, 'Journal', $3, $4, 'USD', 'ERP') RETURNING id`,
      [companyId, `${PREFIX.toUpperCase()}-FX-${process.pid}-${sequence}`, date, total]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
        [rows[0].id, line.accountId, line.debit ?? "0", line.credit ?? "0"]
      );
    }
    return rows[0].id;
  });
}

const journalBody = (voucherDate: string, amount: string, extra: Record<string, unknown> = {}) => ({
  voucherDate,
  currency: "USD",
  notes: `${PREFIX} journal`,
  entries: [
    { accountType: "ledger", accountId: ctx.cashAccountId, type: "DR", amount },
    { accountType: "ledger", accountId: ctx.salesAccountId, type: "CR", amount },
  ],
  ...extra,
});

async function createJournal(voucherDate: string, amount: string) {
  const response = await agent.post("/api/vouchers/journal").send(journalBody(voucherDate, amount));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.voucher as { id: number; voucherNumber: string };
}

async function setStock(stockItemId: number, quantity: string, rate: string) {
  await pool.query(
    `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $3, $4, $5, ($4::numeric * $5::numeric))
     ON CONFLICT (location_id, stock_item_id) DO UPDATE
       SET quantity = EXCLUDED.quantity, average_rate = EXCLUDED.average_rate, total_value = EXCLUDED.total_value`,
    [ctx.companyId, ctx.locationId, stockItemId, quantity, rate]
  );
}

const creditNoteBody = (voucherDate: string, quantity: string) => ({
  noteType: "Credit Note",
  voucherDate,
  cashAccountId: ctx.cashAccountId,
  cashAccountType: "ledger",
  description: `${PREFIX} credit note`,
  items: [
    {
      stockItemId: ctx.stockItemIds[0],
      locationId: ctx.locationId,
      quantity,
      refundRate: "4.10",
      inventoryCost: "4.10",
    },
  ],
});

async function closeBooksThrough(date: string) {
  const closing = await fixtureJournal(ctx.companyId, date, [
    { accountId: ctx.cashAccountId, debit: "1.00" },
    { accountId: ctx.salesAccountId, credit: "1.00" },
  ]);
  await pool.query(
    `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
       closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
     VALUES ($1, '2026-01-01', $2, $3, $4, $5, 0, 0, 0, 'CLOSED')`,
    [ctx.companyId, date, ctx.userId, closing, ctx.cashAccountId]
  );
}

// Fixtures dated in January 2026, closed before the correction-policy tests run.
let closedJournal: { id: number; voucherNumber: string };
let closedCreditNoteId: number;

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  other = await seedTestData(PREFIX_B);
  await pool.query(`UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
  ]);
  await pool.query(
    `UPDATE user_company_roles SET can_sell_negative_stock = true WHERE user_id = $1 AND company_id = $2`,
    [ctx.userId, ctx.companyId]
  );
  // The same user may act in the counterpart company (D8 checks access to both).
  await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
    ctx.userId,
    other.companyId,
  ]);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  await setStock(ctx.stockItemIds[0], "100", "4.10");
  closedJournal = await createJournal("2026-01-10", "50.00");
  const note = await agent.post("/api/credit-notes").send(creditNoteBody("2026-01-12", "1"));
  expect(note.status, JSON.stringify(note.body)).toBeLessThan(300);
  closedCreditNoteId = note.body.voucherId;
  await closeBooksThrough("2026-01-31");
}, 180_000);

afterAll(async () => {
  const companies = [ctx.companyId, other.companyId];
  await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = ANY($1::int[])`, [companies]);
  await pool.query(`DELETE FROM intercompany_pos_configs WHERE source_company_id = ANY($1::int[])`, [companies]);
  await pool.query(`DELETE FROM intercompany_account_links WHERE source_company_id = ANY($1::int[])`, [companies]);
  await pool.query(
    `DELETE FROM inter_company_transfers WHERE from_company_id = ANY($1::int[]) OR to_company_id = ANY($1::int[])`,
    [companies]
  );
  await pool.query(`DELETE FROM recurring_journals WHERE company_id = ANY($1::int[])`, [companies]);
  if (contractIds.length) {
    await pool.query(`DELETE FROM property_payments WHERE contract_id = ANY($1::int[])`, [contractIds]);
    await pool.query(`DELETE FROM property_monthly_ledger WHERE contract_id = ANY($1::int[])`, [contractIds]);
    await pool.query(`DELETE FROM property_contracts WHERE id = ANY($1::int[])`, [contractIds]);
    await pool.query(`DELETE FROM property_units WHERE id = ANY($1::int[])`, [unitIds]);
  }
  await pool.query(
    `DELETE FROM credit_note_items WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ANY($1::int[]))`,
    [companies]
  );
  await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = ANY($1::int[])`, [companies]);
  await pool.query(`DELETE FROM factory_daybook_entries WHERE company_id = ANY($1::int[])`, [companies]);
  await pool.query(
    `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ANY($1::int[]))`,
    [companies]
  );
  await pool.query(`DELETE FROM vouchers WHERE company_id = ANY($1::int[])`, [companies]);
  if (employeeIds.length) await pool.query(`DELETE FROM employees WHERE id = ANY($1::int[])`, [employeeIds]);
  await pool.query(`DELETE FROM voucher_number_sequences WHERE company_id = ANY($1::int[])`, [companies]);
  await deleteAuditLogRowsForTests(pool, "company_id = ANY($1::int[])", [companies]);
  await pool.query(`DELETE FROM user_company_roles WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    other.companyId,
  ]);
  await cleanupTestData(PREFIX_B);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 180_000);

describe("the line builder", () => {
  it("rounds once to cents, drops zero lines and refuses a both-sided line", () => {
    const entries = buildErpVoucherEntries([
      { ledgerAccountId: 1, debit: "0.1" },
      { ledgerAccountId: 1, debit: "0.2" },
      { ledgerAccountId: 2, credit: new MoneyDecimal("0.1").plus("0.2") },
      { ledgerAccountId: 3, credit: 0 },
    ]);
    expect(entries.map((entry) => [entry.debitAmount, entry.creditAmount])).toEqual([
      ["0.10", "0"],
      ["0.20", "0"],
      ["0", "0.30"],
    ]);
    expect(() => buildErpVoucherEntries([{ ledgerAccountId: 1, debit: 1, credit: 1 }])).toThrow(/either a debit/);
  });
});

describe("journal and payment voucher create", () => {
  it("numbers a manual journal through the engine and replays its request id", async () => {
    const body = journalBody("2026-03-02", "12.34", { clientRequestId: `${PREFIX}-jv-${process.pid}` });
    const first = await agent.post("/api/vouchers/journal").send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    engineNumber(first.body.voucher.voucherNumber, "JV");
    await expectBalanced(first.body.voucher.id, "12.34");

    const replay = await agent.post("/api/vouchers/journal").send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.voucher.id).toBe(first.body.voucher.id);
  });

  it("posts a payment from an old client (no request id) through the engine, exactly", async () => {
    const response = await agent.post("/api/vouchers/payment-receipt").send({
      voucherType: "Payment",
      voucherDate: "2026-03-03",
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      entries: [
        { accountType: "ledger", accountId: ctx.salesAccountId, amount: "0.10" },
        { accountType: "ledger", accountId: ctx.salesAccountId, amount: "0.20" },
      ],
      notes: `${PREFIX} payment`,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    engineNumber(response.body.voucher.voucherNumber, "PV");
    await expectBalanced(response.body.voucher.id, "0.30");
    const { rows } = await pool.query(`SELECT posted_by_engine FROM vouchers WHERE id = $1`, [
      response.body.voucher.id,
    ]);
    expect(rows[0].posted_by_engine).toBe(true);
  });
});

describe("POS sale", () => {
  it("posts the sale through the engine and replays its clientSaleId", async () => {
    const clientSaleId = randomUUID();
    const body = {
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: 3, rate: "0.10" }],
      paymentAccountType: "ledger",
      paymentAccountId: ctx.cashAccountId,
      voucherDate: getCompanyBusinessDate(null),
      clientSaleId,
    };
    const first = await agent.post("/api/pos/sales").send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    engineNumber(first.body.voucherNumber, "SV");
    expect(first.body.voucher.voucherNumber).toBe(first.body.voucherNumber);
    await expectBalanced(first.body.voucher.id, "0.30");
    expect(first.body.voucher.clientSaleId).toBe(clientSaleId);

    const replay = await agent.post("/api/pos/sales").send(body);
    expect(replay.status).toBe(200);
    expect(replay.body._idempotent).toBe(true);
    expect(replay.body.voucher.id).toBe(first.body.voucher.id);
    expect(await postedFor(ctx.companyId, "pos-sale", clientSaleId)).toHaveLength(1);
  });
});

describe("rental accrual and payment", () => {
  let contractId: number;

  beforeAll(async () => {
    const { rows: unit } = await pool.query<{ id: number }>(
      `INSERT INTO property_units (company_id, module, unit_type, unit_number, location_group, active)
       VALUES ($1, 'ERP', 'SHOP', 'P22B-1', 'P22B', true) RETURNING id`,
      [ctx.companyId]
    );
    const { rows: contract } = await pool.query<{ id: number }>(
      `INSERT INTO property_contracts (company_id, module, unit_id, tenant_name, rental_amount, start_date, status, currency)
       VALUES ($1, 'ERP', $2, 'P22B Landlord', '100.10', '2026-03-01', 'ACTIVE', 'USD') RETURNING id`,
      [ctx.companyId, unit[0].id]
    );
    unitIds.push(unit[0].id);
    contractIds.push(contract[0].id);
    contractId = contract[0].id;
  });

  it("posts one accrual journal per run through the engine, exact, and not twice", async () => {
    await ensureMonthlyLedgerRows(contractId, "2026-04-15");
    const first = await postRentAccrualForCompany(
      ctx.companyId,
      "Rent Expense - ERP Shops",
      "ERP",
      "Rental Income - ERP",
      "2026-04-15"
    );
    expect(first.accrued).toBe(2);
    const accruals = await postedFor(ctx.companyId, "rental-accrual");
    expect(accruals).toHaveLength(1);
    engineNumber(accruals[0].voucher_number, "JV");
    await expectBalanced(accruals[0].id, "200.20");

    const second = await postRentAccrualForCompany(
      ctx.companyId,
      "Rent Expense - ERP Shops",
      "ERP",
      "Rental Income - ERP",
      "2026-04-15"
    );
    expect(second.accrued).toBe(0);
    expect(await postedFor(ctx.companyId, "rental-accrual")).toHaveLength(1);
  });

  it("posts a guarantee payment once per request id, with its family number", async () => {
    const body = {
      amount: "75.25",
      cashAccountId: ctx.cashAccountId,
      paymentDate: "2026-04-20",
      clientRequestId: `${PREFIX}-guar-${process.pid}`,
    };
    const first = await agent.post(`/api/erp/rental/contracts/${contractId}/guarantee-to-cash`).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const again = await agent.post(`/api/erp/rental/contracts/${contractId}/guarantee-to-cash`).send(body);
    expect(again.status).toBe(200);

    const posted = await postedFor(ctx.companyId, "rental-guarantee-cash");
    expect(posted).toHaveLength(1);
    expect(posted[0].voucher_number).toBe(`GUAR-CASH-1-${contractId}`);
    await expectBalanced(posted[0].id, "75.25");
    const { rows: payments } = await pool.query(`SELECT id FROM property_payments WHERE voucher_id = $1`, [
      posted[0].id,
    ]);
    expect(payments).toHaveLength(1);
  });
});

describe("ERP payroll", () => {
  let employeeId: number;

  beforeAll(async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO employees (company_id, code, first_name, last_name, join_date)
       VALUES ($1, $2, 'P22B', 'Worker', '2026-01-01') RETURNING id`,
      [ctx.companyId, `${PREFIX}-EMP-${process.pid}`]
    );
    employeeId = rows[0].id;
    employeeIds.push(employeeId);
  });

  it("pays a salary withdrawal through the engine and moves the balance once per request", async () => {
    const deposit = await agent
      .post("/api/payroll/deposit-employee")
      .send({ employeeId, amount: "0.30", date: "2026-03-05" });
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(200);
    engineNumber(deposit.body.voucher.voucherNumber, "JV");

    const body = {
      employeeId,
      amount: "0.10",
      paymentAccountType: "cash",
      paymentAccountId: ctx.cashAccountId,
      date: "2026-03-06",
      clientRequestId: `${PREFIX}-wd-${process.pid}`,
    };
    const paid = await agent.post("/api/payroll/withdraw-employee").send(body);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    engineNumber(paid.body.voucher.voucherNumber, "PV");
    await expectBalanced(paid.body.voucher.id, "0.10");
    const again = await agent.post("/api/payroll/withdraw-employee").send(body);
    expect(again.status).toBe(200);
    expect(again.body.voucher.id).toBe(paid.body.voucher.id);

    const { rows } = await pool.query(`SELECT current_balance::text AS balance FROM employees WHERE id = $1`, [
      employeeId,
    ]);
    // Credited 0.30 by the deposit, debited 0.10 once by the withdrawal.
    expect(new MoneyDecimal(rows[0].balance).abs().toFixed(2)).toBe("0.20");
  });
});

describe("voucher edit (with entries) and the correction policy", () => {
  it("refuses an edit of a voucher in a closed period: reverse instead", async () => {
    const response = await agent.put(`/api/vouchers/${closedJournal.id}/with-entries`).send({
      voucher: { voucherType: "Journal", voucherDate: "2026-01-10" },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "60.00", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "60.00" },
      ],
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD",
      reverseRoute: `/api/vouchers/${closedJournal.id}/reverse`,
    });
  });

  it("audits an open-period edit in its transaction", async () => {
    const journal = await createJournal("2026-03-07", "10.00");
    const response = await agent.put(`/api/vouchers/${journal.id}/with-entries`).send({
      voucher: { voucherType: "Journal", voucherDate: "2026-03-07" },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "11.11", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "11.11" },
      ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await expectBalanced(journal.id, "11.11");
    const { rows } = await pool.query(
      `SELECT changes FROM audit_log WHERE table_name = 'vouchers' AND record_id = $1 AND action = 'update'`,
      [journal.id]
    );
    expect(rows.some((row) => row.changes?.correctionPolicy?.new === "open-period-edit")).toBe(true);
  });
});

describe("credit note", () => {
  it("takes the gapless CN number and refuses an edit in a closed period", async () => {
    const { rows } = await pool.query(`SELECT voucher_number FROM vouchers WHERE id = $1`, [closedCreditNoteId]);
    engineNumber(rows[0].voucher_number, "CN");
    await expectBalanced(closedCreditNoteId, "4.10");
    const edit = await agent.patch(`/api/credit-notes/${closedCreditNoteId}`).send(creditNoteBody("2026-01-12", "2"));
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD");
  });
});

describe("recurring journal", () => {
  it("posts with an engine number and replays the same scheduled date", async () => {
    const source = await createJournal("2026-03-08", "7.07");
    const recurring = await asScheduler(() =>
      upsertRecurringJournalFromVoucher({ companyId: ctx.companyId, sourceVoucherId: source.id, userId: ctx.userId })
    );
    await pool.query(`UPDATE recurring_journals SET next_run_date = '2026-03-31' WHERE id = $1`, [recurring.id]);
    const due = { ...recurring, nextRunDate: "2026-03-31" };
    const first = await asScheduler(() => runRecurringJournal(due));
    expect(first.posted).toBe(true);
    const { rows } = await pool.query(
      `SELECT voucher_number, total_amount::text AS total FROM vouchers WHERE id = $1 AND deleted_at IS NULL`,
      [first.voucherId]
    );
    engineNumber(rows[0].voucher_number, "JV");
    await expectBalanced(first.voucherId!, "7.07");

    // The same scheduled date again posts nothing (the recurrence moved on).
    const again = await asScheduler(() => runRecurringJournal(due));
    expect(again.posted).toBe(false);
  });
});

describe("D7: intercompany POS mirror, one journal per sale", () => {
  let sourceInterco: number;
  let destInterco: number;

  beforeAll(async () => {
    sourceInterco = await ledger(ctx.companyId, "ICO", "Asset");
    destInterco = await ledger(other.companyId, "ICI", "Liability");
    await pool.query(
      `INSERT INTO intercompany_pos_configs (source_company_id, dest_company_id, source_interco_account_id,
         dest_interco_account_id, enabled) VALUES ($1, $2, $3, $4, true)`,
      [ctx.companyId, other.companyId, sourceInterco, destInterco]
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM intercompany_pos_configs WHERE source_company_id = $1`, [ctx.companyId]);
  });

  async function cashSale(date: string, amount: string) {
    return fixtureJournal(ctx.companyId, date, [
      { accountId: ctx.cashAccountId, debit: amount },
      { accountId: ctx.salesAccountId, credit: amount },
    ]).then(async (id) => {
      await pool.query(`UPDATE vouchers SET voucher_type = 'Sales' WHERE id = $1`, [id]);
      return id;
    });
  }

  it("skips the destination side without a configured cash account link (no name lookup)", async () => {
    const sale = await cashSale("2026-03-09", "5.00");
    expect(await runIntercompanyPosTransfer(ctx.companyId, ctx.cashAccountId, "5.00", "2026-03-09", sale)).toBe(true);
    expect(await postedFor(ctx.companyId, "intercompany-pos-src", `${sale}:%`)).toHaveLength(1);
    expect(await postedFor(other.companyId, "intercompany-pos-dst", `${ctx.companyId}:${sale}:%`)).toHaveLength(0);
  });

  it("posts one journal per sale in each company, by configured accounts, and not twice", async () => {
    await pool.query(
      `INSERT INTO intercompany_account_links (label, source_company_id, source_ledger_account_id, dest_company_id,
         dest_ledger_account_id, active) VALUES ('p22b cash', $1, $2, $3, $4, true)`,
      [ctx.companyId, ctx.cashAccountId, other.companyId, other.cashAccountId]
    );
    const sale = await cashSale("2026-03-10", "12.50");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await runIntercompanyPosTransfer(ctx.companyId, ctx.cashAccountId, "12.50", "2026-03-10", sale)).toBe(
        true
      );
    }
    const src = await postedFor(ctx.companyId, "intercompany-pos-src", `${sale}:%`);
    const dst = await postedFor(other.companyId, "intercompany-pos-dst", `${ctx.companyId}:${sale}:%`);
    expect(src).toHaveLength(1);
    expect(dst).toHaveLength(1);
    engineNumber(src[0].voucher_number, "JV");
    engineNumber(dst[0].voucher_number, "JV", other.companyId);
    const dstLines = await linesOf(dst[0].id);
    expect(dstLines).toEqual([
      expect.objectContaining({ ledger_account_id: other.cashAccountId, debit: "12.50" }),
      expect.objectContaining({ ledger_account_id: destInterco, credit: "12.50" }),
    ]);

    // A rebuild of the date retires and re-posts one journal per sale.
    const second = await cashSale("2026-03-10", "7.25");
    expect(await recalculateIntercompanyForDate(ctx.companyId, "2026-03-10")).toBe(true);
    const rebuilt = await postedFor(other.companyId, "intercompany-pos-dst", `${ctx.companyId}:%`);
    const forDate = rebuilt.filter((row) => row.voucher_date === "2026-03-10");
    expect(forDate.map((row) => row.total_amount).sort()).toEqual(["12.50", "7.25"]);
    expect(await postedFor(ctx.companyId, "intercompany-pos-src", `${second}:%`)).toHaveLength(1);
  });
});

describe("D6: Golden Coast owner withdrawal is a template the user confirms", () => {
  let gcSalesCash: number;
  let ownerEquity: number;

  beforeAll(async () => {
    gcSalesCash = await ledger(ctx.companyId, "GCSC", "Liability", "sp_payable");
    ownerEquity = await ledger(ctx.companyId, "OWNEQ", "Equity", "gc_owner_capital");
  });

  const withdrawal = (extra: Record<string, unknown> = {}) => ({
    voucherDate: "2026-03-11",
    currency: "USD",
    notes: `${PREFIX} owner withdrawal`,
    entries: [
      { accountType: "ledger", accountId: ownerEquity, type: "DR", amount: "40.00" },
      { accountType: "ledger", accountId: gcSalesCash, type: "CR", amount: "40.00" },
    ],
    ...extra,
  });

  it("refuses to rewrite silently: the template is proposed for confirmation", async () => {
    const response = await agent.post("/api/vouchers/journal").send(withdrawal());
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("GC_OWNER_WITHDRAWAL_TEMPLATE_CONFIRM");
    expect(response.body.template).toEqual([
      { type: "DR", accountId: ownerEquity, amount: "40.00" },
      { type: "DR", accountId: gcSalesCash, amount: "40.00" },
      { type: "CR", accountCode: "GC-OWCLR", amount: "80.00" },
    ]);
  });

  it("posts the template when confirmed and the journal as entered when declined", async () => {
    const confirmed = await agent
      .post("/api/vouchers/journal")
      .send(withdrawal({ goldenCoastOwnerWithdrawalTemplate: true }));
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const templateLines = await linesOf(confirmed.body.voucher.id);
    expect(templateLines).toHaveLength(3);
    await expectBalanced(confirmed.body.voucher.id, "80.00");

    const declined = await agent
      .post("/api/vouchers/journal")
      .send(withdrawal({ goldenCoastOwnerWithdrawalTemplate: false }));
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(await linesOf(declined.body.voucher.id)).toEqual([
      expect.objectContaining({ ledger_account_id: ownerEquity, debit: "40.00" }),
      expect.objectContaining({ ledger_account_id: gcSalesCash, credit: "40.00" }),
    ]);
  });
});

describe("D8: counterpart rescale", () => {
  it("rescales in Decimal with the remainder on the last line", () => {
    const lines = ["33.33", "33.33", "33.34"].map((value) => new MoneyDecimal(value));
    const ratio = new MoneyDecimal("110").dividedBy("100");
    expect(
      rescaleWithRemainderOnLast(lines, ratio, new MoneyDecimal("110.00")).map((value) => value.toFixed(2))
    ).toEqual(["36.66", "36.66", "36.68"]);
  });

  it("rescales the other company's voucher and moves the transfer link with the edit", async () => {
    const own = await createJournal("2026-03-12", "100.00");
    const counterpart = await fixtureJournal(other.companyId, "2026-03-12", [
      { accountId: other.cashAccountId, debit: "100.00" },
      { accountId: other.salesAccountId, credit: "33.33" },
      { accountId: other.salesAccountId, credit: "33.33" },
      { accountId: other.salesAccountId, credit: "33.34" },
    ]);
    const { rows: link } = await pool.query<{ id: number }>(
      `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
         from_ledger_account_id, to_ledger_account_id, from_voucher_id, to_voucher_id, description)
       VALUES ('Cash', $1, $2, '2026-03-12', 100, $3, $4, $5, $6, 'p22b transfer') RETURNING id`,
      [ctx.companyId, other.companyId, ctx.cashAccountId, other.cashAccountId, own.id, counterpart]
    );

    const edit = await agent.patch(`/api/vouchers/${own.id}/journal`).send(journalBody("2026-03-14", "110.00"));
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);

    expect((await linesOf(counterpart)).map((line) => [line.debit, line.credit])).toEqual([
      ["110.00", "0.00"],
      ["0.00", "36.66"],
      ["0.00", "36.66"],
      ["0.00", "36.68"],
    ]);
    const { rows: transfer } = await pool.query(
      `SELECT amount::text AS amount, transfer_date::text AS transfer_date FROM inter_company_transfers WHERE id = $1`,
      [link[0].id]
    );
    expect(transfer[0]).toEqual({ amount: "110.00", transfer_date: "2026-03-14" });
  });
});

describe("the posting helper", () => {
  it("replays a source identity and refuses an unbalanced voucher", async () => {
    const post = () =>
      runInCompanyPostingScope(ctx.companyId, () =>
        db.transaction((tx) =>
          postErpVoucherTx(tx, {
            companyId: ctx.companyId,
            voucherType: "Receipt",
            voucherDate: "2026-03-15",
            lines: [
              { ledgerAccountId: ctx.cashAccountId, debit: "1.01" },
              { ledgerAccountId: ctx.salesAccountId, credit: "1.01" },
            ],
            source: { type: "ph22b-test", id: process.pid },
          })
        )
      );
    const first = await post();
    const replay = await post();
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.voucher.id).toBe(first.voucher.id);
    engineNumber(first.voucher.voucherNumber, "RV");

    await expect(
      runInCompanyPostingScope(ctx.companyId, () =>
        db.transaction((tx) =>
          postErpVoucherTx(tx, {
            companyId: ctx.companyId,
            voucherType: "Receipt",
            voucherDate: "2026-03-15",
            lines: [
              { ledgerAccountId: ctx.cashAccountId, debit: "1.01" },
              { ledgerAccountId: ctx.salesAccountId, credit: "1.00" },
            ],
            source: { type: "ph22b-test-unbalanced", id: process.pid },
          })
        )
      )
    ).rejects.toThrow(/not balanced/);
  });
});
