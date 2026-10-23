/**
 * Unified accounting (Phases 1–15) certification contract.
 *
 * The new accounting surfaces are reports plus locked metadata writers. They
 * must never change an existing financial row. This suite seeds real vouchers
 * (USD and foreign-currency lines, a customer, a bank account and a dated
 * rate), then:
 *
 *   - calls every new GET endpoint as an Admin and asserts none answers 5xx
 *     and that a checksum of every financial table is byte-identical after;
 *   - proves the rollout gate is fail-closed: 401 without a session, 403 for
 *     an ordinary role, 423 for metadata writes in the default read-only
 *     rollout and for the financial-posting endpoints, including path variants
 *     (trailing slash, upper case) Express would still route;
 *   - proves consolidation refuses a company the user cannot access;
 *   - pins the original rental payment rate selection (the direct USD→currency
 *     rate wins over a newer inverse rate), which scheduled payments re-derive
 *     at posting time.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { recordedRentalPaymentRate } from "../server/services/rental/rentalPaymentRate";
import { loadCompanyIntercompanyAccounts } from "../server/helpers/groupIntercompany";
import { normalizedAccountingPath } from "../server/middleware/unifiedAccountingRolloutBoundary";
import { METADATA_ENTRY_REFERENCES_BLOCKER } from "../server/services/accounting/unifiedRolloutService";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "uacert";
const OTHER_PREFIX = "uacertb";
const DATE = "2026-09-15";
const AS_OF = "2026-09-30";

let ctx: TestContext;
let other: TestContext;
let admin: request.SuperAgentTest;
let viewer: request.SuperAgentTest;
let customerId: number;
let bankId: number;

/** Every table whose rows carry an existing balance, amount, rate or cost. */
const FINANCIAL_TABLES = [
  "vouchers",
  "voucher_entries",
  "ledger_accounts",
  "bank_accounts",
  "customers",
  "suppliers",
  "exchange_rates",
  "inventory",
  "stock_items",
  "property_payments",
  "property_monthly_ledger",
  "property_contracts",
  "inter_company_transfers",
  "fiscal_period_closures",
  "accounting_posting_requests",
] as const;

async function financialChecksum(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of FINANCIAL_TABLES) {
    const { rows } = await withFixtureTransaction(async (client) => {
      // Read every company's rows, not only the session's, so a write to any
      // tenant would show up.
      await client.query(`SET LOCAL app.company_scope_maintenance = 'on'`);
      return client.query<{ n: string; h: string | null }>(
        `SELECT count(*)::text AS n, md5(string_agg(t::text, ';' ORDER BY t::text)) AS h FROM ${table} t`
      );
    });
    out[table] = `${rows[0].n}:${rows[0].h ?? "-"}`;
  }
  return out;
}

