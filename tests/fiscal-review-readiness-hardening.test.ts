/**
 * Phase 13 hardening contract for the read-only fiscal-close readiness check.
 *
 *   - a foreign-currency line missing the USD base only on its nonzero side
 *     blocks review, while a fully translated line whose unused side has a
 *     null base does not;
 *   - every required protection fails closed: a disabled master-opening lock,
 *     a guard trigger moved to an unrelated table, and fiscal-review tables
 *     without FORCE RLS each turn readiness off;
 *   - a changed posting type changes the source digest, so an old approval
 *     cannot be reused.
 *
 * Protections are restored in `finally` blocks; the suite runs serially.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { ensureClosedPeriodGuard } from "../server/services/accounting/closedPeriodGuard";
import { ensureFiscalReviewSchema } from "../server/services/accounting/ensureFiscalReviewSchema";
import { ensureOpeningBalanceLock } from "../server/services/accounting/openingBalanceLock";
import { ensureAuditLogAppendOnlyGuard } from "../server/services/audit/auditLogAppendOnlyGuard";
import { ensureVoucherAuditTrigger } from "../server/services/audit/voucherAuditTrigger";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "uafrh";
const START = "2026-01-01";
const END = "2026-09-30";

let ctx: TestContext;
let admin: request.SuperAgentTest;
let retainedId: number;
let expenseId: number;
let otherId: number;

type Readiness = {
  source: { nonUsdUntranslatedLines: number; sourceDigest: string };
  protections: Record<string, boolean>;
  blockers: string[];
};

async function readiness(): Promise<Readiness> {
  const res = await admin.get(
    `/api/accounting/fiscal-review/readiness?periodStartDate=${START}&periodEndDate=${END}&retainedEarningsAccountId=${retainedId}`
  );
  expect(res.status).toBe(200);
  return res.body;
}

const OPENING_LOCK_TABLES = [
  "ledger_accounts",
  "customers",
  "suppliers",
  "bank_accounts",
  "employees",
  "factory_suppliers",
  "fixed_assets",
];

/** Whether all seven opening-balance locks are enabled on their own tables. */
async function allOpeningLocksEnabled() {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
        AND c.relname = ANY($1::text[]) AND t.tgname = c.relname || '_opening_balance_lock'`,
    [OPENING_LOCK_TABLES]
  );
  return rows[0].n === "7";
}

async function ledger(code: string, accountType: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ctx.companyId, `${PREFIX}_${code}`, `${PREFIX} ${code}`, accountType]
  );
  return rows[0].id;
}

/** A balanced EUR journal with every native and base field recorded. */
async function eurVoucher(number: string, amount: string) {
  return withFixtureTransaction(async (client) => {
    const v = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate)
       VALUES ($1, $2, 'Journal', '2026-06-15', 0, 'EUR', '0.9') RETURNING id`,
      [ctx.companyId, `${PREFIX}-${number}`]
    );
    const native = (Number(amount) * 0.9).toFixed(2);
    const lines = [
      { ledger: expenseId, debit: amount, credit: "0", nativeDebit: native, nativeCredit: "0" },
      { ledger: otherId, debit: "0", credit: amount, nativeDebit: "0", nativeCredit: native },
    ];
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, company_id, ledger_account_id, debit_amount, credit_amount,
           transaction_currency, transaction_debit_amount, transaction_credit_amount,
           base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
         VALUES ($1, $2, $3, $4, $5, 'EUR', $6, $7, $4, $5, '0.9', 'TRANSACTION_PER_BASE')`,
        [v.rows[0].id, ctx.companyId, line.ledger, line.debit, line.credit, line.nativeDebit, line.nativeCredit]
      );
    }
    return v.rows[0].id;
  });
}

/** Clear one base field the way a legacy unbackfilled row holds it. */
async function clearBase(voucherId: number, side: "debit" | "credit", onSide: "debit" | "credit") {
  const column = side === "debit" ? "base_debit_amount" : "base_credit_amount";
  const which = onSide === "debit" ? "debit_amount <> 0" : "credit_amount <> 0";
  await withFixtureTransaction((client) =>
    client.query(`UPDATE voucher_entries SET ${column} = NULL WHERE voucher_id = $1 AND ${which}`, [voucherId])
  );
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  // Install every guard the readiness check reads, as server startup does, so
  // this file does not depend on which suites ran before it.
  await ensureClosedPeriodGuard(pool);
  await ensureOpeningBalanceLock(pool);
  await ensureVoucherAuditTrigger(pool);
  await ensureAuditLogAppendOnlyGuard(pool);
  await ensureFiscalReviewSchema(pool);
  // Unified accounting is Developer-only; promote the seeded Admin.
  await pool.query(`UPDATE user_company_roles SET role = 'Developer' WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
  ]);
  admin = request.agent(ctx.app);
  expect(
    (await admin.post("/api/auth/login").send({ username: `${PREFIX}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await admin.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);
  retainedId = await ledger("RE", "Equity");
  expenseId = await ledger("EXP", "Expense");
  otherId = await ledger("LIAB", "Liability");
});

afterAll(async () => {
  await cleanupTestData(PREFIX);
  await closeTestServer();
});

describe("historical FX completeness", () => {
  it("ignores a null base on the unused side but blocks a missing base on either nonzero side", async () => {
    const full = await eurVoucher("FULL", "40.00");
    // Item 4: the debit line's unused credit side carries no base value.
    await clearBase(full, "credit", "debit");
    const clean = await readiness();
    expect(clean.source.nonUsdUntranslatedLines).toBe(0);
    expect(clean.blockers.join("\n")).not.toContain("lack a historical USD base");

    // Item 1, debit side: base missing on the nonzero debit, credit base present.
    const debitGap = await eurVoucher("DEBITGAP", "25.00");
    await clearBase(debitGap, "debit", "debit");
    expect((await readiness()).source.nonUsdUntranslatedLines).toBe(1);

    // Item 1, credit side.
    const creditGap = await eurVoucher("CREDITGAP", "15.00");
    await clearBase(creditGap, "credit", "credit");
    const blocked = await readiness();
    expect(blocked.source.nonUsdUntranslatedLines).toBe(2);
    expect(blocked.blockers.join("\n")).toContain("lack a historical USD base on a nonzero debit/credit side");
  });
});

describe("protections fail closed", () => {
  it("reports every protection the database actually has", async () => {
    // suppliers.company_id comes from the schema preload, so a bare boot on a
    // pushed schema may skip the suppliers lock; the readiness flag must then
    // be false rather than assumed.
    expect((await readiness()).protections).toEqual({
      voucherDateGuardInstalled: true,
      entryDateGuardInstalled: true,
      auditChainInstalled: true,
      openingBalanceGuardInstalled: await allOpeningLocksEnabled(),
      reviewMetadataCompanyRlsInstalled: true,
    });
  });

  it("blocks when one of the seven master-opening locks is disabled", async () => {
    const baseline = await allOpeningLocksEnabled();
    await pool.query(`ALTER TABLE customers DISABLE TRIGGER customers_opening_balance_lock`);
    try {
      const r = await readiness();
      expect(r.protections.openingBalanceGuardInstalled).toBe(false);
      expect(r.blockers.join("\n")).toContain("master-opening");
    } finally {
      await pool.query(`ALTER TABLE customers ENABLE TRIGGER customers_opening_balance_lock`);
    }
    expect((await readiness()).protections.openingBalanceGuardInstalled).toBe(baseline);
  });

  it("does not accept a same-named guard trigger on an unrelated table", async () => {
    await pool.query(`ALTER TABLE vouchers DISABLE TRIGGER vouchers_closed_period_guard`);
    await pool.query(`CREATE TABLE ${PREFIX}_decoy (id int)`);
    await pool.query(
      `CREATE FUNCTION ${PREFIX}_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`
    );
    await pool.query(
      `CREATE TRIGGER vouchers_closed_period_guard BEFORE INSERT ON ${PREFIX}_decoy FOR EACH ROW EXECUTE FUNCTION ${PREFIX}_noop()`
    );
    try {
      const r = await readiness();
      expect(r.protections.voucherDateGuardInstalled).toBe(false);
      expect(r.blockers.join("\n")).toContain("on the wrong table");
    } finally {
      await pool.query(`DROP TABLE ${PREFIX}_decoy`);
      await pool.query(`DROP FUNCTION ${PREFIX}_noop()`);
      await pool.query(`ALTER TABLE vouchers ENABLE TRIGGER vouchers_closed_period_guard`);
    }
    expect((await readiness()).protections.voucherDateGuardInstalled).toBe(true);
  });

  it("requires FORCE RLS on every fiscal-review table", async () => {
    await pool.query(`ALTER TABLE accounting_fiscal_review_policy NO FORCE ROW LEVEL SECURITY`);
    try {
      const r = await readiness();
      expect(r.protections.reviewMetadataCompanyRlsInstalled).toBe(false);
      expect(r.blockers.join("\n")).toContain("FORCE RLS");
    } finally {
      await pool.query(`ALTER TABLE accounting_fiscal_review_policy FORCE ROW LEVEL SECURITY`);
    }
    expect((await readiness()).protections.reviewMetadataCompanyRlsInstalled).toBe(true);
  });
});

describe("source digest", () => {
  it("changes when a posted voucher's type changes", async () => {
    const id = await eurVoucher("DIGEST", "5.00");
    const before = (await readiness()).source.sourceDigest;
    expect((await readiness()).source.sourceDigest).toBe(before);
    await withFixtureTransaction((client) =>
      client.query(`UPDATE vouchers SET voucher_type = 'Payment' WHERE id = $1`, [id])
    );
    expect((await readiness()).source.sourceDigest).not.toBe(before);
  });
});
