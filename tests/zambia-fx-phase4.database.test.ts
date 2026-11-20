/**
 * Phase 4 verification against a fresh, disposable CI PostgreSQL company.
 * Never use production Render credentials or known production IDs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { pool } from "../server/db";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { runInCompanyPostingScope } from "../server/services/accounting/scheduledPostingScope";
import { verifyManualFxCorrection } from "../server/services/accounting/manualFxCorrectionVerification";
import { postFxRevaluation } from "../server/services/accounting/fxRevaluationPosting";

const databaseDescribe = process.env.CI === "true" && Boolean(process.env.DATABASE_URL) ? describe : describe.skip;
const prefix = `fxp4-${process.pid}-${Date.now().toString(36)}`;
const day = "2026-11-19";
let companyId = 0;
let kitwe = 0;
let lusaka = 0;
let sales = 0;
let fxAccount = 0;
let originalId = 0;

type FixtureLine = {
  ledger: number;
  debit: string;
  credit: string;
  foreign?: { nativeDebit: string; nativeCredit: string; rate: string };
};

async function ledger(code: string, name: string, accountType: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    "INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1,$2,$3,$4) RETURNING id",
    [companyId, `${prefix}-${code}`, name, accountType]
  );
  return result.rows[0].id;
}

async function journal(
  number: string,
  lines: FixtureLine[],
  reversalOf: number | null = null,
  description = number
): Promise<number> {
  return withFixtureTransaction(async (client) => {
    const created = await client.query<{ id: number }>(
      `INSERT INTO vouchers
       (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency,
        reversal_of_voucher_id, description)
       VALUES ($1,$2,'Journal',$3,0,'USD',$4,$5) RETURNING id`,
      [companyId, `${prefix}-${number}`, day, reversalOf, description]
    );
    const id = created.rows[0].id;
    for (const line of lines) {
      const fx = line.foreign;
      const nativeDebit = fx?.nativeDebit ?? line.debit;
      const nativeCredit = fx?.nativeCredit ?? line.credit;
      const rate = fx?.rate ?? "1";
      const baseDebit = fx ? new Decimal(nativeDebit).div(rate).toFixed(6) : line.debit;
      const baseCredit = fx ? new Decimal(nativeCredit).div(rate).toFixed(6) : line.credit;
      await client.query(
        `INSERT INTO voucher_entries
         (voucher_id, ledger_account_id, debit_amount, credit_amount, transaction_currency,
          transaction_debit_amount, transaction_credit_amount, base_debit_amount, base_credit_amount,
          historical_exchange_rate, rate_convention)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          line.ledger,
          line.debit,
          line.credit,
          fx ? "ZMW" : "USD",
          nativeDebit,
          nativeCredit,
          baseDebit,
          baseCredit,
          rate,
          fx ? "TRANSACTION_PER_BASE" : "IDENTITY",
        ]
      );
    }
    return id;
  });
}

async function receipt(code: string, cash: number, native: string, rate: string): Promise<void> {
  const base = new Decimal(native).div(rate).toDecimalPlaces(2).toFixed(2);
  await journal(code, [
    { ledger: cash, debit: base, credit: "0", foreign: { nativeDebit: native, nativeCredit: "0", rate } },
    { ledger: sales, debit: "0", credit: base, foreign: { nativeDebit: "0", nativeCredit: native, rate } },
  ]);
}

// The shared test setup deletes every posting request after each test
// (tests/voucherRequestIdentityTestBridge.mjs), so the posting identities this
// suite links are re-linked before each later test.
const linkedPostings: Array<{ voucherId: number; source: string; suffix: string }> = [];

async function insertPosting(voucherId: number, source: string, suffix: string): Promise<void> {
  await pool.query(
    `INSERT INTO accounting_posting_requests
     (company_id,idempotency_key,source_type,source_id,request_fingerprint,voucher_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (company_id, idempotency_key) DO NOTHING`,
    [companyId, `${prefix}:${suffix}`, source, `${prefix}:${suffix}`, "b".repeat(64), voucherId]
  );
}

async function linkPosting(voucherId: number, source: string, suffix: string): Promise<void> {
  linkedPostings.push({ voucherId, source, suffix });
  await insertPosting(voucherId, source, suffix);
}

async function verify() {
  return runInCompanyPostingScope(companyId, () => verifyManualFxCorrection(companyId, originalId));
}

databaseDescribe("Phase 4 FX correction audit (disposable PostgreSQL)", () => {
  beforeEach(async () => {
    for (const posting of linkedPostings) await insertPosting(posting.voucherId, posting.source, posting.suffix);
  });

  beforeAll(async () => {
    const company = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, company_type, base_currency, display_currency)
       VALUES ($1, $2, 'erp', 'USD', 'ZMW') RETURNING id`,
      [prefix, prefix]
    );
    companyId = company.rows[0].id;
    await pool.query("INSERT INTO company_settings (company_id, timezone) VALUES ($1,'Africa/Lusaka')", [companyId]);
    await pool.query(
      "INSERT INTO exchange_rates (company_id,from_currency,to_currency,rate,effective_date) VALUES ($1,'USD','ZMW',20.9,$2)",
      [companyId, day]
    );
    kitwe = await ledger("KIT", "KITWE CASH", "Cash");
    lusaka = await ledger("LUS", "LUSAKA CASH", "Cash");
    sales = await ledger("REV", "Sales", "Income");
    // The historical mistake: revaluation counter booked as an Asset.
    const counter = await pool.query<{ id: number }>(
      "INSERT INTO ledger_accounts (company_id,code,name,account_type) VALUES ($1,'FXREVGAI','FX Revaluation Gain/Loss','Asset') RETURNING id",
      [companyId]
    );
    fxAccount = counter.rows[0].id;
    await receipt("KIT208", kitwe, "50450", "20.8");
    await receipt("KIT209", kitwe, "18080", "20.9");
    await receipt("LUS208", lusaka, "147910", "20.8");
    await receipt("LUS209", lusaka, "13140", "20.9");
    originalId = await journal(
      "MANUALFX",
      [
        { ledger: kitwe, debit: "0", credit: "11.60" },
        { ledger: lusaka, debit: "0", credit: "34.03" },
        { ledger: fxAccount, debit: "45.63", credit: "0" },
      ],
      null,
      "Manual FX revaluation 20.8 to 20.9"
    );
    await linkPosting(originalId, "manual-journal", "manual");
  }, 120_000);

  afterAll(async () => {
    if (!companyId) return;
    await pool.query("DELETE FROM accounting_posting_requests WHERE company_id=$1", [companyId]);
    await withFixtureTransaction((client) => client.query("DELETE FROM vouchers WHERE company_id=$1", [companyId]));
    await deleteAuditLogRowsForTests(pool, "company_id=$1", [companyId]);
    await pool.query("DELETE FROM exchange_rates WHERE company_id=$1", [companyId]);
    await pool.query("DELETE FROM ledger_accounts WHERE company_id=$1", [companyId]);
    await pool.query("DELETE FROM company_settings WHERE company_id=$1", [companyId]);
    await pool.query("DELETE FROM companies WHERE id=$1", [companyId]);
  }, 120_000);

  it("reports account reclassification before any financial posting", async () => {
    const start = await verify();
    expect(start.status).toBe("reclassify_fx_account");
    expect(start.originalFxLossUsd).toBe("45.63");
    expect(start.reversalVoucherId).toBeNull();
    expect(start.replacementVoucherId).toBeNull();
  });

  it("reports original reversal needed after a reviewed P&L account correction", async () => {
    await pool.query("UPDATE ledger_accounts SET account_type='Indirect Expense' WHERE company_id=$1 AND id=$2", [
      companyId,
      fxAccount,
    ]);
    expect((await verify()).status).toBe("reverse_original");
  });

  it("verifies exact audited reversal and refuses a second native-USD FX journal", async () => {
    const reversingId = await journal(
      "REVERSE",
      [
        { ledger: kitwe, debit: "11.60", credit: "0" },
        { ledger: lusaka, debit: "34.03", credit: "0" },
        { ledger: fxAccount, debit: "0", credit: "45.63" },
      ],
      originalId,
      "Exact reverse of the old native-USD FX journal"
    );
    await linkPosting(reversingId, "voucher-reversal", "reversal");
    const before = await verify();
    expect(before.status).toBe("post_base_only");
    expect(before.reversalVoucherId).toBe(reversingId);

    const posted = await runInCompanyPostingScope(companyId, () =>
      postFxRevaluation({
        companyId,
        actor: { userId: "1", username: "fx-phase4-ci" },
        reason: "Disposable test proof of USD base-only correction",
      })
    );
    expect(posted.status).toBe("posted");
    const final = await verify();
    expect(final.status).toBe("verified");
    expect(final.blockers).toEqual([]);
    expect(final.replacementVoucherId).toBe(posted.voucherId);
    expect(final.untouchedNativeForeignBalances).toMatchObject({
      [`ledger:${kitwe}`]: { ZMW: "68530.000000" },
      [`ledger:${lusaka}`]: { ZMW: "161050.000000" },
    });

    const repeat = await runInCompanyPostingScope(companyId, () =>
      postFxRevaluation({
        companyId,
        actor: { userId: "1", username: "fx-phase4-ci" },
        reason: "Prove same rate cannot double-post the correction",
      })
    );
    expect(repeat.status).toBe("nothing_to_post");
    expect((await verify()).status).toBe("verified");
  }, 120_000);
});