async function voucher(
  number: string,
  lines: Array<Record<string, unknown>>,
  currency = "USD",
  rate: string | null = null
) {
  return withFixtureTransaction(async (client) => {
    const created = await client.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, exchange_rate)
       VALUES ($1, $2, 'Journal', $3, 0, $4, $5) RETURNING id`,
      [ctx.companyId, `${PREFIX}-${number}`, DATE, currency, rate]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, company_id, ledger_account_id, bank_account_id, customer_id,
           debit_amount, credit_amount, transaction_currency, transaction_debit_amount, transaction_credit_amount,
           base_debit_amount, base_credit_amount, historical_exchange_rate, rate_convention)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          created.rows[0].id,
          ctx.companyId,
          line.ledger ?? null,
          line.bank ?? null,
          line.customer ?? null,
          line.debit ?? "0",
          line.credit ?? "0",
          line.currency ?? null,
          line.nativeDebit ?? null,
          line.nativeCredit ?? null,
          line.baseDebit ?? null,
          line.baseCredit ?? null,
          line.rate ?? null,
          line.convention ?? null,
        ]
      );
    }
    return created.rows[0].id;
  });
}

async function login(prefix: string, companyId: number) {
  const agent = request.agent(ctx.app);
  expect(
    (await agent.post("/api/auth/login").send({ username: `${prefix}_testuser`, password: "testpassword123" })).status
  ).toBe(200);
  expect((await agent.post("/api/auth/set-company").send({ companyId })).status).toBe(200);
  return agent;
}

beforeAll(async () => {
  other = await seedTestData(OTHER_PREFIX);
  ctx = await seedTestData(PREFIX);
  admin = await login(PREFIX, ctx.companyId);

  // An ordinary-role member of the same company.
  const bcrypt = await import("bcryptjs");
  const viewerUser = await pool.query<{ id: string }>(
    `INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id`,
    [`${PREFIX}v_testuser`, await bcrypt.hash("testpassword123", 10)]
  );
  await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'User')`, [
    viewerUser.rows[0].id,
    ctx.companyId,
  ]);
  viewer = await login(`${PREFIX}v`, ctx.companyId);

  const receivable = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Receivable', 'Asset') RETURNING id`,
    [ctx.companyId, `${PREFIX}_AR`]
  );
  customerId = (
    await pool.query<{ id: number }>(
      `INSERT INTO customers (company_id, code, legal_name, ledger_account_id) VALUES ($1, $2, 'Cert Customer', $3) RETURNING id`,
      [ctx.companyId, `${PREFIX}C1`, receivable.rows[0].id]
    )
  ).rows[0].id;
  bankId = (
    await pool.query<{ id: number }>(
      `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number) VALUES ($1, $2, 'Cert EUR Bank', 'Cert Bank', 'CERT-0001') RETURNING id`,
      [ctx.companyId, `${PREFIX}B1`]
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date) VALUES
       ($1, 'USD', 'EUR', '0.9000000000', '2026-09-01'),
       ($1, 'EUR', 'USD', '1.2500000000', '2026-09-10')`,
    [ctx.companyId]
  );

  await voucher("SALE", [
    { customer: customerId, debit: "250.00" },
    { ledger: ctx.salesAccountId, credit: "250.00" },
  ]);
  await voucher(
    "EURRCPT",
    [
      {
        bank: bankId,
        debit: "100.000000",
        currency: "EUR",
        nativeDebit: "90.00",
        nativeCredit: "0",
        baseDebit: "100.000000",
        baseCredit: "0",
        rate: "0.9",
        convention: "TRANSACTION_PER_BASE",
      },
      {
        customer: customerId,
        credit: "100.000000",
        currency: "EUR",
        nativeDebit: "0",
        nativeCredit: "90.00",
        baseDebit: "0",
        baseCredit: "100.000000",
        rate: "0.9",
        convention: "TRANSACTION_PER_BASE",
      },
    ],
    "EUR",
    "0.9"
  );
});

afterAll(async () => {
  await cleanupTestData(PREFIX);
  await cleanupTestData(OTHER_PREFIX);
  closeTestServer();
});

describe("new accounting reads never change existing financial rows", () => {
  const reads = [
    "/api/accounting/open-items?asOfDate=" + AS_OF,
    "/api/accounting/open-items/rentals?asOfDate=" + AS_OF,
    "/api/accounting/cash-bank/accounts",
    "/api/accounting/cash-bank/statements",
    "/api/accounting/erp-inventory/audit?fromDate=2026-09-01&toDate=" + AS_OF,
    "/api/accounting/erp-inventory/readiness",
    "/api/accounting/factory-production/audit?fromDate=2026-09-01&toDate=" + AS_OF,
    "/api/accounting/fiscal-review/policy",
    "/api/accounting/fiscal-review/equity-accounts",
    "/api/accounting/fiscal-review/readiness?periodStartDate=2026-01-01&periodEndDate=" + AS_OF,
    "/api/accounting/fiscal-review/history",
    "/api/accounting/fiscal-review/audit",
    "/api/accounting/consolidation/companies",
    "/api/accounting/history/report?asOfDate=" + AS_OF,
    "/api/accounting/history/erp-stock?asOfDate=" + AS_OF,
    "/api/accounting/monetary-fx/rates",
    "/api/accounting/monetary-fx/rate?currency=EUR&date=" + AS_OF,
    "/api/accounting/monetary-fx/realized",
    "/api/accounting/statements/professional?fromDate=2026-01-01&asOfDate=" + AS_OF,
    "/api/accounting/unified-dashboard?asOfDate=" + AS_OF,
    "/api/accounting/rollout/readiness",
    "/api/accounting/rollout/policy",
    "/api/accounting/rentals/contracts?asOfDate=" + AS_OF,
  ];

  it("answers every read without a server error and leaves every financial table byte-identical", async () => {
    const before = await financialChecksum();
    const consolidation = [
      `/api/accounting/consolidation/report?companyIds=${ctx.companyId}&asOfDate=${AS_OF}`,
      `/api/accounting/consolidation/transfers?companyIds=${ctx.companyId}&asOfDate=${AS_OF}`,
      `/api/accounting/monetary-fx/cash-bank?accountKind=bank&accountId=${bankId}&asOfDate=${AS_OF}`,
    ];
    const failures: string[] = [];
    for (const url of [...reads, ...consolidation]) {
      const res = await admin.get(url);
      if (res.status >= 500) failures.push(`${url} -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    expect(failures).toEqual([]);
    expect(await financialChecksum()).toEqual(before);
  });

  it("keeps an ordinary role out of every new accounting read", async () => {
    for (const url of reads) {
      const res = await viewer.get(url);
      expect([401, 403], `${url} answered ${res.status}`).toContain(res.status);
    }
  });
});

