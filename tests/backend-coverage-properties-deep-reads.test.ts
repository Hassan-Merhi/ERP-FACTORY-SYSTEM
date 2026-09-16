import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "covpropdeep";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let unitId: number;
let contractId: number;
let before: Record<string, string>;

async function fingerprint(): Promise<Record<string, string>> {
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT COUNT(*)::text FROM vouchers WHERE company_id = $1) AS vouchers,
       (SELECT COUNT(*)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS entries,
       (SELECT COALESCE(SUM(ve.debit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS debit,
       (SELECT COALESCE(SUM(ve.credit_amount::numeric), 0)::text FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id WHERE v.company_id = $1) AS credit,
       (SELECT COUNT(*)::text FROM property_units WHERE company_id = $1) AS units,
       (SELECT COUNT(*)::text FROM property_contracts WHERE company_id = $1) AS contracts,
       (SELECT COUNT(*)::text FROM property_payments WHERE company_id = $1) AS payments,
       (SELECT COUNT(*)::text FROM property_monthly_ledger WHERE company_id = $1) AS ledger_rows`,
    [ctx.companyId]
  );
  return rows[0];
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  await pool.query("UPDATE companies SET company_type = 'properties' WHERE id = $1", [ctx.companyId]);
  await pool.query(
    "UPDATE user_company_roles SET role = 'Developer', can_delete_records = true WHERE user_id = $1 AND company_id = $2",
    [ctx.userId, ctx.companyId]
  );

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`Company selection failed: ${selected.status} ${selected.text}`);

  const unit = await pool.query<{ id: number }>(
    `INSERT INTO property_units
       (company_id, module, unit_type, unit_number, location_group, active)
     VALUES ($1, 'PROPERTIES', 'APARTMENT', 'COV-P-101', 'Coverage Properties', true)
     RETURNING id`,
    [ctx.companyId]
  );
  unitId = unit.rows[0].id;

  const contract = await pool.query<{ id: number }>(
    `INSERT INTO property_contracts
       (company_id, module, unit_id, tenant_name, rental_amount, start_date, status, currency)
     VALUES ($1, 'PROPERTIES', $2, 'Coverage Tenant', '750.00', '2026-06-01', 'ACTIVE', 'USD')
     RETURNING id`,
    [ctx.companyId, unitId]
  );
  contractId = contract.rows[0].id;

  await pool.query(
    `INSERT INTO property_payments
       (company_id, module, contract_id, unit_id, amount, payment_date, for_year, for_month, posting_status, payment_group_id)
     VALUES ($1, 'PROPERTIES', $2, $3, '250.00', '2026-08-15', 2026, 8, 'SCHEDULED', $4)`,
    [ctx.companyId, contractId, unitId, `${TEST_PREFIX}-scheduled`]
  );
  await pool.query(
    `INSERT INTO property_monthly_ledger
       (company_id, module, contract_id, unit_id, year, month, expected_amount, paid_amount)
     VALUES ($1, 'PROPERTIES', $2, $3, 2026, 8, '750.00', '0.00')
     ON CONFLICT (contract_id, year, month) DO NOTHING`,
    [ctx.companyId, contractId, unitId]
  );

  before = await fingerprint();
}, 120000);

afterAll(async () => {
  if (ctx?.companyId) {
    await pool.query("DELETE FROM property_payments WHERE company_id = $1", [ctx.companyId]).catch(() => undefined);
    await pool
      .query("DELETE FROM property_monthly_ledger WHERE company_id = $1", [ctx.companyId])
      .catch(() => undefined);
    await pool.query("DELETE FROM property_contracts WHERE company_id = $1", [ctx.companyId]).catch(() => undefined);
    await pool.query("DELETE FROM property_units WHERE company_id = $1", [ctx.companyId]).catch(() => undefined);
    await cleanupTestData(TEST_PREFIX);
  }
  closeTestServer();
}, 120000);

describe("populated Properties rental read coverage", () => {
  it("executes unit, contract, payment, account and reconciliation readers", async () => {
    const cases = [
      "/api/properties/rental/units",
      `/api/properties/rental/units/${unitId}/detail`,
      `/api/properties/rental/units/${unitId}/statement/export`,
      "/api/properties/rental/cash-accounts",
      "/api/properties/rental/payments",
      "/api/properties/rental/payments?status=SCHEDULED",
      "/api/properties/rental/payments/scheduled",
      "/api/properties/rental/auto-transfer-config",
      "/api/properties/rental/reconciliation",
    ];

    const failures: string[] = [];
    for (const route of cases) {
      try {
        const response = await agent
          .get(route)
          .set("x-client-date", "2026-09-14")
          .timeout({ response: 30000, deadline: 30000 });
        if (response.status >= 500 || response.status === 401) {
          failures.push(`${response.status} ${route}: ${response.body?.message || response.text?.slice(0, 160) || ""}`);
        }
      } catch (error) {
        failures.push(`${route}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  }, 180000);

  it("keeps accounting and source rental state unchanged while allowing due-ledger materialization", async () => {
    const after = await fingerprint();
    for (const key of ["vouchers", "entries", "debit", "credit", "units", "contracts", "payments"] as const) {
      expect(after[key], key).toBe(before[key]);
    }
    // Rental readers intentionally ensure billing-day-aware monthly ledger rows
    // for active contracts so outstanding balances and statement exports are
    // complete. That cache/materialization is allowed to grow, but must never
    // delete an existing row or post accounting/payment side effects.
    expect(Number(after.ledger_rows)).toBeGreaterThanOrEqual(Number(before.ledger_rows));
  });
});
