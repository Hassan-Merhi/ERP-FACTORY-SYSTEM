/**
 * Historical Factory worker-advance and rent positions against PostgreSQL in
 * a rolled-back transaction, through both paths: the dated-source fallback
 * used before the row-history baseline (with its explicit limitation
 * warnings) and the recorded row-history replay once every baseline exists.
 */
import { describe, expect, it } from "vitest";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { computeHistoricalFactoryAssetLiabilityOperations } from "../server/services/factory/netPositionHistoricalAssets";
import { FACTORY_ROW_HISTORY_VERSION } from "../server/services/audit/factoryRowHistory";
import type { FactoryNetPositionAsOf } from "../shared/factoryNetPositionAsOf";

type Q = <T = Record<string, any>>(text: string, params?: unknown[]) => Promise<T[]>;
let seq = 0;

const scope = (asOf: string, isHistorical = true): FactoryNetPositionAsOf => ({
  asOf,
  businessToday: "2026-11-19",
  timeZone: "UTC",
  isHistorical,
  historyBasis: "known-at-cutoff",
});

async function world<T>(
  work: (q: Q, companyId: number, one: (t: string, p?: unknown[]) => Promise<number>) => Promise<T>
) {
  return withRolledBackPool(async (client) => {
    const q: Q = async (text, params = []) => (await client.query(text, params)).rows;
    const one = async (text: string, params: unknown[] = []) => Number((await q<{ id: number }>(text, params))[0].id);
    const tag = `NPH${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase().slice(0, 18);
    const companyId = await one(
      `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
      [tag]
    );
    return work(q, companyId, one);
  });
}