describe("rollout gate is fail-closed", () => {
  const financialPosting = [
    "/api/accounting/fiscal-review/close",
    "/api/accounting/fiscal-review/close/",
    "/api/accounting/FISCAL-REVIEW/close",
    "/api/accounting/monetary-fx/realized/1/recognize",
    "/api/accounting/monetary-fx/realized/1/recognize/",
  ];
  const metadataWrites = [
    "/api/accounting/open-items/matches",
    "/api/accounting/cash-bank/import",
    "/api/accounting/cash-bank/matches",
    "/api/accounting/rentals/expense-links",
    "/api/accounting/fiscal-review/signoffs",
    "/api/accounting/fiscal-review/policy",
    "/api/accounting/fiscal-review/policy/",
  ];

  it("normalizes the paths Express would still route", () => {
    expect(normalizedAccountingPath("/api/accounting/fiscal-review/close/")).toBe(
      "/api/accounting/fiscal-review/close"
    );
    expect(normalizedAccountingPath("/API//accounting/Fiscal-Review/close//")).toBe(
      "/api/accounting/fiscal-review/close"
    );
    expect(normalizedAccountingPath("/")).toBe("/");
  });

  it("refuses unauthenticated and ordinary-role writes", async () => {
    for (const url of [...financialPosting, ...metadataWrites]) {
      expect((await request(ctx.app).post(url).send({})).status, url).toBe(401);
      expect((await viewer.post(url).send({})).status, url).toBe(403);
    }
  });

  it("locks financial posting and default read-only metadata writes for an Admin without changing data", async () => {
    const before = await financialChecksum();
    for (const url of financialPosting) {
      const res = await admin.post(url).send({ reason: "certification probe" });
      expect(res.status, url).toBe(423);
      expect(res.body.code, url).toBe("ACCOUNTING_POSTING_NOT_CERTIFIED");
    }
    for (const url of metadataWrites) {
      const res = await admin.post(url).send({});
      expect(res.status, url).toBe(423);
      expect(res.body.code, url).toBe("ACCOUNTING_READ_ONLY_ROLLOUT");
    }
    expect(await financialChecksum()).toEqual(before);
  });
});

