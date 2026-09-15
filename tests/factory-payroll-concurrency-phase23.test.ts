import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { generateFactoryPayrollBatch } from "../server/services/payroll/factoryPayrollGenerationService";
import { cleanupTestData } from "./setup";

const TEST_PREFIX = "phase23payrace";
let companyId = 0;
let workerId = 0;

beforeAll(async () => {
  await cleanupTestData(TEST_PREFIX);

  const company = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, base_currency)
     VALUES ($1, $2, 'factory', 'USD')
     RETURNING id`,
    [`P23R${Date.now().toString().slice(-4)}`, `${TEST_PREFIX}_TestCompany`]
  );
  companyId = company.rows[0].id;

  const worker = await pool.query<{ id: number }>(
    `INSERT INTO factory_workers
       (company_id, employee_code, full_name, salary_type, base_salary, active)
     VALUES ($1, $2, $3, 'Daily', '100.00', true)
     RETURNING id`,
    [companyId, `${TEST_PREFIX}-W1`, `${TEST_PREFIX} Worker`]
  );
  workerId = worker.rows[0].id;
}, 60_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
}, 30_000);

describe("Phase 23 — payroll generation concurrency", () => {
  it("serializes simultaneous generation for the same company and period", async () => {
    const input = {
      companyId,
      startDate: "2026-09-01",
      endDate: "2026-09-15",
      txDate: "2026-09-15",
      createdBy: "phase23-concurrency-test",
    };

    const [first, second] = await Promise.all([
      generateFactoryPayrollBatch(input),
      generateFactoryPayrollBatch(input),
    ]);

    expect(first.createdCount + second.createdCount).toBe(1);
    expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
    expect(first.payrolls).toHaveLength(1);
    expect(second.payrolls).toHaveLength(1);
    expect(first.payrolls[0].workerId).toBe(workerId);
    expect(second.payrolls[0].workerId).toBe(workerId);

    const payrollRows = await pool.query<{ id: number; worker_id: number }>(
      `SELECT id, worker_id
         FROM factory_payrolls
        WHERE company_id = $1
          AND period_start = $2
          AND period_end = $3`,
      [companyId, input.startDate, input.endDate]
    );
    expect(payrollRows.rows).toHaveLength(1);
    expect(payrollRows.rows[0].worker_id).toBe(workerId);

    const daybookRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM factory_daybook_entries
        WHERE company_id = $1
          AND tx_type = 'PAYROLL_GENERATED'
          AND reference_table = 'factory_payrolls'`,
      [companyId]
    );
    expect(Number(daybookRows.rows[0].count)).toBe(1);
  });
});