/** Advances for two workers: salary-deduction settled first, linked repayments, payroll deductions. */
async function seedAdvances(
  q: Q,
  companyId: number,
  one: (t: string, p?: unknown[]) => Promise<number>,
  created: string
) {
  const worker = (name: string) =>
    one(`INSERT INTO factory_workers (company_id, full_name) VALUES ($1, $2) RETURNING id`, [companyId, name]);
  const a = await worker("Advance A");
  const b = await worker("Advance B");
  const advance = (workerId: number, amount: string, date: string, type: string) =>
    one(
      `INSERT INTO factory_worker_advances (company_id, worker_id, amount, advance_date, repayment_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [companyId, workerId, amount, date, type, created]
    );
  const cash = await advance(a, "100", "2026-03-01", "cash");
  await advance(a, "50", "2026-03-05", "salary_deduction");
  await advance(b, "80", "2026-03-02", "cash");
  await advance(b, "999", "2026-12-01", "cash"); // after every as-of date used here
  const payroll = (workerId: number, deduction: string) =>
    one(
      `INSERT INTO factory_payrolls (company_id, worker_id, period_start, period_end, advances, created_at)
       VALUES ($1, $2, '2026-03-10', '2026-03-16', $3, $4) RETURNING id`,
      [companyId, workerId, deduction, created]
    );
  await payroll(a, "60"); // settles the salary-deduction advance first (50), then 10 of the cash one
  const withRows = await payroll(b, "30"); // written as a repayment row: not deducted twice
  await q(
    `INSERT INTO factory_advance_repayments (company_id, advance_id, worker_id, amount, repayment_date, payroll_id, created_at)
     VALUES ($1, $2, $3, 20, '2026-03-04', NULL, $5),
            ($1, (SELECT id FROM factory_worker_advances WHERE worker_id = $4 AND amount = 80), $4, 30, '2026-03-12', $6, $5)`,
    [companyId, cash, a, b, created, withRows]
  );
  // A: 100 - 20 - 10 = 70 and 50 - 50 = 0; B: 80 - 30 = 50.
  return 120;
}

/** Factory shop rent: one tenant overpaid, one underpaid, plus excluded rows. */
async function seedRent(q: Q, companyId: number, one: (t: string, p?: unknown[]) => Promise<number>, created: string) {
  const unit = (number: string, active: boolean) =>
    one(
      `INSERT INTO property_units (company_id, unit_number, unit_type, location_group, module, active, created_at)
       VALUES ($1, $2, 'SHOP', 'Main', 'FACTORY', $3, $4) RETURNING id`,
      [companyId, number, active, created]
    );
  const shop1 = await unit("S1", true);
  const shop2 = await unit("S2", false);
  const contract = (unitId: number, status: string, end: string | null) =>
    one(
      `INSERT INTO property_contracts (company_id, unit_id, tenant_name, start_date, end_date, status, module, created_at)
       VALUES ($1, $2, 'Tenant', '2026-01-10', $3, $4, 'FACTORY', $5) RETURNING id`,
      [companyId, unitId, end, status, created]
    );
  const active = await contract(shop1, "ACTIVE", null);
  const ended = await contract(shop2, "EXPIRED", "2026-12-31");
  await contract(shop2, "CANCELLED", "2026-02-01");
  const ledger = (contractId: number, unitId: number, month: number, amount: string) =>
    one(
      `INSERT INTO property_monthly_ledger (company_id, contract_id, unit_id, year, month, expected_amount, module, created_at)
       VALUES ($1, $2, $3, 2026, $4, $5, 'FACTORY', $6) RETURNING id`,
      [companyId, contractId, unitId, month, amount, created]
    );
  const jan = await ledger(active, shop1, 1, "100");
  await ledger(active, shop1, 12, "100"); // due after the as-of date
  const endedJan = await ledger(ended, shop2, 1, "200");
  const payment = (
    contractId: number,
    unitId: number,
    ledgerRowId: number | null,
    amount: string,
    status: string,
    postedAt: string | null
  ) =>
    q(
      `INSERT INTO property_payments (company_id, contract_id, unit_id, ledger_row_id, amount, payment_date, for_month,
         for_year, posting_status, posted_at, module, created_at)
       VALUES ($1, $2, $3, $4, $5, '2026-01-15', 1, 2026, $6, $7, 'FACTORY', $8)`,
      [companyId, contractId, unitId, ledgerRowId, amount, status, postedAt, created]
    );
  await payment(active, shop1, jan, "130", "POSTED", created);
  await payment(ended, shop2, endedJan, "150", "POSTED", null);
  await payment(ended, shop2, endedJan, "40", "VOID", null);
  await payment(active, shop1, null, "500", "POSTED", created); // guarantee deposit, not rent
  // An active contract on a non-shop unit is outside the Factory rent report.
  const office = await one(
    `INSERT INTO property_units (company_id, unit_number, unit_type, location_group, module, active, created_at)
     VALUES ($1, 'O1', 'OFFICE', 'Main', 'FACTORY', TRUE, $2) RETURNING id`,
    [companyId, created]
  );
  const officeContract = await contract(office, "ACTIVE", null);
  await ledger(officeContract, office, 1, "70");
  // Active contract prepaid 30; ended contract still owes 50.
}

describe("historical net position assets before the row-history baseline", () => {
  it("replays dated advances and rent with explicit limitation warnings", async () => {
    await world(async (q, companyId, one) => {
      const expected = await seedAdvances(q, companyId, one, "2026-01-01");
      await seedRent(q, companyId, one, "2026-01-01");
      const result = await computeHistoricalFactoryAssetLiabilityOperations(companyId, scope("2026-06-30"));
      expect(result.workerAdvancesValue).toBe(expected);
      expect(result.prepaidRent).toBe(30);
      expect(result.rentPayable).toBe(50);
      expect(result.warnings.sort()).toEqual(
        [
          "HISTORICAL_RENT_CONTRACT_STATUS_UNVERSIONED",
          "HISTORICAL_RENT_EXPECTED_AMOUNTS_UNVERSIONED",
          "HISTORICAL_RENT_POSTING_TIMESTAMP_MISSING",
          "HISTORICAL_RENT_VOID_DATE_UNAVAILABLE",
          "HISTORICAL_WORKER_ADVANCE_EDITS_UNVERSIONED",
        ].sort()
      );
    });
  });

  it("returns zero without warnings when nothing was recorded by the cutoff", async () => {
    await world(async (q, companyId, one) => {
      expect(await computeHistoricalFactoryAssetLiabilityOperations(companyId, scope("2026-06-30"))).toEqual({
        workerAdvancesValue: 0,
        prepaidRent: 0,
        rentPayable: 0,
        warnings: [],
      });
      // Rows created after the cutoff are not yet known on that date.
      await seedAdvances(q, companyId, one, "2026-08-01");
      await seedRent(q, companyId, one, "2026-08-01");
      expect(await computeHistoricalFactoryAssetLiabilityOperations(companyId, scope("2026-06-30"))).toMatchObject({
        workerAdvancesValue: 0,
        prepaidRent: 0,
        rentPayable: 0,
      });
      // A unit with only a contract that ended before the date contributes nothing.
      const unit = await one(
        `INSERT INTO property_units (company_id, unit_number, unit_type, location_group, module, active, created_at)
         VALUES ($1, 'S9', 'SHOP', 'Main', 'FACTORY', FALSE, '2026-01-01') RETURNING id`,
        [companyId]
      );
      await q(
        `INSERT INTO property_contracts (company_id, unit_id, tenant_name, start_date, end_date, status, module, created_at)
         VALUES ($1, $2, 'Gone', '2026-01-01', '2026-02-01', 'EXPIRED', 'FACTORY', '2026-01-01')`,
        [companyId, unit]
      );
      expect((await computeHistoricalFactoryAssetLiabilityOperations(companyId, scope("2026-06-30"))).warnings).toEqual(
        []
      );
    });
  });

  it("wraps any failure in one stable error", async () => {
    await world(async (_q, companyId) => {
      await expect(
        computeHistoricalFactoryAssetLiabilityOperations(companyId, scope("2026-06-30", false))
      ).rejects.toThrow("HISTORICAL_NET_POSITION_ASSETS_FAILED");
    });
  });
});

const TABLES = [
  "factory_worker_advances",
  "factory_advance_repayments",
  "factory_payrolls",
  "property_units",
  "property_contracts",
  "property_monthly_ledger",
  "property_payments",
];

async function baselines(q: Q) {
  for (const table of TABLES) {
    await q(
      `INSERT INTO factory_row_history_baselines (table_name, version, baseline_at, snapshot_rows) VALUES ($1, $2, '2026-01-01', 0)`,
      [table, FACTORY_ROW_HISTORY_VERSION]
    );
  }
}

describe("historical net position assets from recorded row history", () => {
  it("rebuilds advances and rent from the recorded rows once every baseline exists", async () => {
    await world(async (q, companyId, one) => {
      await baselines(q);
      const today = new Date().toISOString().slice(0, 10);
      const expected = await seedAdvances(q, companyId, one, "2026-01-01");
      await seedRent(q, companyId, one, "2026-01-01");
      const result = await computeHistoricalFactoryAssetLiabilityOperations(companyId, scope(today));
      // The recorded replay reaches the same positions as the fallback (no
      // guarantee deposit, no non-shop unit) without its limitation warnings;
      // only the missing posting timestamp is reported.
      expect(result).toEqual({
        workerAdvancesValue: expected,
        prepaidRent: 30,
        rentPayable: 50,
        warnings: ["HISTORICAL_RENT_POSTING_TIMESTAMP_MISSING"],
      });
    });
  });

  it("refuses an invalid recorded rent period", async () => {
    await world(async (q, companyId, one) => {
      await baselines(q);
      await seedRent(q, companyId, one, "2026-01-01");
      await q(`UPDATE property_monthly_ledger SET month = 13 WHERE company_id = $1 AND month = 12`, [companyId]);
      const today = new Date().toISOString().slice(0, 10);
      const error = await computeHistoricalFactoryAssetLiabilityOperations(companyId, scope(today)).catch((e) => e);
      expect(error.message).toBe("HISTORICAL_NET_POSITION_ASSETS_FAILED");
      expect(error.cause.message).toBe("HISTORICAL_RENT_PERIOD_INVALID");
    });
  });
});