describe("rollout readiness", () => {
  it("starts read-only, reports no financial posting, and blocks the metadata pilot", async () => {
    const policy = await admin.get("/api/accounting/rollout/policy");
    expect(policy.status).toBe(200);
    expect(policy.body.releaseMode).toBe("READ_ONLY");
    const readiness = await admin.get("/api/accounting/rollout/readiness");
    expect(readiness.status).toBe(200);
    expect(readiness.body.blockers).toContain(METADATA_ENTRY_REFERENCES_BLOCKER);
    expect(readiness.body.posting).toMatchObject({
      phase15CanActivateInventory: false,
      phase15CanPostFinancialVouchers: false,
      phase15CanRewriteHistoricalVouchers: false,
    });
    expect(readiness.body.certified).toBe(false);
  });

  it("refuses a pilot switch from a non-Owner", async () => {
    const res = await admin
      .post("/api/accounting/rollout/mode")
      .send({ mode: "METADATA_PILOT", releaseSha: "0".repeat(40), reason: "certification probe only" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await admin.get("/api/accounting/rollout/policy")).body.releaseMode).toBe("READ_ONLY");
  });
});

describe("company isolation", () => {
  it("refuses a consolidation request naming a company the user cannot access", async () => {
    for (const path of ["report", "transfers"]) {
      const res = await admin.get(
        `/api/accounting/consolidation/${path}?companyIds=${ctx.companyId},${other.companyId}&asOfDate=${AS_OF}`
      );
      expect(res.status).toBe(403);
    }
  });

  it("does not list another company in the consolidation picker", async () => {
    const res = await admin.get("/api/accounting/consolidation/companies");
    expect(res.status).toBe(200);
    const ids = (res.body.companies as Array<{ id: number }>).map((c) => c.id);
    expect(ids).toContain(ctx.companyId);
    expect(ids).not.toContain(other.companyId);
  });
});

describe("existing Group Net Position intercompany set", () => {
  it("ignores explicit account links unless the consolidation report opts in", async () => {
    // A plain Asset account that no original source (transfer, POS config,
    // parent credit, Intercompany type) recognizes.
    const asset = await pool.query<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Linked Asset', 'Asset') RETURNING id`,
      [ctx.companyId, `${PREFIX}_LINK`]
    );
    await pool.query(
      `INSERT INTO intercompany_account_links (source_company_id, source_ledger_account_id, dest_company_id, dest_ledger_account_id)
       VALUES ($1, $2, $3, $4)`,
      [ctx.companyId, asset.rows[0].id, other.companyId, other.cashAccountId]
    );
    try {
      const company = { id: ctx.companyId, name: `${PREFIX}_TestCompany`, parentCompanyId: null };
      const companies = [company, { id: other.companyId, name: `${OTHER_PREFIX}_TestCompany`, parentCompanyId: null }];
      const original = await loadCompanyIntercompanyAccounts(company, companies, AS_OF);
      expect(original.map((a) => a.accountId)).not.toContain(asset.rows[0].id);
      const consolidation = await loadCompanyIntercompanyAccounts(company, companies, AS_OF, {
        includeExplicitLinks: true,
      });
      expect(consolidation.map((a) => a.accountId)).toContain(asset.rows[0].id);
    } finally {
      await pool.query(`DELETE FROM intercompany_account_links WHERE source_company_id = $1`, [ctx.companyId]);
    }
  });
});

describe("rental payment rate keeps the original selection", () => {
  it("prefers the direct USD->currency rate over a newer inverse rate", async () => {
    // USD->EUR 0.9 on 09-01 and EUR->USD 1.25 on 09-10: the original resolver
    // returns the direct 0.9, not 1/1.25 = 0.8.
    expect(await recordedRentalPaymentRate(ctx.companyId, "EUR", "2026-09-20")).toBe("0.9");
  });

  it("falls back to the inverse pair and refuses a missing rate", async () => {
    await pool.query(
      `INSERT INTO exchange_rates (company_id, from_currency, to_currency, rate, effective_date)
       VALUES ($1, 'GBP', 'USD', '1.25', '2026-09-01')`,
      [ctx.companyId]
    );
    expect(await recordedRentalPaymentRate(ctx.companyId, "GBP", "2026-09-20")).toBe("0.8");
    expect(await recordedRentalPaymentRate(ctx.companyId, "USD", "2026-09-20")).toBe("1");
    await expect(recordedRentalPaymentRate(ctx.companyId, "CHF", "2026-09-20")).rejects.toMatchObject({
      status: 409,
      code: "RENTAL_RATE_REQUIRED",
    });
  });
});
