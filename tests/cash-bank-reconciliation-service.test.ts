/**
 * Cash & bank reconciliation (metadata only: it never posts a journal).
 * Each case seeds a disposable company inside a drizzle transaction that is
 * rolled back, then drives the service the routes call: listing the accounts
 * that can be reconciled, importing a statement, reading it against the book,
 * matching and unmatching lines to voucher entries, and reviewing lines.
 */
import { sql } from "drizzle-orm";
import { db, type DbTransaction } from "../server/db";
import { resultRows } from "../server/lib/queryResult";
import {
  CashBankError,
  cashBankStatementDetailTx,
  importCashBankStatementTx,
  listCashBankAccountsTx,
  listCashBankStatementsTx,
  loadCashBankAccountTx,
  matchCashBankLineTx,
  reviewCashBankLineTx,
  voidCashBankMatchTx,
} from "../server/services/accounting/cashBankReconciliationService";
import type { ParsedStatementLine } from "../server/services/accounting/cashBankStatementParser";

const ROLLBACK = new Error("rollback");
const actor = { userId: "1", username: "tester" };
let seq = 0;

async function inRolledBackTx(run: (tx: DbTransaction) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await run(tx);
      throw ROLLBACK;
    })
    .catch((error) => {
      if (error !== ROLLBACK) throw error;
    });
}

async function insert(tx: DbTransaction, query: ReturnType<typeof sql>): Promise<number> {
  return Number(resultRows<{ id: number } & Record<string, unknown>>(await tx.execute(query))[0].id);
}

type World = {
  companyId: number;
  bankId: number;
  bankLedgerId: number;
  cashId: number;
  customerLedgerId: number;
  expenseId: number;
  voucher(
    date: string,
    entries: Array<{ bank?: number; ledger?: number; debit: number; credit: number; currency?: string }>,
    extra?: { voucherCurrency?: string; optional?: boolean }
  ): Promise<number[]>;
};

async function world(tx: DbTransaction): Promise<World> {
  const code = `CB${process.pid}${++seq}`;
  const companyId = await insert(tx, sql`INSERT INTO companies(code,name) VALUES(${code},${code}) RETURNING id`);
  const ledger = (name: string, type: string) =>
    insert(
      tx,
      sql`INSERT INTO ledger_accounts(company_id,code,name,account_type) VALUES(${companyId},${`${code}-${++seq}`},${name},${type}) RETURNING id`
    );
  const bankLedgerId = await ledger("Bank ledger", "Bank");
  const cashId = await ledger("Petty cash", "Cash");
  const customerLedgerId = await ledger("Customer cash", "Cash");
  const expenseId = await ledger("Rent", "Expense");
  await tx.execute(
    sql`INSERT INTO customers(company_id,code,legal_name,ledger_account_id) VALUES(${companyId},${`${code}-C`},'Client',${customerLedgerId})`
  );
  const bankId = await insert(
    tx,
    sql`INSERT INTO bank_accounts(company_id,code,name,bank_name,account_number,linked_ledger_id,opening_balance,opening_balance_side)
        VALUES(${companyId},${`${code}-B`},'Main bank','Bank','001',${bankLedgerId},100,'Dr') RETURNING id`
  );
  return {
    companyId,
    bankId,
    bankLedgerId,
    cashId,
    customerLedgerId,
    expenseId,
    async voucher(date, entries, extra = {}) {
      const voucherId = await insert(
        tx,
        sql`INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,total_amount,currency,optional)
            VALUES(${companyId},${`V-${++seq}`},'Journal',${date}::date,0,${extra.voucherCurrency ?? "USD"},${extra.optional ?? false}) RETURNING id`
      );
      const ids: number[] = [];
      for (const e of entries) {
        ids.push(
          await insert(
            tx,
            sql`INSERT INTO voucher_entries(voucher_id,company_id,bank_account_id,ledger_account_id,debit_amount,credit_amount,
                  base_debit_amount,base_credit_amount,transaction_currency,transaction_debit_amount,transaction_credit_amount,
                  historical_exchange_rate,rate_convention)
                VALUES(${voucherId},${companyId},${e.bank ?? null},${e.ledger ?? null},${e.debit},${e.credit},${e.debit},${e.credit},
                  ${e.currency ?? null},${e.currency ? e.debit : null},${e.currency ? e.credit : null},
                  ${e.currency ? 1 : null},${e.currency ? "BASE_PER_TRANSACTION" : null}) RETURNING id`
          )
        );
      }
      return ids;
    },
  };
}

