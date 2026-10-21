import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { pool } from "../server/db";
import { runRentalReconciliation } from "../server/services/rental/rentalReconciliationService";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "rentalrecon";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let testUnitId: number;
let testContractId: number;

async function q(text: string, params: unknown[] = []) {
  return (await pool.query(text, params)).rows;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function futureDateStr(daysAhead = 10): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

function pastDateStr(daysAgo = 5): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

async function resetRentalActivity(): Promise<void> {
  await q("DELETE FROM property_payments WHERE contract_id = $1", [testContractId]);
  await q("DELETE FROM property_monthly_ledger WHERE contract_id = $1", [testContractId]);
  await q("DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)", [
    ctx.companyId,
  ]);
  await q("DELETE FROM vouchers WHERE company_id = $1", [ctx.companyId]);
}

async function createPayment(input: { amount?: string; paymentDate?: string; scheduleFuturePayment?: boolean }) {
  return agent.post("/api/erp/rental/payments").send({
    contractId: testContractId,
    cashAccountId: ctx.cashAccountId,
    amount: input.amount ?? "500",
    paymentDate: input.paymentDate ?? todayStr(),
    scheduleFuturePayment: input.scheduleFuturePayment ?? false,
  });
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) {
    throw new Error(`Login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  const setCompany = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (setCompany.status !== 200) {
    throw new Error(`Set company failed: ${setCompany.status} ${JSON.stringify(setCompany.body)}`);
  }

  const [unit] = await q(
    `INSERT INTO property_units
       (company_id, module, unit_type, unit_number, location_group, active)
     VALUES ($1, 'ERP', 'SHOP', 'T-101', 'Test Group', true)
     RETURNING id`,
    [ctx.companyId]
  );
  testUnitId = unit.id;

  const startDate = new Date();
  startDate.setUTCDate(1);
  startDate.setUTCMonth(startDate.getUTCMonth() - 3);
  const [contract] = await q(
    `INSERT INTO property_contracts
       (company_id, module, unit_id, tenant_name, rental_amount, start_date, status, currency)
     VALUES ($1, 'ERP', $2, 'Test Tenant', '500.00', $3, 'ACTIVE', 'USD')
     RETURNING id`,
    [ctx.companyId, testUnitId, startDate.toISOString().slice(0, 10)]
  );
  testContractId = contract.id;
}, 60000);

beforeEach(async () => {
  await resetRentalActivity();
});

afterAll(async () => {
  await resetRentalActivity();
  await q("DELETE FROM property_contracts WHERE id = $1", [testContractId]);
  await q("DELETE FROM property_units WHERE id = $1", [testUnitId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("Rental payment accounting and reconciliation", () => {
  it("posts an immediate payment and creates accounting", async () => {
    const res = await createPayment({});
    expect(res.status).toBe(200);

    const [payment] = await q(
      `SELECT posting_status, voucher_id
       FROM property_payments
       WHERE contract_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [testContractId]
    );
    expect(payment.posting_status).toBe("POSTED");
    expect(payment.voucher_id).toBeTruthy();
  });

  it("keeps an approved future payment scheduled without a voucher", async () => {
    const res = await createPayment({
      paymentDate: futureDateStr(10),
      scheduleFuturePayment: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.scheduled).toBe(true);
    expect(res.body.paymentGroupId).toBeTruthy();

    const payments = await q(
      `SELECT posting_status, voucher_id
       FROM property_payments
       WHERE contract_id = $1`,
      [testContractId]
    );
    expect(payments.length).toBeGreaterThan(0);
    for (const payment of payments) {
      expect(payment.posting_status).toBe("SCHEDULED");
      expect(payment.voucher_id).toBeNull();
    }
  });

  it("rejects an unapproved future-dated payment", async () => {
    const res = await createPayment({
      paymentDate: futureDateStr(10),
      scheduleFuturePayment: false,
    });
    expect(res.status).toBe(400);
  });

  it("posts bulk immediate payments", async () => {
    const res = await agent.post("/api/erp/rental/payments/bulk").send({
      clientRequestId: randomUUID(),
      items: [
        {
          contractId: testContractId,
          cashAccountId: ctx.cashAccountId,
          amount: "500",
          paymentDate: todayStr(),
          scheduleFuturePayment: false,
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.results[0]?.scheduled).toBeFalsy();

    const payments = await q("SELECT posting_status FROM property_payments WHERE contract_id = $1", [testContractId]);
    expect(payments.length).toBeGreaterThan(0);
    payments.forEach((payment: any) => expect(payment.posting_status).toBe("POSTED"));
  });

  it("replays a protected bulk rent payment without posting it twice", async () => {
    const body = {
      clientRequestId: randomUUID(),
      items: [
        {
          contractId: testContractId,
          cashAccountId: ctx.cashAccountId,
          amount: "500",
          paymentDate: todayStr(),
          scheduleFuturePayment: false,
        },
      ],
    };
    const first = await agent.post("/api/erp/rental/payments/bulk").send(body);
    expect(first.status).toBe(200);
    expect(first.body.results[0]?.paymentGroupId).toBeTruthy();

    const beforeRetry = await q("SELECT COUNT(*)::int AS count FROM property_payments WHERE contract_id = $1", [
      testContractId,
    ]);
    const replay = await agent.post("/api/erp/rental/payments/bulk").send(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    const afterRetry = await q("SELECT COUNT(*)::int AS count FROM property_payments WHERE contract_id = $1", [
      testContractId,
    ]);
    expect(afterRetry[0].count).toBe(beforeRetry[0].count);
  });

  it("supports legacy bulk arrays when the caller supplies an idempotency header", async () => {
    const res = await agent
      .post("/api/erp/rental/payments/bulk")
      .set("X-Idempotency-Key", randomUUID())
      .send([
        {
          contractId: testContractId,
          cashAccountId: ctx.cashAccountId,
          amount: "500",
          paymentDate: todayStr(),
          scheduleFuturePayment: false,
        },
      ]);
    expect(res.status).toBe(200);
    expect(res.body.results[0]?.paymentGroupId).toBeTruthy();
  });

  it("keeps bulk future payments scheduled", async () => {
    const res = await agent.post("/api/erp/rental/payments/bulk").send({
      clientRequestId: randomUUID(),
      items: [
        {
          contractId: testContractId,
          cashAccountId: ctx.cashAccountId,
          amount: "500",
          paymentDate: futureDateStr(15),
          scheduleFuturePayment: true,
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.results[0]?.scheduled).toBe(true);
  });

  it("returns posting metadata and supports the scheduled filter", async () => {
    await q(
      `INSERT INTO property_payments
         (company_id, module, contract_id, unit_id, amount, payment_date,
          for_year, for_month, posting_status, payment_group_id, posted_at)
       VALUES
         ($1, 'ERP', $2, $3, '500', $4,
          EXTRACT(YEAR FROM NOW())::int, EXTRACT(MONTH FROM NOW())::int,
          'POSTED', 'PG-TEST-P', NOW()),
         ($1, 'ERP', $2, $3, '500', $5,
          EXTRACT(YEAR FROM NOW())::int, EXTRACT(MONTH FROM NOW())::int,
          'SCHEDULED', 'PG-TEST-S', NULL)`,
      [ctx.companyId, testContractId, testUnitId, todayStr(), futureDateStr(10)]
    );

    const all = await agent.get("/api/erp/rental/payments");
    expect(all.status).toBe(200);
    const ownPayments = all.body.filter((payment: any) => payment.contractId === testContractId);
    expect(ownPayments.length).toBeGreaterThan(0);
    expect(ownPayments[0]).toHaveProperty("postingStatus");
    expect(ownPayments[0]).toHaveProperty("paymentGroupId");
    expect(ownPayments[0]).toHaveProperty("postedAt");

    const scheduled = await agent.get("/api/erp/rental/payments?status=SCHEDULED");
    expect(scheduled.status).toBe(200);
    scheduled.body.forEach((payment: any) => expect(payment.postingStatus).toBe("SCHEDULED"));
  });

  it("allocates a multi-month immediate payment without leaving scheduled rows", async () => {
    const res = await createPayment({ amount: "1500" });
    expect(res.status).toBe(200);

    const payments = await q(
      `SELECT posting_status
       FROM property_payments
       WHERE contract_id = $1
       ORDER BY for_year, for_month`,
      [testContractId]
    );
    expect(payments.length).toBeGreaterThanOrEqual(1);
    payments.forEach((payment: any) => expect(payment.posting_status).toBe("POSTED"));
  });

  it("reports no future-posting or paid-amount drift after a clean payment", async () => {
    const res = await createPayment({});
    expect(res.status).toBe(200);

    const result = await runRentalReconciliation(ctx.companyId, "ERP", todayStr());
    expect(result.counts.B_futurePosted).toBe(0);
    expect(result.counts.A_paidAmountDrift).toBe(0);
  });

  it("detects a future-dated POSTED payment", async () => {
    await q(
      `INSERT INTO property_payments
         (company_id, module, contract_id, unit_id, amount, payment_date,
          for_year, for_month, posting_status, payment_group_id, voucher_id)
       VALUES ($1, 'ERP', $2, $3, '500', $4,
               EXTRACT(YEAR FROM NOW())::int, EXTRACT(MONTH FROM NOW())::int,
               'POSTED', 'PG-BAD', NULL)`,
      [ctx.companyId, testContractId, testUnitId, futureDateStr(5)]
    );

    const result = await runRentalReconciliation(ctx.companyId, "ERP", todayStr());
    expect(result.counts.B_futurePosted).toBeGreaterThan(0);
  });

  it("detects a paid-amount cache drift", async () => {
    const now = new Date();
    await q(
      `INSERT INTO property_monthly_ledger
         (company_id, module, contract_id, unit_id, year, month, expected_amount, paid_amount)
       VALUES ($1, 'ERP', $2, $3, $4, $5, '500', '9999.00')
       ON CONFLICT (contract_id, year, month)
       DO UPDATE SET paid_amount = '9999.00'`,
      [ctx.companyId, testContractId, testUnitId, now.getUTCFullYear(), now.getUTCMonth() + 1]
    );

    const result = await runRentalReconciliation(ctx.companyId, "ERP", todayStr());
    expect(result.counts.A_paidAmountDrift).toBeGreaterThan(0);
  });

  it("detects an overdue scheduled payment", async () => {
    await q(
      `INSERT INTO property_payments
         (company_id, module, contract_id, unit_id, amount, payment_date,
          for_year, for_month, posting_status, payment_group_id)
       VALUES ($1, 'ERP', $2, $3, '500', $4,
               EXTRACT(YEAR FROM NOW())::int, EXTRACT(MONTH FROM NOW())::int,
               'SCHEDULED', 'PG-OVERDUE')`,
      [ctx.companyId, testContractId, testUnitId, pastDateStr(1)]
    );

    const result = await runRentalReconciliation(ctx.companyId, "ERP", todayStr());
    expect(result.counts.F_scheduledDue).toBeGreaterThan(0);
  });

  it("serves reconciliation through the authenticated HTTP route", async () => {
    const res = await agent.get("/api/erp/rental/reconciliation");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("totalChecked");
    expect(res.body).toHaveProperty("mismatches");
    expect(res.body).toHaveProperty("counts");
    expect(Array.isArray(res.body.mismatches)).toBe(true);
  });

  it("creates billing-day-aware monthly ledger rows", async () => {
    const { ensureMonthlyLedgerRows } = await import("../server/routes/rental/shared");
    await ensureMonthlyLedgerRows(testContractId, todayStr());
    const rows = await q("SELECT year, month FROM property_monthly_ledger WHERE contract_id = $1", [testContractId]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("keeps the accounts endpoint reachable in the selected company", async () => {
    const res = await agent.get("/api/accounts/all");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.accounts)).toBe(true);
  });

  it("returns the complete reconciliation summary shape", async () => {
    const result = await runRentalReconciliation(ctx.companyId, "ERP", todayStr());
    for (const key of [
      "A_paidAmountDrift",
      "B_futurePosted",
      "C_flagDrift",
      "D_orphanAccrual",
      "E_prematureAccrual",
      "F_scheduledDue",
      "total",
    ]) {
      expect(result.counts).toHaveProperty(key);
    }
    expect(result.totalChecked).toHaveProperty("contracts");
    expect(result.totalChecked).toHaveProperty("payments");
    expect(result.totalChecked).toHaveProperty("ledgerRows");
  });
});
