/**
 * Phase 22 (A) — the posting engine core:
 *   PE8/G9: gapless voucher numbers per company / type / year (counter locked
 *           in the caller's transaction; rollback releases the number; legacy
 *           numbers skipped; seeded from existing numbers in the new format);
 *   D3/M10: the engine posts the base remainder of per-line conversion to the
 *           ROUNDING account; the balance guard checks every new voucher
 *           exactly (history keeps its one-cent tolerance);
 *   PE9/G10: correction policy — edits refused in a closed period with 409
 *           VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD, audited in an open one,
 *           posted -> optional the same, and POST /api/vouchers/:id/reverse.
 */
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { postBalancedVoucherTx } from "../server/services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../server/services/accounting/databasePostingDependencies";
import {
  ENGINE_ROUNDING_NARRATION,
  predictedLedgerTotals,
  rebalanceVoucherRoundingTx,
} from "../server/services/accounting/engineRounding";
import {
  ensureVoucherBalanceGuard,
  installedVoucherBalanceGuardVersion,
  VOUCHER_BALANCE_GUARD_TRIGGERS,
} from "../server/services/accounting/voucherBalanceGuard";
import { runInCompanyPostingScope } from "../server/services/accounting/scheduledPostingScope";
import {
  allocateVoucherNumberTx,
  formatVoucherNumber,
  voucherTypePrefix,
} from "../server/services/accounting/voucherNumbering";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "ph22anum";
const dependencies = createDatabasePostingDependencies();
let ctx: TestContext;
let agent: request.SuperAgentTest;
let otherCompanyId: number;
let sequence = 0;
let guardWasInstalled = false;

const allocate = (companyId: number, voucherType: string, voucherDate: string) =>
  runInCompanyPostingScope(companyId, () =>
    db.transaction((tx) => allocateVoucherNumberTx(tx, { companyId, voucherType, voucherDate }))
  );

async function setRole(role: string) {
  await pool.query(`UPDATE user_company_roles SET role = $3 WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
    role,
  ]);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}

function cfaLine(accountId: number, side: "debit" | "credit", cfa: string, base: string) {
  return {
    ledgerAccountId: accountId,
    debitAmount: side === "debit" ? base : "0",
    creditAmount: side === "credit" ? base : "0",
    transactionCurrency: "CFA",
    transactionDebitAmount: side === "debit" ? cfa : "0.000000",
    transactionCreditAmount: side === "credit" ? cfa : "0.000000",
    baseDebitAmount: side === "debit" ? base : "0.000000",
    baseCreditAmount: side === "credit" ? base : "0.000000",
    historicalExchangeRate: "600.0000000000",
    rateConvention: "TRANSACTION_PER_BASE",
    narration: "ph22a line",
  };
}

/** 1000 CFA against 333.33 + 333.33 + 333.34 at 600: bases balance at 6 dp, the 2 dp lines are 1.67 vs 1.68. */
function splitCfaEntries() {
  return [
    cfaLine(ctx.cashAccountId, "debit", "1000.000000", "1.666667"),
    cfaLine(ctx.salesAccountId, "credit", "333.330000", "0.555550"),
    cfaLine(ctx.salesAccountId, "credit", "333.330000", "0.555550"),
    cfaLine(ctx.salesAccountId, "credit", "333.340000", "0.555567"),
  ];
}

async function postEngineCfaVoucher(voucherDate = "2026-04-02") {
  sequence += 1;
  return runInCompanyPostingScope(ctx.companyId, () =>
    db.transaction((tx) =>
      postBalancedVoucherTx(
        tx,
        {
          voucher: {
            companyId: ctx.companyId,
            voucherType: "Journal",
            voucherDate,
            totalAmount: "1.666667",
            currency: "CFA",
            exchangeRate: "600",
            description: "ph22a rounding",
          },
          entries: splitCfaEntries(),
          source: { sourceType: "ph22a-test", sourceId: String(sequence), idempotencyKey: `ph22a:${sequence}` },
        },
        dependencies
      )
    )
  );
}

const linesOf = async (voucherId: number) =>
  (
    await pool.query(
      `SELECT la.code, ve.debit_amount::text AS debit, ve.credit_amount::text AS credit, ve.narration
         FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE ve.voucher_id = $1 ORDER BY ve.id`,
      [voucherId]
    )
  ).rows;

const journalBody = (voucherDate: string, amount: string) => ({
  voucherDate,
  currency: "USD",
  notes: "ph22a journal",
  entries: [
    { accountType: "ledger", accountId: ctx.cashAccountId, type: "DR", amount },
    { accountType: "ledger", accountId: ctx.salesAccountId, type: "CR", amount },
  ],
});

async function createJournal(voucherDate: string, amount = "100"): Promise<{ id: number; voucherNumber: string }> {
  const response = await agent.post("/api/vouchers/journal").send(journalBody(voucherDate, amount));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return { id: response.body.voucher.id, voucherNumber: response.body.voucher.voucherNumber };
}

const auditRows = async (voucherId: number, action: string) =>
  (
    await pool.query(
      `SELECT action, changes, reason FROM audit_log
        WHERE table_name = 'vouchers' AND record_id = $1 AND action = $2 ORDER BY id`,
      [voucherId, action]
    )
  ).rows;

beforeAll(async () => {
  // The balance guard is installed at boot; another suite may have dropped it.
  guardWasInstalled = (await installedVoucherBalanceGuardVersion(pool)) !== null;
  await ensureVoucherBalanceGuard(pool);
  ctx = await seedTestData(PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  await setRole("Owner");
  const other = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type) VALUES ($1, $2, 'erp') RETURNING id`,
    [`PH22A-OTHER-${process.pid}`, "ph22a other company"]
  );
  otherCompanyId = other.rows[0].id;
}, 120_000);