const line = (
  rowNumber: number,
  transactionDate: string,
  signedAmount: string,
  reference: string | null = null
): ParsedStatementLine => ({
  rowNumber,
  transactionDate,
  signedAmount,
  reference,
  description: null,
  runningBalance: null,
});

function importInput(w: World, overrides: Record<string, unknown> = {}) {
  return {
    companyId: w.companyId,
    accountKind: "bank" as const,
    accountId: w.bankId,
    currency: "usd",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    openingBalance: "100",
    closingBalance: "130",
    fileName: "march.csv",
    fileBytes: Buffer.from("march"),
    lines: [line(1, "2026-03-05", "50.000000", "DEP"), line(2, "2026-03-10", "-20.000000", "FEE")],
    actor,
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "CashBankError", code });
}

describe("cash & bank accounts", () => {
  it("lists bank masters and standalone cash ledgers, but not linked or customer ledgers", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);

      const accounts = await listCashBankAccountsTx(tx, w.companyId);

      expect(accounts).toEqual([
        { accountKind: "bank", accountId: w.bankId, name: "Main bank" },
        { accountKind: "ledger", accountId: w.cashId, name: "Petty cash" },
      ]);
    });
  });

  it("loads a bank with its linked ledger, and refuses ledgers that are not independent cash accounts", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const load = (accountKind: "bank" | "ledger", accountId: number) =>
        loadCashBankAccountTx(tx, { companyId: w.companyId, accountKind, accountId });

      expect(await load("bank", w.bankId)).toMatchObject({ name: "Main bank", linkedLedgerId: w.bankLedgerId });
      expect(await load("ledger", w.cashId)).toMatchObject({ name: "Petty cash", linkedLedgerId: null });
      await expectCode(load("ledger", w.expenseId), "CASH_BANK_ACCOUNT_TYPE");
      await expectCode(load("ledger", w.customerLedgerId), "CASH_BANK_CUSTOMER_LEDGER");
      await expectCode(load("ledger", w.bankLedgerId), "CASH_BANK_LEDGER_LINKED");
      await expectCode(load("bank", 999_999_999), "CASH_BANK_ACCOUNT_MISSING");
      await expectCode(load("ledger" as never, 0), "CASH_BANK_ID_INVALID");
      await expectCode(load("safe" as never, w.cashId), "CASH_BANK_KIND_INVALID");

      await tx.execute(sql`UPDATE ledger_accounts SET account_type='Expense' WHERE id=${w.bankLedgerId}`);
      await expectCode(load("bank", w.bankId), "CASH_BANK_LINK_BROKEN");
    });
  });
});

describe("statement import", () => {
  it("imports a balanced statement once and replays an identical re-import", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);

      const first = await importCashBankStatementTx(tx, importInput(w));
      const again = await importCashBankStatementTx(tx, importInput(w));

      expect(first).toMatchObject({ replayed: false, count: 2 });
      expect(again).toEqual({ statementId: first.statementId, replayed: true, count: 2 });
      const listed = await listCashBankStatementsTx(tx, {
        companyId: w.companyId,
        accountKind: "bank",
        accountId: w.bankId,
      });
      expect(listed.map((row) => [Number(row.id), row.currency, row.file_name])).toEqual([
        [first.statementId, "USD", "march.csv"],
      ]);
    });
  });

  it.each([
    ["an unbalanced statement", { closingBalance: "131" }, "CASH_BANK_STATEMENT_UNBALANCED"],
    ["a start after the end", { periodStart: "2026-04-01" }, "CASH_BANK_PERIOD_INVALID"],
    ["a line outside the period", { lines: [line(1, "2026-04-02", "30.000000")] }, "CASH_BANK_PERIOD_INVALID"],
    ["no lines", { lines: [] }, "CASH_BANK_IMPORT_SIZE"],
    ["a bad currency", { currency: "dollars" }, "CASH_BANK_CURRENCY_INVALID"],
    ["a bad date", { periodEnd: "31/13/2026" }, "CASH_BANK_DATE_INVALID"],
    [
      "a balance past six decimals",
      { openingBalance: "100.0000001", closingBalance: "130.0000001" },
      "CASH_BANK_PRECISION",
    ],
  ])("refuses %s", async (_label, overrides, code) => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await expectCode(importCashBankStatementTx(tx, importInput(w, overrides)), code);
    });
  });

  it("refuses the same file imported again with different settings", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await importCashBankStatementTx(tx, importInput(w));

      await expectCode(
        importCashBankStatementTx(tx, importInput(w, { periodEnd: "2026-03-30" })),
        "CASH_BANK_IMPORT_CONFLICT"
      );
    });
  });
});

