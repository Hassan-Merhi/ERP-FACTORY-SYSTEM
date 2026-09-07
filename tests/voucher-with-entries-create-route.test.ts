/**
 * Behavioural coverage for `POST /api/vouchers/with-entries` and `POST /api/vouchers`
 * (`server/routes/vouchers/voucherCreateRoutes.ts`).
 *
 * `with-entries` is the manual journal write path: it validates the batch, then
 * writes the voucher header and every entry inside one transaction. It had no
 * test of its own, and the failures it has to get right are the expensive kind —
 * a half-written journal, or one that does not balance.
 *
 * The properties worth holding:
 *
 *   - **An active voucher must balance.** Total debits and total credits are
 *     compared to a cent; an unbalanced batch is refused before anything is
 *     written. Optional (provisional) vouchers are exempt by design.
 *   - **The header total is the larger side, not the sum.** `total_amount` is
 *     max(debits, credits); summing both would double every voucher.
 *   - **A rejected batch leaves nothing behind.** The header and entries share
 *     one transaction, so an entry that throws mid-loop must roll the header
 *     back too — there is no such thing as a voucher with half its entries.
 *   - **A party's linked ledger wins, and a contradicting one is refused.** An
 *     entry naming a customer inherits that customer's ledger; naming a
 *     different ledger is an error rather than a silent overwrite.
 *   - **Customers are resolved within the current company only,** so a foreign
 *     customer id cannot be posted against.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "vwithentries";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let linkedLedgerId: number;
let linkedCustomerId: number;
let unlinkedCustomerId: number;
let seq = 0;

function voucherNumber(): string {
  seq += 1;
  return `${TEST_PREFIX}-V${seq}`;
}

async function postWithEntries(body: unknown) {
  return agent.post("/api/vouchers/with-entries").send(body);
}

async function entriesFor(voucherId: number) {
  return db.select().from(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, voucherId));
}

async function voucherCountFor(number: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
    [ctx.companyId, number]
  );
  return Number(result.rows[0].count);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  expect(login.status).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

  const [ledger] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId: ctx.companyId,
      code: `${TEST_PREFIX}_AR`,
      name: "Accounts Receivable",
      accountType: "Asset",
      subType: "Receivable",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    })
    .returning();
  linkedLedgerId = ledger.id;

  const [linked] = await db
    .insert(schema.customers)
    .values({
      companyId: ctx.companyId,
      code: `${TEST_PREFIX}-CUS1`,
      legalName: `${TEST_PREFIX} Linked Customer`,
      ledgerAccountId: linkedLedgerId,
    })
    .returning();
  linkedCustomerId = linked.id;

  const [unlinked] = await db
    .insert(schema.customers)
    .values({
      companyId: ctx.companyId,
      code: `${TEST_PREFIX}-CUS2`,
      legalName: `${TEST_PREFIX} Unlinked Customer`,
    })
    .returning();
  unlinkedCustomerId = unlinked.id;
}, 90000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/vouchers/with-entries", () => {
  it("writes the header and both sides of a balanced journal in one transaction", async () => {
    const number = voucherNumber();

    const response = await postWithEntries({
      voucher: {
        voucherNumber: number,
        voucherType: "Journal",
        voucherDate: "2026-03-01",
        description: "Balanced journal",
        locationId: ctx.locationId,
      },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "250.00", creditAmount: "0", narration: "Cash in" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "250.00", narration: "Sale" },
      ],
    });

    expect(response.status).toBe(200);
    const created = response.body.voucher;
    expect(created.voucherNumber).toBe(number);
    expect(created.companyId).toBe(ctx.companyId);
    expect(created.locationId).toBe(ctx.locationId);
    // The header carries the larger side, not the sum of both.
    expect(created.totalAmount).toBe("250.00");
    expect(created.optional).toBe(false);

    const entries = await entriesFor(created.id);
    expect(entries).toHaveLength(2);
    const debits = entries.reduce((sum, e) => sum + Number(e.debitAmount), 0);
    const credits = entries.reduce((sum, e) => sum + Number(e.creditAmount), 0);
    expect(debits).toBeCloseTo(250, 2);
    expect(credits).toBeCloseTo(250, 2);

    const debitEntry = entries.find((e) => Number(e.debitAmount) > 0);
    const creditEntry = entries.find((e) => Number(e.creditAmount) > 0);
    expect(debitEntry?.ledgerAccountId).toBe(ctx.cashAccountId);
    expect(creditEntry?.ledgerAccountId).toBe(ctx.salesAccountId);
    expect(debitEntry?.narration).toBe("Cash in");
  });

  it("records the creation in the audit log against the new voucher", async () => {
    const number = voucherNumber();
    const response = await postWithEntries({
      voucher: { voucherNumber: number, voucherType: "Journal", voucherDate: "2026-03-02" },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "10.00", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "10.00" },
      ],
    });
    expect(response.status).toBe(200);

    const audit = await pool.query<{ action: string; record_identifier: string }>(
      `SELECT action, record_identifier FROM audit_log
        WHERE company_id = $1 AND table_name = 'vouchers' AND record_id = $2`,
      [ctx.companyId, response.body.voucher.id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe("create");
    expect(audit.rows[0].record_identifier).toBe(number);
  });

  it("refuses an unbalanced active voucher and writes nothing", async () => {
    const number = voucherNumber();

    const response = await postWithEntries({
      voucher: { voucherNumber: number, voucherType: "Journal", voucherDate: "2026-03-03" },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "100.00", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "60.00" },
      ],
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Total debits must equal total credits/i);
    expect(await voucherCountFor(number)).toBe(0);
  });

  it("tolerates a sub-cent rounding difference but not a whole cent", async () => {
    const withinTolerance = voucherNumber();
    const accepted = await postWithEntries({
      voucher: { voucherNumber: withinTolerance, voucherType: "Journal", voucherDate: "2026-03-04" },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "100.001", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "100.00" },
      ],
    });
    expect(accepted.status).toBe(200);

    const overTolerance = voucherNumber();
    const refused = await postWithEntries({
      voucher: { voucherNumber: overTolerance, voucherType: "Journal", voucherDate: "2026-03-04" },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "100.02", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "100.00" },
      ],
    });
    expect(refused.status).toBe(400);
    expect(await voucherCountFor(overTolerance)).toBe(0);
  });

  it("lets a provisional voucher stay unbalanced", async () => {
    const number = voucherNumber();

    const response = await postWithEntries({
      voucher: { voucherNumber: number, voucherType: "Journal", voucherDate: "2026-03-05", optional: true },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "500.00", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "1.00" },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.voucher.optional).toBe(true);
    // max(500, 1) = 500.
    expect(response.body.voucher.totalAmount).toBe("500.00");
    expect(await entriesFor(response.body.voucher.id)).toHaveLength(2);
  });

  it("requires both a voucher and a non-empty entry list", async () => {
    for (const body of [
      {},
      { voucher: { voucherNumber: "x", voucherType: "Journal", voucherDate: "2026-03-06" } },
      { voucher: { voucherNumber: "x", voucherType: "Journal", voucherDate: "2026-03-06" }, entries: [] },
      { entries: [{ ledgerAccountId: 1, debitAmount: "1", creditAmount: "0" }] },
    ]) {
      const response = await postWithEntries(body);
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/Voucher and entries are required/i);
    }
  });

  it("fills a customer entry's ledger in from the customer's linked account", async () => {
    const number = voucherNumber();

    const response = await postWithEntries({
      voucher: { voucherNumber: number, voucherType: "Journal", voucherDate: "2026-03-07" },
      entries: [
        // No ledgerAccountId given — the customer's linked ledger must be used.
        { customerId: linkedCustomerId, debitAmount: "80.00", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "80.00" },
      ],
    });

    expect(response.status).toBe(200);
    const entries = await entriesFor(response.body.voucher.id);
    const customerEntry = entries.find((e) => e.customerId === linkedCustomerId);
    expect(customerEntry?.ledgerAccountId).toBe(linkedLedgerId);
  });

  it("refuses an entry that contradicts the customer's linked ledger, and rolls the header back", async () => {
    const number = voucherNumber();

    const response = await postWithEntries({
      voucher: { voucherNumber: number, voucherType: "Journal", voucherDate: "2026-03-08" },
      entries: [
        { customerId: linkedCustomerId, ledgerAccountId: ctx.cashAccountId, debitAmount: "40.00", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "40.00" },
      ],
    });

    expect(response.status).toBe(500);
    expect(response.body.message).toMatch(/linked to ledger/i);
    // The header is written first inside the transaction, so this also proves
    // the rollback: a partial voucher would still be countable here.
    expect(await voucherCountFor(number)).toBe(0);
  });

  it("refuses a customer belonging to another company and leaves no partial voucher", async () => {
    const [foreignCompany] = await db
      .insert(schema.companies)
      .values({
        code: `${TEST_PREFIX.slice(0, 4).toUpperCase()}FGN`,
        name: `${TEST_PREFIX}_ForeignCompany`,
        baseCurrency: "USD",
      })
      .returning();
    const [foreignCustomer] = await db
      .insert(schema.customers)
      .values({
        companyId: foreignCompany.id,
        code: `${TEST_PREFIX}-FGNCUS`,
        legalName: `${TEST_PREFIX} Foreign Customer`,
      })
      .returning();
    const number = voucherNumber();

    try {
      const response = await postWithEntries({
        voucher: { voucherNumber: number, voucherType: "Journal", voucherDate: "2026-03-09" },
        entries: [
          { customerId: foreignCustomer.id, debitAmount: "15.00", creditAmount: "0" },
          { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "15.00" },
        ],
      });

      expect(response.status).toBe(500);
      expect(response.body.message).toMatch(/not found in current company/i);
      expect(await voucherCountFor(number)).toBe(0);
    } finally {
      await db.delete(schema.customers).where(eq(schema.customers.id, foreignCustomer.id));
      await db.delete(schema.companies).where(eq(schema.companies.id, foreignCompany.id));
    }
  });

  it("keeps an entry's own ledger when the named customer has no linked account", async () => {
    const number = voucherNumber();

    const response = await postWithEntries({
      voucher: { voucherNumber: number, voucherType: "Journal", voucherDate: "2026-03-10" },
      entries: [
        { customerId: unlinkedCustomerId, ledgerAccountId: ctx.cashAccountId, debitAmount: "22.00", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "22.00" },
      ],
    });

    expect(response.status).toBe(200);
    const entries = await entriesFor(response.body.voucher.id);
    const customerEntry = entries.find((e) => e.customerId === unlinkedCustomerId);
    expect(customerEntry?.ledgerAccountId).toBe(ctx.cashAccountId);
  });

  it("normalises a foreign-currency journal into base amounts at the supplied rate", async () => {
    const number = voucherNumber();

    const response = await postWithEntries({
      voucher: {
        voucherNumber: number,
        voucherType: "Journal",
        voucherDate: "2026-03-11",
        currency: "EUR",
        exchangeRate: "1.25",
      },
      entries: [
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "100.00", creditAmount: "0" },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "100.00" },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.voucher.currency).toBe("EUR");

    const entries = await entriesFor(response.body.voucher.id);
    const debitEntry = entries.find((e) => Number(e.debitAmount) > 0)!;
    expect(debitEntry.transactionCurrency).toBe("EUR");
    expect(Number(debitEntry.transactionDebitAmount)).toBeCloseTo(100, 2);
    expect(Number(debitEntry.historicalExchangeRate)).toBeCloseTo(1.25, 6);
    // The ERP convention is TRANSACTION_PER_BASE — the rate is transaction units
    // per one base unit — so 100 EUR at 1.25 EUR/USD is 80 USD, not 125.
    // Reading this rate the other way round is the classic FX inversion bug.
    expect(debitEntry.rateConvention).toBe("TRANSACTION_PER_BASE");
    expect(Number(debitEntry.baseDebitAmount)).toBeCloseTo(80, 2);

    const creditEntry = entries.find((e) => Number(e.creditAmount) > 0)!;
    expect(Number(creditEntry.baseCreditAmount)).toBeCloseTo(80, 2);
    // Balanced in the base currency as well as the transaction currency.
    expect(Number(debitEntry.baseDebitAmount)).toBeCloseTo(Number(creditEntry.baseCreditAmount), 2);
  });

  it("passes caller-supplied dual-currency fields through unchanged", async () => {
    const number = voucherNumber();

    const response = await postWithEntries({
      voucher: { voucherNumber: number, voucherType: "Journal", voucherDate: "2026-03-12", currency: "EUR" },
      entries: [
        {
          ledgerAccountId: ctx.cashAccountId,
          debitAmount: "90.00",
          creditAmount: "0",
          transactionCurrency: "GBP",
          transactionDebitAmount: "90.00",
          transactionCreditAmount: "0",
          baseDebitAmount: "117.00",
          baseCreditAmount: "0",
          historicalExchangeRate: "1.3",
          rateConvention: "BASE_PER_TRANSACTION",
        },
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "90.00" },
      ],
    });

    expect(response.status).toBe(200);
    const entries = await entriesFor(response.body.voucher.id);
    const supplied = entries.find((e) => e.transactionCurrency === "GBP")!;
    expect(Number(supplied.baseDebitAmount)).toBeCloseTo(117, 2);
    expect(Number(supplied.historicalExchangeRate)).toBeCloseTo(1.3, 6);
  });
});

describe("POST /api/vouchers", () => {
  it("creates a bare voucher for a non-POS user", async () => {
    const number = voucherNumber();

    const response = await agent.post("/api/vouchers").send({
      companyId: ctx.companyId,
      voucherNumber: number,
      voucherType: "Journal",
      voucherDate: "2026-03-13",
      totalAmount: "0",
      currency: "USD",
    });

    expect(response.status).toBe(200);
    expect(response.body.voucherNumber).toBe(number);
    expect(await voucherCountFor(number)).toBe(1);
  });

  it("refuses a POS user creating anything other than a stock transfer", async () => {
    await db.update(schema.userCompanyRoles).set({ role: "POS" }).where(eq(schema.userCompanyRoles.userId, ctx.userId));
    expect((await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId })).status).toBe(200);

    const number = voucherNumber();
    try {
      const response = await agent.post("/api/vouchers").send({
        companyId: ctx.companyId,
        voucherNumber: number,
        voucherType: "Journal",
        voucherDate: "2026-03-14",
        totalAmount: "0",
        currency: "USD",
      });

      expect(response.status).toBe(403);
      expect(response.body.message).toMatch(/not available for POS users/i);
      expect(await voucherCountFor(number)).toBe(0);
    } finally {
      await db
        .update(schema.userCompanyRoles)
        .set({ role: "Admin" })
        .where(eq(schema.userCompanyRoles.userId, ctx.userId));
      await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
    }
  });
});