afterAll(async () => {
  await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [ctx.companyId]);
  await deleteAuditLogRowsForTests(pool, "company_id = ANY($1::int[])", [[ctx.companyId, otherCompanyId]]);
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [otherCompanyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [otherCompanyId]);
  await cleanupTestData(PREFIX);
  if (!guardWasInstalled) {
    for (const [table, trigger] of VOUCHER_BALANCE_GUARD_TRIGGERS) {
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`);
    }
  }
  closeTestServer();
}, 120_000);

describe("PE8/G9: gapless voucher numbers", () => {
  it("formats TYPE-company-YYYY-NNNNNN with a code per voucher type", () => {
    expect(voucherTypePrefix("Journal")).toBe("JV");
    expect(voucherTypePrefix("Payment")).toBe("PV");
    expect(voucherTypePrefix("receipt")).toBe("RV");
    expect(voucherTypePrefix("Stock Transfer")).toBe("ST");
    expect(voucherTypePrefix("Rent Accrual!")).toBe("RENTACCRUAL");
    expect(voucherTypePrefix("")).toBe("VCH");
    expect(formatVoucherNumber("JV", 12, 2026, 1)).toBe("JV-12-2026-000001");
    expect(formatVoucherNumber("JV", 12, 2026, 1234567)).toBe("JV-12-2026-1234567");
  });

  it("numbers per company, voucher type and year of the voucher date", async () => {
    const c = ctx.companyId;
    expect(await allocate(c, "Journal", "2026-01-05")).toBe(`JV-${c}-2026-000001`);
    expect(await allocate(c, "Journal", "2026-12-31")).toBe(`JV-${c}-2026-000002`);
    expect(await allocate(c, "Payment", "2026-03-01")).toBe(`PV-${c}-2026-000001`);
    expect(await allocate(c, "Journal", "2025-06-30")).toBe(`JV-${c}-2025-000001`);
    expect(await allocate(otherCompanyId, "Journal", "2026-01-05")).toBe(`JV-${otherCompanyId}-2026-000001`);
  });

  it("releases the number when the transaction rolls back", async () => {
    const c = ctx.companyId;
    await expect(
      runInCompanyPostingScope(c, () =>
        db.transaction(async (tx) => {
          expect(
            await allocateVoucherNumberTx(tx, { companyId: c, voucherType: "Receipt", voucherDate: "2026-02-02" })
          ).toBe(`RV-${c}-2026-000001`);
          throw new Error("rollback");
        })
      )
    ).rejects.toThrow("rollback");
    expect(await allocate(c, "Receipt", "2026-02-02")).toBe(`RV-${c}-2026-000001`);
  });

  it("stays gapless under concurrency, with rollbacks", async () => {
    const c = ctx.companyId;
    const attempts = Array.from({ length: 8 }, (_, index) =>
      runInCompanyPostingScope(c, () =>
        db.transaction(async (tx) => {
          const number = await allocateVoucherNumberTx(tx, {
            companyId: c,
            voucherType: "Contra",
            voucherDate: "2026-05-05",
          });
          await tx.execute(sql`SELECT pg_sleep(0.02)`);
          if (index % 3 === 0) throw new Error("rollback");
          return number;
        })
      ).then(
        (number) => ({ number }),
        () => ({ number: null })
      )
    );
    const committed = (await Promise.all(attempts)).map((result) => result.number).filter(Boolean) as string[];
    expect(committed).toHaveLength(5);
    const sequences = committed.map((number) => Number(number.split("-").pop())).sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
    const counter = await pool.query(
      `SELECT last_value::int AS last FROM voucher_number_sequences WHERE company_id = $1 AND prefix = 'CV' AND year = 2026`,
      [c]
    );
    expect(counter.rows[0].last).toBe(5);
  });

  it("skips a number another voucher already holds and seeds from existing numbers in the format", async () => {
    const c = ctx.companyId;
    // A legacy voucher (another company: the unique constraint is global) holds the next candidate.
    await pool.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
       VALUES ($1, $2, 'Journal', '2026-01-01', 0, 'USD')`,
      [otherCompanyId, `JV-${c}-2026-000003`]
    );
    expect(await allocate(c, "Journal", "2026-07-07")).toBe(`JV-${c}-2026-000004`);
    // A number already in the format seeds a new counter; other formats are ignored.
    await pool.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
       VALUES ($1, $2, 'Debit Note', '2027-01-01', 0, 'USD'), ($1, $3, 'Debit Note', '2027-01-01', 0, 'USD')`,
      [c, `DN-${c}-2027-000041`, `DN-${c}-2027-LEGACY-99`]
    );
    expect(await allocate(c, "Debit Note", "2027-02-01")).toBe(`DN-${c}-2027-000042`);
  });

  it("is allocated by the engine when no number is passed", async () => {
    const posted = await postEngineCfaVoucher("2028-03-03");
    expect(posted.voucher.voucherNumber).toBe(`JV-${ctx.companyId}-2028-000001`);
    const row = await pool.query(`SELECT posted_by_engine FROM vouchers WHERE id = $1`, [posted.voucher.id]);
    expect(row.rows[0].posted_by_engine).toBe(true);
  });
});

describe("D3/M10: ROUNDING line and exact balance guard", () => {
  it("predicts the stored 2 dp lines and posts the remainder to ROUNDING", async () => {
    const predicted = predictedLedgerTotals({ currency: "CFA", exchangeRate: "600" }, splitCfaEntries());
    expect(predicted.debit.toFixed(2)).toBe("1.67");
    expect(predicted.credit.toFixed(2)).toBe("1.68");

    const posted = await postEngineCfaVoucher();
    const lines = await linesOf(posted.voucher.id);
    expect(lines.at(-1)).toEqual({
      code: "ROUNDING",
      debit: "0.01",
      credit: "0.00",
      narration: ENGINE_ROUNDING_NARRATION,
    });
    const sums = await pool.query(
      `SELECT SUM(debit_amount)::text AS debit, SUM(credit_amount)::text AS credit FROM voucher_entries WHERE voucher_id = $1`,
      [posted.voucher.id]
    );
    expect(sums.rows[0]).toEqual({ debit: "1.68", credit: "1.68" });
    const header = await pool.query(`SELECT total_amount::text AS total FROM vouchers WHERE id = $1`, [
      posted.voucher.id,
    ]);
    expect(header.rows[0].total).toBe("1.68");
  });

  it("refuses a new voucher a cent out (engine or not) and keeps the engine marker", async () => {
    const posted = await postEngineCfaVoucher();
    await expect(
      withFixtureTransaction(async (client) => {
        await client.query(`DELETE FROM voucher_entries WHERE voucher_id = $1 AND narration = $2`, [
          posted.voucher.id,
          ENGINE_ROUNDING_NARRATION,
        ]);
      })
    ).rejects.toThrow(/does not balance/);

    // The same lines written directly (not by the engine): no tolerance either (v5 allowed a cent).
    await expect(
      withFixtureTransaction(async (client) => {
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate)
           VALUES ($1, $2, 'Journal', '2026-04-03', 1.67, 'CFA', 600) RETURNING id`,
          [ctx.companyId, `${PREFIX}-LEGACY-${sequence++}`]
        );
        for (const line of splitCfaEntries()) {
          await client.query(
            `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, transaction_currency,
               transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount,
               historical_exchange_rate, rate_convention)
             VALUES ($1, $2, $3, $4, 'CFA', $5, $6, $7, $8, 600, 'TRANSACTION_PER_BASE')`,
            [
              rows[0].id,
              line.ledgerAccountId,
              line.debitAmount,
              line.creditAmount,
              line.transactionDebitAmount,
              line.transactionCreditAmount,
              line.baseDebitAmount,
              line.baseCreditAmount,
            ]
          );
        }
      })
    ).rejects.toThrow(/does not balance/);

    await expect(
      pool.query(`UPDATE vouchers SET posted_by_engine = false WHERE id = $1`, [posted.voucher.id])
    ).rejects.toThrow(/marker cannot be cleared/);
  });

  it("re-derives the ROUNDING line after an in-place line replacement", async () => {
    const posted = await postEngineCfaVoucher();
    const remainder = await runInCompanyPostingScope(ctx.companyId, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`DELETE FROM voucher_entries WHERE voucher_id = ${posted.voucher.id}`);
        for (const line of [
          cfaLine(ctx.cashAccountId, "debit", "1000.000000", "1.666667"),
          cfaLine(ctx.salesAccountId, "credit", "500.000000", "0.833333"),
          cfaLine(ctx.salesAccountId, "credit", "500.000000", "0.833333"),
        ]) {
          await tx.execute(sql`
            INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, transaction_currency,
              transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount,
              historical_exchange_rate, rate_convention, narration)
            VALUES (${posted.voucher.id}, ${line.ledgerAccountId}, ${line.debitAmount}, ${line.creditAmount}, 'CFA',
              ${line.transactionDebitAmount}, ${line.transactionCreditAmount}, ${line.baseDebitAmount},
              ${line.baseCreditAmount}, 600, 'TRANSACTION_PER_BASE', 'replaced')
          `);
        }
        return rebalanceVoucherRoundingTx(tx, { companyId: ctx.companyId, voucherId: posted.voucher.id });
      })
    );
    // 1.67 debit against 0.83 + 0.83: the ROUNDING line now credits 0.01.
    expect(remainder).toBe("0.01");
    expect((await linesOf(posted.voucher.id)).filter((line) => line.code === "ROUNDING")).toEqual([
      { code: "ROUNDING", debit: "0.00", credit: "0.01", narration: ENGINE_ROUNDING_NARRATION },
    ]);
  });

  it("posts a split CFA manual journal (6 dp conversion noise and 2 dp remainder) through the route", async () => {
    const response = await agent.post("/api/vouchers/journal").send({
      voucherDate: "2026-04-05",
      currency: "CFA",
      exchangeRate: "655.957",
      notes: "ph22a cfa journal",
      entries: [
        { accountType: "ledger", accountId: ctx.cashAccountId, type: "DR", amount: "1001" },
        { accountType: "ledger", accountId: ctx.salesAccountId, type: "CR", amount: "1" },
        { accountType: "ledger", accountId: ctx.salesAccountId, type: "CR", amount: "1" },
        { accountType: "ledger", accountId: ctx.salesAccountId, type: "CR", amount: "999" },
      ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const lines = await linesOf(response.body.voucher.id);
    expect(lines.at(-1)).toMatchObject({ code: "ROUNDING", debit: "0.00", credit: "0.01" });
    const sums = await pool.query(
      `SELECT SUM(debit_amount)::text AS debit, SUM(credit_amount)::text AS credit FROM voucher_entries WHERE voucher_id = $1`,
      [response.body.voucher.id]
    );
    expect(sums.rows[0]).toEqual({ debit: "1.53", credit: "1.53" });
  });

  it("refuses a remainder larger than per-line rounding", async () => {
    await expect(
      runInCompanyPostingScope(ctx.companyId, () =>
        db.transaction((tx) =>
          postBalancedVoucherTx(
            tx,
            {
              voucher: {
                companyId: ctx.companyId,
                voucherType: "Journal",
                voucherDate: "2026-04-04",
                totalAmount: "1.666667",
                currency: "CFA",
                exchangeRate: "600",
              },
              entries: [
                cfaLine(ctx.cashAccountId, "debit", "1000.000000", "1.666667"),
                cfaLine(ctx.salesAccountId, "credit", "999.000000", "1.665000"),
              ],
              source: { sourceType: "ph22a-test", sourceId: "big", idempotencyKey: "ph22a:big" },
            },
            dependencies
          )
        )
      )
    ).rejects.toMatchObject({ code: "POSTING_UNBALANCED" });
  });
});

describe("PE9/G10: corrections", () => {
  let closedJournal: { id: number; voucherNumber: string };

  beforeAll(async () => {
    closedJournal = await createJournal("2026-01-15");
    const closing = await withFixtureTransaction(async (client) => {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
         VALUES ($1, $2, 'Journal', '2026-01-31', 1, 'USD') RETURNING id`,
        [ctx.companyId, `${PREFIX}-CLOSE`]
      );
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, 1, 0), ($1, $3, 0, 1)`,
        [rows[0].id, ctx.cashAccountId, ctx.salesAccountId]
      );
      return rows[0].id;
    });
    await pool.query(
      `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
         closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
       VALUES ($1, '2026-01-01', '2026-01-31', $2, $3, $4, 0, 0, 0, 'CLOSED')`,
      [ctx.companyId, ctx.userId, closing, ctx.cashAccountId]
    );
  });

  it("refuses an edit in a closed period with VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD", async () => {
    const edit = await agent.patch(`/api/vouchers/${closedJournal.id}/journal`).send(journalBody("2026-01-15", "90"));
    expect(edit.status).toBe(409);
    expect(edit.body).toMatchObject({
      code: "VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD",
      closedThrough: "2026-01-31",
      reverseRoute: `/api/vouchers/${closedJournal.id}/reverse`,
    });

    const open = await createJournal("2026-03-10");
    const intoClosed = await agent.patch(`/api/vouchers/${open.id}/journal`).send(journalBody("2026-01-20", "100"));
    expect(intoClosed.status).toBe(409);
    expect(intoClosed.body.code).toBe("VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD");
  });

  it("refuses posted -> optional in a closed period and audits it in an open one", async () => {
    const closed = await agent.patch(`/api/vouchers/${closedJournal.id}/optional`).send({ optional: true });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe("VOUCHER_CLOSED_PERIOD_REVERSE_INSTEAD");

    const open = await createJournal("2026-03-11");
    const suspended = await agent.patch(`/api/vouchers/${open.id}/optional`).send({ optional: true });
    expect(suspended.status).toBe(200);
    const [audit] = await auditRows(open.id, "update");
    expect(audit.changes.optional).toEqual({ old: false, new: true });
    expect(audit.changes.correctionPolicy).toEqual({ new: "open-period-edit" });
    expect(audit.changes.voucher.old.optional).toBe(false);
    expect(audit.changes.voucher.new.optional).toBe(true);
  });

  it("audits an open-period edit with the full before/after", async () => {
    const open = await createJournal("2026-03-12");
    const edit = await agent.patch(`/api/vouchers/${open.id}/journal`).send(journalBody("2026-03-12", "75"));
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const [audit] = await auditRows(open.id, "update");
    expect(audit.reason).toBe("Manual journal update");
    expect(audit.changes.correctionPolicy).toEqual({ new: "open-period-edit" });
    expect(audit.changes.entryRows.old.map((row: { debitAmount: string }) => row.debitAmount)).toContain("100.00");
    expect(audit.changes.entryRows.new.map((row: { debitAmount: string }) => row.debitAmount)).toContain("75.00");
  });

  it("reverses through the engine, linked and audited, and refuses a second reversal and a reversal of it", async () => {
    expect((await agent.post(`/api/vouchers/${closedJournal.id}/reverse`).send({ reason: " " })).body.code).toBe(
      "VOUCHER_REVERSAL_REASON_REQUIRED"
    );
    const closedDate = await agent
      .post(`/api/vouchers/${closedJournal.id}/reverse`)
      .send({ reason: "wrong account", reversalDate: "2026-01-20" });
    expect(closedDate.status).toBe(409);
    expect(closedDate.body.code).toBe("VOUCHER_REVERSAL_DATE_CLOSED");

    await setRole("Manager");
    try {
      expect(
        (
          await agent
            .post(`/api/vouchers/${closedJournal.id}/reverse`)
            .send({ reason: "x", reversalDate: "2026-03-01" })
        ).status
      ).toBe(403);
    } finally {
      await setRole("Owner");
    }

    const reversed = await agent
      .post(`/api/vouchers/${closedJournal.id}/reverse`)
      .send({ reason: "wrong account", reversalDate: "2026-03-01" });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(201);
    const reversalId = reversed.body.reversal.id;
    expect(reversed.body.reversal.voucherNumber.startsWith(`JV-${ctx.companyId}-2026-`)).toBe(true);
    const link = await pool.query(
      `SELECT reversal_of_voucher_id, voucher_date::text AS date, posted_by_engine FROM vouchers WHERE id = $1`,
      [reversalId]
    );
    expect(link.rows[0]).toEqual({
      reversal_of_voucher_id: closedJournal.id,
      date: "2026-03-01",
      posted_by_engine: true,
    });
    const original = await linesOf(closedJournal.id);
    const mirror = await linesOf(reversalId);
    expect(mirror.map((line) => [line.code, line.debit, line.credit])).toEqual(
      original.map((line) => [line.code, line.credit, line.debit])
    );
    const [audit] = await auditRows(closedJournal.id, "reverse");
    expect(audit.reason).toBe("wrong account");
    expect(audit.changes.reversal.new.voucherId).toBe(reversalId);

    const again = await agent
      .post(`/api/vouchers/${closedJournal.id}/reverse`)
      .send({ reason: "twice", reversalDate: "2026-03-01" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: "VOUCHER_ALREADY_REVERSED", reversalVoucherId: reversalId });

    const chain = await agent
      .post(`/api/vouchers/${reversalId}/reverse`)
      .send({ reason: "chain", reversalDate: "2026-03-02" });
    expect(chain.status).toBe(409);
    expect(chain.body.code).toBe("VOUCHER_REVERSAL_CHAIN_FORBIDDEN");
  });

  it("does not edit a reversed voucher in place", async () => {
    const open = await createJournal("2026-03-13");
    expect(
      (await agent.post(`/api/vouchers/${open.id}/reverse`).send({ reason: "duplicate", reversalDate: "2026-03-14" }))
        .status
    ).toBe(201);
    const edit = await agent.patch(`/api/vouchers/${open.id}/journal`).send(journalBody("2026-03-13", "50"));
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("VOUCHER_REVERSED_LOCKED");
  });
});