describe("reconciling a statement", () => {
  it("compares the statement with the book, then matches it to a clean reconciliation", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      // A deposit through the bank's linked ledger and a fee on the bank itself;
      // an optional (draft) voucher never reaches the book.
      const [deposit] = await w.voucher("2026-03-05", [
        { ledger: w.bankLedgerId, debit: 50, credit: 0 },
        { ledger: w.expenseId, debit: 0, credit: 50 },
      ]);
      const [fee] = await w.voucher("2026-03-10", [{ bank: w.bankId, debit: 0, credit: 20 }]);
      await w.voucher("2026-03-11", [{ bank: w.bankId, debit: 5, credit: 0 }], { optional: true });
      const { statementId } = await importCashBankStatementTx(tx, importInput(w));

      const before = await cashBankStatementDetailTx(tx, w.companyId, statementId);
      expect(before.balances).toMatchObject({
        bookOpening: "100.000000",
        bookClosing: "130.000000",
        bookVsStatementDifference: "0.000000",
        unclearedBook: "30.000000",
        unmatchedStatement: "30.000000",
        unmatchedStatementCount: 2,
        unclearedBookCount: 2,
        reconcilable: false,
      });
      expect(before.bookEntries.map((entry) => entry.entryId)).toEqual([deposit, fee]);

      const [depositLine, feeLine] = before.lines;
      await matchCashBankLineTx(tx, {
        companyId: w.companyId,
        statementLineId: depositLine.id,
        voucherEntryId: deposit,
        actor,
      });
      await matchCashBankLineTx(tx, {
        companyId: w.companyId,
        statementLineId: feeLine.id,
        voucherEntryId: fee,
        actor,
      });

      const after = await cashBankStatementDetailTx(tx, w.companyId, statementId);
      expect(after.balances).toMatchObject({
        matched: 2,
        unmatchedStatementCount: 0,
        residual: "0.000000",
        reconcilable: true,
      });
      expect(after.lines.map((row) => row.status)).toEqual(["matched", "matched"]);
      expect(after.bookEntries.every((entry) => entry.matched && !entry.eligible)).toBe(true);
    });
  });

  it("counts an unmatched entry from before the period as uncleared", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await w.voucher("2026-02-20", [{ bank: w.bankId, debit: 10, credit: 0 }]);
      const { statementId } = await importCashBankStatementTx(
        tx,
        importInput(w, { openingBalance: "110", closingBalance: "140" })
      );

      const { balances } = await cashBankStatementDetailTx(tx, w.companyId, statementId);

      expect(balances).toMatchObject({ bookOpening: "110.000000", unclearedBook: "10.000000", unclearedBookCount: 1 });
    });
  });

  it("refuses matches that do not fit: wrong amount, another account, reuse, or a second match", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const [deposit] = await w.voucher("2026-03-05", [{ bank: w.bankId, debit: 50, credit: 0 }]);
      const [fee] = await w.voucher("2026-03-10", [{ bank: w.bankId, debit: 0, credit: 20 }]);
      const [cash] = await w.voucher("2026-03-10", [{ ledger: w.cashId, debit: 0, credit: 20 }]);
      const { statementId } = await importCashBankStatementTx(tx, importInput(w));
      const { lines } = await cashBankStatementDetailTx(tx, w.companyId, statementId);
      const match = (statementLineId: number, voucherEntryId: number) =>
        matchCashBankLineTx(tx, { companyId: w.companyId, statementLineId, voucherEntryId, actor });

      await expectCode(match(lines[0].id, fee), "CASH_BANK_MATCH_AMOUNT_MISMATCH");
      await expectCode(match(lines[1].id, cash), "CASH_BANK_ENTRY_INELIGIBLE");
      await expectCode(match(999_999_999, fee), "CASH_BANK_LINE_NOT_FOUND");

      const first = await match(lines[0].id, deposit);
      expect(await match(lines[0].id, deposit)).toEqual({ matchId: first.matchId, replayed: true });
      await expectCode(match(lines[0].id, fee), "CASH_BANK_LINE_ALREADY_MATCHED");
    });
  });

  it("refuses to match one entry to two statement lines", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const [deposit] = await w.voucher("2026-03-05", [{ bank: w.bankId, debit: 50, credit: 0 }]);
      const { statementId } = await importCashBankStatementTx(
        tx,
        importInput(w, {
          closingBalance: "200",
          lines: [line(1, "2026-03-05", "50.000000"), line(2, "2026-03-06", "50.000000")],
        })
      );
      const { lines } = await cashBankStatementDetailTx(tx, w.companyId, statementId);
      await matchCashBankLineTx(tx, {
        companyId: w.companyId,
        statementLineId: lines[0].id,
        voucherEntryId: deposit,
        actor,
      });

      await expectCode(
        matchCashBankLineTx(tx, {
          companyId: w.companyId,
          statementLineId: lines[1].id,
          voucherEntryId: deposit,
          actor,
        }),
        "CASH_BANK_ENTRY_ALREADY_MATCHED"
      );
    });
  });

  it("is not reconcilable while the statement closing differs from the book, even fully matched", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const [deposit] = await w.voucher("2026-03-05", [{ bank: w.bankId, debit: 50, credit: 0 }]);
      const [fee] = await w.voucher("2026-03-10", [{ bank: w.bankId, debit: 0, credit: 20 }]);
      // The bank says it opened at 90; the book opened at 100.
      const { statementId } = await importCashBankStatementTx(
        tx,
        importInput(w, { openingBalance: "90", closingBalance: "120" })
      );
      const { lines } = await cashBankStatementDetailTx(tx, w.companyId, statementId);
      await matchCashBankLineTx(tx, {
        companyId: w.companyId,
        statementLineId: lines[0].id,
        voucherEntryId: deposit,
        actor,
      });
      await matchCashBankLineTx(tx, {
        companyId: w.companyId,
        statementLineId: lines[1].id,
        voucherEntryId: fee,
        actor,
      });

      const { balances } = await cashBankStatementDetailTx(tx, w.companyId, statementId);

      expect(balances).toMatchObject({
        unmatchedStatementCount: 0,
        unclearedBookCount: 0,
        bookVsStatementDifference: "-10.000000",
        reconcilable: false,
      });
    });
  });

  it("opens the book negative for a credit opening balance", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await tx.execute(
        sql`UPDATE bank_accounts SET opening_balance=40, opening_balance_side='Cr' WHERE id=${w.bankId}`
      );
      const { statementId } = await importCashBankStatementTx(
        tx,
        importInput(w, { openingBalance: "-40", closingBalance: "-10" })
      );

      const { balances } = await cashBankStatementDetailTx(tx, w.companyId, statementId);

      expect(balances).toMatchObject({ bookOpening: "-40.000000", openingVerified: true });
    });
  });

  it("refuses an entry that is not in the statement's verified currency", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const [eur] = await w.voucher("2026-03-05", [{ bank: w.bankId, debit: 50, credit: 0, currency: "EUR" }], {
        voucherCurrency: "EUR",
      });
      const { statementId } = await importCashBankStatementTx(tx, importInput(w));
      const { lines, balances } = await cashBankStatementDetailTx(tx, w.companyId, statementId);

      expect(balances).toMatchObject({ otherCurrencyEntries: 1, bookClosing: null, reconcilable: false });
      await expectCode(
        matchCashBankLineTx(tx, { companyId: w.companyId, statementLineId: lines[0].id, voucherEntryId: eur, actor }),
        "CASH_BANK_FX_UNVERIFIED"
      );
    });
  });

  it("unmatches with a reason, once", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const [deposit] = await w.voucher("2026-03-05", [{ bank: w.bankId, debit: 50, credit: 0 }]);
      const { statementId } = await importCashBankStatementTx(tx, importInput(w));
      const { lines } = await cashBankStatementDetailTx(tx, w.companyId, statementId);
      const { matchId } = await matchCashBankLineTx(tx, {
        companyId: w.companyId,
        statementLineId: lines[0].id,
        voucherEntryId: deposit,
        actor,
      });
      const unmatch = (reason: string) => voidCashBankMatchTx(tx, { companyId: w.companyId, matchId, reason, actor });

      await expectCode(unmatch("  "), "CASH_BANK_REASON_REQUIRED");
      expect(await unmatch("wrong deposit")).toEqual({ matchId, voided: true });
      await expectCode(unmatch("again"), "CASH_BANK_MATCH_ALREADY_VOIDED");
      await expectCode(
        voidCashBankMatchTx(tx, { companyId: w.companyId, matchId: 999_999_999, reason: "x", actor }),
        "CASH_BANK_MATCH_NOT_FOUND"
      );
      const detail = await cashBankStatementDetailTx(tx, w.companyId, statementId);
      expect(detail.lines[0].status).toBe("unmatched");
    });
  });

  it("shows a match as stale once its voucher is deleted, and refuses to build on it", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const [deposit] = await w.voucher("2026-03-05", [{ bank: w.bankId, debit: 50, credit: 0 }]);
      const { statementId } = await importCashBankStatementTx(tx, importInput(w));
      const { lines } = await cashBankStatementDetailTx(tx, w.companyId, statementId);
      await matchCashBankLineTx(tx, {
        companyId: w.companyId,
        statementLineId: lines[0].id,
        voucherEntryId: deposit,
        actor,
      });
      await tx.execute(
        sql`UPDATE vouchers SET deleted_at=now() WHERE id=(SELECT voucher_id FROM voucher_entries WHERE id=${deposit})`
      );

      const detail = await cashBankStatementDetailTx(tx, w.companyId, statementId);
      expect(detail.lines[0].status).toBe("stale");
      await expectCode(
        matchCashBankLineTx(tx, {
          companyId: w.companyId,
          statementLineId: lines[0].id,
          voucherEntryId: deposit,
          actor,
        }),
        "CASH_BANK_MATCH_STALE"
      );
    });
  });

  it("reviews unmatched lines with a category that fits their sign", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const { statementId } = await importCashBankStatementTx(tx, importInput(w));
      const { lines } = await cashBankStatementDetailTx(tx, w.companyId, statementId);
      const review = (statementLineId: number, category: never, note: string | null = null) =>
        reviewCashBankLineTx(tx, { companyId: w.companyId, statementLineId, category, note, actor });

      expect(await review(lines[1].id, "bank_fee" as never, "Monthly fee")).toEqual({
        lineId: lines[1].id,
        unchanged: false,
      });
      expect(await review(lines[1].id, "bank_fee" as never, "Monthly fee")).toEqual({
        lineId: lines[1].id,
        unchanged: true,
      });
      await expectCode(review(lines[1].id, "unidentified_receipt" as never), "CASH_BANK_CATEGORY_INVALID");
      await expectCode(review(lines[0].id, "unidentified_payment" as never), "CASH_BANK_CATEGORY_INVALID");
      await expectCode(review(lines[0].id, "other" as never, "x".repeat(1501)), "CASH_BANK_NOTE_TOO_LONG");
      await expectCode(review(999_999_999, "other" as never), "CASH_BANK_LINE_NOT_FOUND");

      const detail = await cashBankStatementDetailTx(tx, w.companyId, statementId);
      expect(detail.lines[1]).toMatchObject({ reviewCategory: "bank_fee", reviewNote: "Monthly fee" });
    });
  });

  it("refuses a statement from another company", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const other = await world(tx);
      const { statementId } = await importCashBankStatementTx(tx, importInput(w));

      await expectCode(cashBankStatementDetailTx(tx, other.companyId, statementId), "CASH_BANK_STATEMENT_NOT_FOUND");
    });
  });
});

it("CashBankError carries a code and status", () => {
  expect(new CashBankError("X", "y", 400)).toMatchObject({ code: "X", status: 400, message: "y" });
});
