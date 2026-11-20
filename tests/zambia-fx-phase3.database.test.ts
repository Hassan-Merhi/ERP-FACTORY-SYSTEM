/**
 * Phase 3 end-to-end accounting recovery test.
 *
 * Runs ONLY in GitHub CI against its disposable migrated Postgres service.
 * It deliberately creates a fake company; it NEVER connects to the user's
 * production Render database. No test uses company ID 19 or real voucher IDs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { db, pool } from "../server/db";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { runInCompanyPostingScope } from "../server/services/accounting/scheduledPostingScope";
import { getManualFxCorrectionPreflight } from "../server/services/accounting/manualFxCorrectionPreflight";
import { postFxRevaluation } from "../server/services/accounting/fxRevaluationPosting";
import { findLegacyManualFxConflicts } from "../server/services/accounting/legacyManualFxGuard";

const databaseDescribe = process.env.CI === "true" && Boolean(process.env.DATABASE_URL) ? describe : describe.skip;
const unique = `fxp3${process.pid}${Date.now().toString(36)}`;
const at = "2026-11-19";
let companyId: number;
let kitwe: number;
let lusaka: number;
let sales: number;
let fxAccount: number;
let manualVoucherId: number;

async function createLedger(code: string, name: string, type: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [companyId, `${unique}-${code}`, name, type]
  );
  return result.rows[0].id;
}

async function createVoucher(
  number: string,
  lines: Array<{
    ledgerId: number;
    debit: string;
    credit: string;
    currency?: string;
    nativeDebit?: string;
    nativeCredit?: string;
    rate?: string;
  }>,
  reversalOf: number | null = null
): Promise<number> {
  return withFixtureTransaction(async (client) => {
    const header = await client.query<{ id: number }>(
      `INSERT INTO vouchers
       (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, reversal_of_voucher_id, description)
       VALUES ($1, $2, 'Journal', $3, 0, 'USD', $4, $5) RETURNING id`,
      [
        companyId,
        `${unique}-${number}`,
        at,
        reversalOf,
        number === "MANUAL-FX" ? "FX Revaluation — Rate 20.8 → 20.9 ZMW (FX loss)" : number,
      ]
    );
    const id = header.rows[0].id;
    for (const line of lines) {
      const foreign = line.currency === "ZMW";
      await client.query(
        `INSERT INTO voucher_entries
         (voucher_id, ledger_account_id, debit_amount, credit_amount,
          transaction_currency, transaction_debit_amount, transaction_credit_amount,
          base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          line.ledgerId,
          line.debit,
          line.credit,
          foreign ? "ZMW" : "USD",
          foreign ? (line.nativeDebit ?? "0") : line.debit,
          foreign ? (line.nativeCredit ?? "0") : line.credit,
          foreign ? new Decimal(line.nativeDebit ?? "0").div(line.rate!).toFixed(6) : line.debit,
          foreign ? new Decimal(line.nativeCredit ?? "0").div(line.rate!).toFixed(6) : line.credit,
          foreign ? line.rate : "1",
          foreign ? "TRANSACTION_PER_BASE" : "IDENTITY",
        ]
      );
    }
    return id;
  });
}

async function postSale(name: string, ledgerId: number, zmw: string, rate: string): Promise<void> {
  const amount = new Decimal(zmw).div(rate).toDecimalPlaces(2).toFixed(2);
  await createVoucher(name, [
    { ledgerId, debit: amount, credit: "0", currency: "ZMW", nativeDebit: zmw, rate },
    { ledgerId: sales, debit: "0", credit: amount, currency: "ZMW", nativeCredit: zmw, rate },
  ]);
}

async function countRows(table: "vouchers" | "voucher_entries" | "accounting_posting_requests"): Promise<number> {
  if (table === "voucher_entries") {
    const r = await pool.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.company_id=$1",
      [companyId]
    );
    return r.rows[0].n;
  }
  if (table === "vouchers") {
    const r = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id=$1", [
      companyId,
    ]);
    return r.rows[0].n;
  }
  const r = await pool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM accounting_posting_requests WHERE company_id=$1",
    [companyId]
  );
  return r.rows[0].n;
}

databaseDescribe("Phase 3 Zambia manual FX correction (disposable database)", () => {
  beforeAll(async () => {
    const company = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, company_type, base_currency, display_currency)
       VALUES ($1, $2, 'erp', 'USD', 'ZMW') RETURNING id`,
      [unique, unique]
    );
    companyId = company.rows[0].id;
    await pool.query(`INSERT INTO company_settings (company_id, timezone) VALUES ($1, 'Africa/Lusaka')`, [companyId]);
    await pool.query(
      `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
       VALUES ($1, 'USD', 'ZMW', 20.9, $2)`,
      [companyId, at]
    );
    kitwe = await createLedger("KIT", "KITWE CASH", "Cash");
    lusaka = await createLedger("LUS", "LUSAKA CASH", "Cash");
    sales = await createLedger("SALES", "POS Sales", "Income");
    // Exactly the legacy Zambia account problem: a P&L counter mistyped Asset.
    const fx = await pool.query<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type)
       VALUES ($1, 'FXREVGAI', 'FX Revaluation Gain/Loss', 'Asset') RETURNING id`,
      [companyId]
    );
    fxAccount = fx.rows[0].id;
    // Reconstruct the original native ZMW totals and two historical rates.
    await postSale("KIT-208", kitwe, "50450", "20.8");
    await postSale("KIT-209", kitwe, "18080", "20.9");
    // Split the ZMW 161,050 so the 6dp base postings round to the
    // production-equivalent cents: USD 7,739.77 before the manual journal.
    await postSale("LUS-208", lusaka, "147910", "20.8");
    await postSale("LUS-209", lusaka, "13140", "20.9");
    manualVoucherId = await createVoucher("MANUAL-FX", [
      { ledgerId: kitwe, debit: "0", credit: "11.60" },
      { ledgerId: lusaka, debit: "0", credit: "34.03" },
      { ledgerId: fxAccount, debit: "45.63", credit: "0" },
    ]);
  }, 120_000);

  // The shared afterEach in voucherRequestIdentityTestBridge clears posting
  // identities between test cases; the manual journal's identity is what every
  // case here reads, so it is restored before each one.
  beforeEach(async () => {
    await pool.query("DELETE FROM accounting_posting_requests WHERE company_id=$1 AND idempotency_key=$2", [
      companyId,
      `${unique}:manual-fx`,
    ]);
    await pool.query(
      `INSERT INTO accounting_posting_requests
       (company_id, idempotency_key, source_type, source_id, request_fingerprint, voucher_id)
       VALUES ($1, $2, 'manual-journal', $3, $4, $5)`,
      [companyId, `${unique}:manual-fx`, `${unique}:manual-fx`, "a".repeat(64), manualVoucherId]
    );
  });

  afterAll(async () => {
    if (!companyId) return;
    // Only the fake company ID is removed. Never delete or update shared data.
    await pool.query("DELETE FROM accounting_posting_requests WHERE company_id=$1", [companyId]);
    await withFixtureTransaction(async (client) => {
      await client.query("DELETE FROM vouchers WHERE company_id=$1", [companyId]);
    });
    await deleteAuditLogRowsForTests(pool, "company_id=$1", [companyId]);
    await pool.query("DELETE FROM exchange_rates WHERE company_id=$1", [companyId]);
    await pool.query("DELETE FROM ledger_accounts WHERE company_id=$1", [companyId]);
    await pool.query("DELETE FROM company_settings WHERE company_id=$1", [companyId]);
    await pool.query("DELETE FROM companies WHERE id=$1", [companyId]);
  }, 120_000);

  it("recognizes the exact manual voucher and previews without changing anything", async () => {
    const before = await Promise.all([
      countRows("vouchers"),
      countRows("voucher_entries"),
      countRows("accounting_posting_requests"),
    ]);
    const result = await runInCompanyPostingScope(companyId, () =>
      getManualFxCorrectionPreflight(companyId, manualVoucherId)
    );
    expect(result).toMatchObject({
      companyId,
      voucherId: manualVoucherId,
      status: "requires_review",
      readOnly: true,
      fxCounterAccount: { id: fxAccount, code: "FXREVGAI", type: "Asset" },
      manualFxCounterDebitUsd: "45.63",
    });
    expect(result.blockers).toContain("FX_ACCOUNT_RECLASSIFICATION_REQUIRED");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((x) => x.accountKey).sort()).toEqual([`ledger:${kitwe}`, `ledger:${lusaka}`].sort());
    const sum = result.candidates.reduce((acc, row) => acc.plus(row.expectedBaseOnlyAdjustmentUsd), new Decimal(0));
    expect(sum.toFixed(2)).toBe("-45.63");
    expect(result.candidateNetAdjustmentUsd).toBe("-45.63");
    const candidate = new Map(result.candidates.map((row) => [row.accountKey, row]));
    expect(candidate.get(`ledger:${kitwe}`)).toMatchObject({
      bookBeforeManualUsd: "3290.55",
      translatedAfterManualReversalUsd: expect.any(String),
      expectedBaseOnlyAdjustmentUsd: "-11.60",
    });
    expect(candidate.get(`ledger:${lusaka}`)).toMatchObject({
      bookBeforeManualUsd: "7739.77",
      expectedBaseOnlyAdjustmentUsd: "-34.03",
    });
    expect(result.blockers).not.toContain("FX_CORRECTION_AMOUNT_MISMATCH");
    expect(
      await Promise.all([countRows("vouchers"), countRows("voucher_entries"), countRows("accounting_posting_requests")])
    ).toEqual(before);
  });

  it("corrects only the fixture account type, then identifies readiness without auto-posting", async () => {
    await pool.query("UPDATE ledger_accounts SET account_type='Indirect Expense' WHERE company_id=$1 AND id=$2", [
      companyId,
      fxAccount,
    ]);
    const preview = await runInCompanyPostingScope(companyId, () =>
      getManualFxCorrectionPreflight(companyId, manualVoucherId)
    );
    expect(preview.status).toBe("ready_for_review");
    expect(preview.blockers).toEqual([]);
    const outstanding = await runInCompanyPostingScope(companyId, () =>
      findLegacyManualFxConflicts(db, companyId, preview.businessDate)
    );
    expect(outstanding.map((v) => v.voucherId)).toContain(manualVoucherId);
  });

  it("after a fixture reversal, posts ONE base-only voucher and never changes native ZMW", async () => {
    await createVoucher(
      "MANUAL-REVERSAL",
      [
        { ledgerId: kitwe, debit: "11.60", credit: "0" },
        { ledgerId: lusaka, debit: "34.03", credit: "0" },
        { ledgerId: fxAccount, debit: "0", credit: "45.63" },
      ],
      manualVoucherId
    );
    const preview = await runInCompanyPostingScope(companyId, () =>
      getManualFxCorrectionPreflight(companyId, manualVoucherId)
    );
    expect(preview.status).toBe("already_reversed");
    const posted = await runInCompanyPostingScope(companyId, () =>
      postFxRevaluation({
        companyId,
        actor: { userId: "1", username: "phase3-ci" },
        reason: "Disposal fixture FX correction after original audited reversal",
      })
    );
    expect(posted.status).toBe("posted");
    const vouchers = await pool.query(
      `SELECT p.voucher_id, e.ledger_account_id, e.rate_convention,
              e.transaction_currency, e.transaction_debit_amount,
              e.transaction_credit_amount, e.debit_amount, e.credit_amount
         FROM accounting_posting_requests p JOIN voucher_entries e ON e.voucher_id=p.voucher_id
        WHERE p.company_id=$1 AND p.source_type='fx-unrealized-revaluation' ORDER BY e.id`,
      [companyId]
    );
    const baseOnly = vouchers.rows.filter((r) => r.rate_convention === "BASE_ONLY_REVALUATION");
    expect(baseOnly).toHaveLength(2);
    expect(baseOnly.map((r) => r.ledger_account_id).sort()).toEqual([kitwe, lusaka].sort());
    for (const line of baseOnly) {
      expect(line.transaction_currency).toBe("ZMW");
      expect(Number(line.transaction_debit_amount)).toBe(0);
      expect(Number(line.transaction_credit_amount)).toBe(0);
    }
    const second = await runInCompanyPostingScope(companyId, () =>
      postFxRevaluation({
        companyId,
        actor: { userId: "1", username: "phase3-ci" },
        reason: "Verify duplicate revaluation is never created",
      })
    );
    expect(second.status).toBe("nothing_to_post");
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM accounting_posting_requests
           WHERE company_id=$1 AND source_type='fx-unrealized-revaluation'`,
          [companyId]
        )
      ).rows[0].n
    ).toBe(1);
    const native = await pool.query(
      `SELECT e.ledger_account_id, SUM(e.transaction_debit_amount-e.transaction_credit_amount)::numeric AS n
       FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id
       WHERE v.company_id=$1 AND e.transaction_currency='ZMW'
       GROUP BY e.ledger_account_id`,
      [companyId]
    );
    const byId = new Map(native.rows.map((r) => [Number(r.ledger_account_id), Number(r.n)]));
    expect(byId.get(kitwe)).toBe(68530);
    expect(byId.get(lusaka)).toBe(161050);
  }, 120_000);
});
