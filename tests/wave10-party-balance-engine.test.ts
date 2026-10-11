/**
 * The one balance engine (accounting audit wave 10).
 *
 * The trial balance and getPartyBalances share one engine
 * (server/services/accounting/balances/ledgerBalanceEngine.ts). These tests pin
 * the owner's rules on a seeded company:
 *   - a customer's opening is the customer record's, counted once, and the
 *     lines on its linked CUST ledger roll up into it (no ledger row);
 *   - the diagnostic lists linked ledgers that carry their own opening;
 *   - a voucher counts from COALESCE(effective_date, voucher_date);
 *   - period mode carries master opening + earlier movements;
 *   - a line with both a debit and a credit is netted, not dropped;
 *   - optional and soft-deleted vouchers are excluded;
 *   - a legacy line naming another company's party is flagged;
 *   - every party balance equals its trial-balance row.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { getPartyBalance, getPartyBalances } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { runAccountingIntegrityDiagnostic } from "../server/services/accounting/integrity/accountingIntegrityDiagnostic";
import { buildTrialBalance } from "../server/services/accounting/integrity/trialBalance";
import { getBalanceSheet } from "../server/services/reports/financialReportsService";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w10pbe";

let ctx: TestContext;
let otherCompanyId: number;
let customerLinked: number;
let customerLinkedLedger: number;
let customerWithLedgerOpening: number;
let supplierId: number;
let foreignCustomerId: number;
let crossVoucherId: number;
let mixedVoucherId: number;
let sequence = 0;

type Line = {
  ledger?: number;
  customer?: number;
  supplier?: number;
  debit: string;
  credit: string;
};

async function voucher(
  lines: Line[],
  dates: { voucherDate: string; effectiveDate?: string },
  options: { optional?: boolean; deleted?: boolean; legacy?: boolean } = {}
): Promise<number> {
  sequence += 1;
  return withFixtureTransaction(
    async (client) => {
      const created = await client.query<{ id: number }>(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, effective_date, total_amount,
                               currency, optional, deleted_at)
         VALUES ($1, $2, 'Journal', $3, $4, 0, 'USD', $5, $6) RETURNING id`,
        [
          ctx.companyId,
          `${TEST_PREFIX}-${sequence}`,
          dates.voucherDate,
          dates.effectiveDate ?? null,
          options.optional ?? false,
          options.deleted ? new Date() : null,
        ]
      );
      for (const line of lines) {
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, customer_id, supplier_id, debit_amount, credit_amount)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            created.rows[0].id,
            line.ledger ?? null,
            line.customer ?? null,
            line.supplier ?? null,
            line.debit,
            line.credit,
          ]
        );
      }
      return created.rows[0].id;
    },
    { legacyUnbalanced: options.legacy }
  );
}

async function insertId(query: string, params: unknown[]): Promise<number> {
  return (await pool.query<{ id: number }>(query, params)).rows[0].id;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  const cash = ctx.cashAccountId;
  const sales = ctx.salesAccountId;

  // A factory-style customer: opening on the customer, CUST ledger auto-created at 0.
  customerLinkedLedger = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance)
     VALUES ($1, $2, $3, 'Asset', 0) RETURNING id`,
    [ctx.companyId, `CUST-${TEST_PREFIX}1`, `${TEST_PREFIX} customer 1`]
  );
  customerLinked = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side, ledger_account_id)
     VALUES ($1, $2, $3, 500, 'Dr', $4) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}C1`, `${TEST_PREFIX} customer 1`, customerLinkedLedger]
  );
  // A customer whose linked ledger also carries an opening (customerService copies it).
  const ledgerWithOpening = await insertId(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, 'Asset', 200, 'Dr') RETURNING id`,
    [ctx.companyId, `CUST-${TEST_PREFIX}2`, `${TEST_PREFIX} customer 2`]
  );
  customerWithLedgerOpening = await insertId(
    `INSERT INTO customers (company_id, code, legal_name, opening_balance, opening_balance_side, ledger_account_id)
     VALUES ($1, $2, $3, 50, 'Dr', $4) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}C2`, `${TEST_PREFIX} customer 2`, ledgerWithOpening]
  );
  supplierId = await insertId(
    `INSERT INTO suppliers (company_id, code, legal_name, email, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, 1000, 'Cr') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}S1`, `${TEST_PREFIX} supplier`, `${TEST_PREFIX}@example.test`]
  );
  otherCompanyId = await insertId(`INSERT INTO companies (code, name) VALUES ($1, $2) RETURNING id`, [
    `${TEST_PREFIX.toUpperCase()}O`,
    `${TEST_PREFIX} other company`,
  ]);
  foreignCustomerId = await insertId(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, $3) RETURNING id`,
    [otherCompanyId, `${TEST_PREFIX}FC`, `${TEST_PREFIX} foreign customer`]
  );

  // Customer 1: invoiced 300 on its CUST ledger, paid 100 on a customer_id-only line.
  await voucher(
    [
      { ledger: customerLinkedLedger, customer: customerLinked, debit: "300.00", credit: "0" },
      { ledger: sales, debit: "0", credit: "300.00" },
    ],
    { voucherDate: "2026-09-02" }
  );
  await voucher(
    [
      { ledger: cash, debit: "100.00", credit: "0" },
      { customer: customerLinked, debit: "0", credit: "100.00" },
    ],
    { voucherDate: "2026-09-03" }
  );

  // Supplier: paid 200, dated before 09-15 but effective after it.
  await voucher(
    [
      { supplier: supplierId, debit: "200.00", credit: "0" },
      { ledger: cash, debit: "0", credit: "200.00" },
    ],
    { voucherDate: "2026-09-10", effectiveDate: "2026-09-25" }
  );
  // Supplier: paid 40, dated after 09-15 but effective before it.
  await voucher(
    [
      { supplier: supplierId, debit: "40.00", credit: "0" },
      { ledger: cash, debit: "0", credit: "40.00" },
    ],
    { voucherDate: "2026-10-05", effectiveDate: "2026-09-12" }
  );
  // Supplier: paid 30. The netting test below replays this line as Dr 60 / Cr 20.
  mixedVoucherId = await voucher(
    [
      { supplier: supplierId, debit: "30.00", credit: "0" },
      { ledger: cash, debit: "0", credit: "30.00" },
    ],
    { voucherDate: "2026-09-20" }
  );
  // Optional and soft-deleted vouchers change nothing.
  await voucher(
    [
      { supplier: supplierId, debit: "999.00", credit: "0" },
      { ledger: cash, debit: "0", credit: "999.00" },
    ],
    { voucherDate: "2026-09-20" },
    { optional: true }
  );
  await voucher(
    [
      { supplier: supplierId, debit: "777.00", credit: "0" },
      { ledger: cash, debit: "0", credit: "777.00" },
    ],
    { voucherDate: "2026-09-20" },
    { deleted: true }
  );
  // Legacy cross-company line: company A's voucher names company B's customer.
  crossVoucherId = await voucher(
    [
      { ledger: cash, debit: "15.00", credit: "0" },
      { customer: foreignCustomerId, debit: "0", credit: "15.00" },
    ],
    { voucherDate: "2026-09-21" },
    { legacy: true }
  );
}, 120_000);

afterAll(async () => {
  // The cross-company line references the other company's customer: remove it first.
  if (crossVoucherId) {
    await withFixtureTransaction(async (client) => {
      await client.query(`DELETE FROM voucher_entries WHERE voucher_id = $1`, [crossVoucherId]);
      await client.query(`DELETE FROM vouchers WHERE id = $1`, [crossVoucherId]);
    });
  }
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("customer openings and linked ledgers", () => {
  it("counts the customer's opening once and rolls its CUST ledger lines into it", async () => {
    const party = await getPartyBalance(db, { companyId: ctx.companyId, kind: "customer", id: customerLinked });
    expect(party).toMatchObject({
      linkedLedgerAccountId: customerLinkedLedger,
      masterOpening: "500.00",
      periodDebit: "300.00",
      periodCredit: "100.00",
      closing: "700.00",
    });
    const trialBalance = await buildTrialBalance(ctx.companyId, null);
    expect(trialBalance.rows.some((row) => row.kind === "ledger" && row.id === customerLinkedLedger)).toBe(false);
    expect(trialBalance.rows.find((row) => row.kind === "customer" && row.id === customerLinked)).toMatchObject({
      openingDebit: "500.00",
      closingDebit: "700.00",
    });
  });

  it("ignores a linked ledger's own opening and lists it for review", async () => {
    const party = await getPartyBalance(db, {
      companyId: ctx.companyId,
      kind: "customer",
      id: customerWithLedgerOpening,
    });
    expect(party).toMatchObject({ masterOpening: "50.00", closing: "50.00" });

    const report = await runAccountingIntegrityDiagnostic(ctx.companyId);
    const flagged = report.checks.find((c) => c.key === "customer_linked_ledger_has_opening");
    expect(flagged?.status).toBe("warn");
    expect(flagged?.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          customer_id: customerWithLedgerOpening,
          account_opening: "200.00",
          same_amount: false,
        }),
      ])
    );
    expect(flagged?.samples.some((row) => row.customer_id === customerLinked)).toBe(false);
  });
});

describe("dates, netting and exclusions", () => {
  it("counts a voucher from its effective date", async () => {
    const at = async (asOf: string) =>
      getPartyBalance(db, { companyId: ctx.companyId, kind: "supplier", id: supplierId, asOf });
    // 09-15: only the 40 effective 09-12 (dated 10-05).
    expect(await at("2026-09-15")).toMatchObject({ periodDebit: "40.00", closing: "-960.00" });
    // 09-30: + the 200 effective 09-25 (dated 09-10) + the netted 30.
    expect(await at("2026-09-30")).toMatchObject({ periodDebit: "270.00", periodCredit: "0.00", closing: "-730.00" });

    const trialBalance = await buildTrialBalance(ctx.companyId, "2026-09-15");
    const row = trialBalance.rows.find((r) => r.kind === "supplier" && r.id === supplierId);
    expect(row).toMatchObject({ periodDebit: "40.00", closingCredit: "960.00" });
  });

  it("carries the master opening and earlier movements into a period", async () => {
    const party = await getPartyBalance(db, {
      companyId: ctx.companyId,
      kind: "supplier",
      id: supplierId,
      from: "2026-09-14",
      asOf: "2026-09-30",
    });
    expect(party).toMatchObject({
      masterOpening: "-1000.00",
      carriedForward: "40.00",
      opening: "-960.00",
      periodDebit: "230.00",
      periodCredit: "0.00",
      closing: "-730.00",
    });
  });

  it("excludes optional and deleted vouchers", async () => {
    const all = await getPartyBalance(db, { companyId: ctx.companyId, kind: "supplier", id: supplierId });
    // 200 + 40 + 30; never 999 (optional) or 777 (deleted).
    expect(all).toMatchObject({ periodDebit: "270.00", periodCredit: "0.00", closing: "-730.00" });
  });

  it("nets a legacy line that carries both a debit and a credit", async () => {
    // voucher_entries_single_side refuses new mixed lines, but legacy rows predate it.
    // Replay the 30 payment as one Dr 60 / Cr 20 line (net 40, so the result
    // also proves the copy was read) in a session-local copy of
    // voucher_entries (a temp table shadows the real one for this transaction only;
    // nothing shared is changed), then roll back.
    const rollback = new Error("rollback");
    let netted: Awaited<ReturnType<typeof getPartyBalance>> = null;
    await db
      .transaction(async (tx) => {
        await tx.execute(
          sql`CREATE TEMP TABLE voucher_entries ON COMMIT DROP AS SELECT * FROM public.voucher_entries ve
               WHERE ve.voucher_id IN (SELECT id FROM vouchers WHERE company_id = ${ctx.companyId})`
        );
        await tx.execute(
          sql`UPDATE pg_temp.voucher_entries SET debit_amount = 60, credit_amount = 20
               WHERE voucher_id = ${mixedVoucherId} AND supplier_id = ${supplierId}`
        );
        netted = await getPartyBalance(tx, { companyId: ctx.companyId, kind: "supplier", id: supplierId });
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    // 200 + 40 + (60 − 20): the net goes to the debit column, the 20 is not a credit.
    expect(netted).toMatchObject({ periodDebit: "280.00", periodCredit: "0.00", closing: "-720.00" });
  });
});

describe("company ownership", () => {
  it("flags a legacy line on another company's customer", async () => {
    const report = await runAccountingIntegrityDiagnostic(ctx.companyId);
    const flagged = report.checks.find((c) => c.key === "cross_company_lines");
    expect(flagged).toMatchObject({ status: "fail", count: 1, amount: "-15.00" });
    expect(flagged?.samples[0]).toMatchObject({
      target: "customer",
      target_id: foreignCustomerId,
      target_company_id: otherCompanyId,
    });
  });
});

describe("trial balance and party balances agree", () => {
  it("gives every party the closing balance of its trial-balance row", async () => {
    const trialBalance = await buildTrialBalance(ctx.companyId, "2026-09-30");
    for (const kind of [
      "ledger",
      "bank",
      "fixedAsset",
      "supplier",
      "employee",
      "factorySupplier",
      "customer",
    ] as const) {
      const { parties } = await getPartyBalances(db, { companyId: ctx.companyId, kind, asOf: "2026-09-30" });
      for (const row of trialBalance.rows.filter((r) => r.kind === kind)) {
        const party = parties.find((p) => p.id === row.id);
        const closing = (Number(row.closingDebit) - Number(row.closingCredit)).toFixed(2);
        expect(party?.closing, `${kind} ${row.id}`).toBe(closing);
      }
    }
    const differenceParts =
      Number(trialBalance.differenceComponents.openingBalances) +
      Number(trialBalance.differenceComponents.singleSidedStockVouchers) +
      Number(trialBalance.differenceComponents.otherUnbalancedVouchers);
    expect(Number(trialBalance.unexplainedDifference)).toBeCloseTo(differenceParts, 2);

    const sheet = await getBalanceSheet(ctx.companyId, "2026-09-30");
    expect(sheet.difference).toBe(trialBalance.unexplainedDifference);
    expect(sheet.assets.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "customer", id: customerLinked, balance: "700.00" })])
    );
  });
});
