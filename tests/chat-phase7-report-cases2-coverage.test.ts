/**
 * Chat report phase 7 cases (quarterly comparison, location list, factory
 * worker profile) driven directly against PostgreSQL in one rolled-back
 * transaction per test. Pins the year source, margin fallbacks, the location
 * status / blank-field dashes and the worker-profile prompts and fallbacks.
 */
import { describe, expect, it } from "vitest";

import { withReportWorld, type ReportWorld } from "./helpers/reportCaseWorld";
import {
  runPhase7FactoryWorkerProfile,
  runPhase7LocationList,
  runPhase7QuarterlyComparison,
} from "../server/chat/reports/implementations/phase7ReportCases2";

const fmt = (n: number) => n.toFixed(2);
const fmtDec = (n: number) => n.toFixed(3);

async function sale(w: ReportWorld, item: number, date: string, sales: number, cost: number) {
  const v = await w.voucher("Sales", date);
  await w.q(
    `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
     VALUES ($1, $2, 1, $3, $4, $3, $4, $3::numeric - $4::numeric)`,
    [v, item, sales, cost]
  );
}

const stockItem = (w: ReportWorld) =>
  w.one(`INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Cream', 'KG') RETURNING id`, [
    w.companyId,
    `${w.tag}I`,
  ]);

describe("phase 7 quarterly comparison", () => {
  it("uses today's year and reports no data without sales", () =>
    withReportWorld(async (w) => {
      const r = await runPhase7QuarterlyComparison({
        companyId: w.companyId,
        params: { queryType: "quarterly_comparison" },
        todayStr: "2031-06-01",
        fmt,
      });
      expect(r).toMatchObject({ title: "Quarterly Comparison — 2031", noData: true });
      expect(r.stats.at(-1)).toEqual({ label: "Overall Margin", value: "—" });
    }));

  it("uses the requested year and labels quarters with margins", () =>
    withReportWorld(async (w) => {
      const item = await stockItem(w);
      await sale(w, item, "2026-02-10", 100, 60);
      await sale(w, item, "2026-11-10", 0, 5);
      await sale(w, item, "2025-02-10", 999, 1);
      const r = await runPhase7QuarterlyComparison({
        companyId: w.companyId,
        params: { queryType: "x", dateFrom: "2026-01-01" },
        todayStr: "2031-06-01",
        fmt,
      });
      expect(r.table.rows).toEqual([
        ["Q1 (Jan-Mar)", "1", "100.00", "60.00", "40.00", "40.0%"],
        ["Q4 (Oct-Dec)", "1", "0.00", "5.00", "-5.00", "—"],
        ["FULL YEAR", "", "100.00", "65.00", "35.00", "35.0%"],
      ]);
      expect(r.stats.at(-1)?.value).toBe("35.0%");
    }));

  it("dashes the full-year margin when the year has no revenue", () =>
    withReportWorld(async (w) => {
      const item = await stockItem(w);
      await sale(w, item, "2026-05-10", 0, 0);
      const r = await runPhase7QuarterlyComparison({
        companyId: w.companyId,
        params: { queryType: "x", dateFrom: "2026-01-01" },
        todayStr: "2031-06-01",
        fmt,
      });
      expect(r.table.rows.at(-1)).toEqual(["FULL YEAR", "", "0.00", "0.00", "0.00", "—"]);
    }));
});

describe("phase 7 location list", () => {
  it("reports no locations for an empty company", () =>
    withReportWorld(async (w) => {
      const r = await runPhase7LocationList({ companyId: await w.otherCompany(), fmt });
      expect(r).toMatchObject({ noData: true, subtitle: "0 location(s)" });
    }));

  it("counts positive stock per location and marks inactive locations", () =>
    withReportWorld(async (w) => {
      const item = await stockItem(w);
      const yard = await w.one(
        `INSERT INTO locations (company_id, code, name, city, country) VALUES ($1, $2, 'A Yard', 'Kolwezi', 'DRC') RETURNING id`,
        [w.companyId, `${w.tag}A`]
      );
      const shut = await w.one(
        `INSERT INTO locations (company_id, code, name, active) VALUES ($1, $2, 'B Shut', false) RETURNING id`,
        [w.companyId, `${w.tag}B`]
      );
      await w.q(`INSERT INTO locations (company_id, code, name, deleted_at) VALUES ($1, $2, 'C Gone', now())`, [
        w.companyId,
        `${w.tag}C`,
      ]);
      await w.q(
        `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, total_value) VALUES ($1, $2, $3, 5, 50), ($1, $4, $3, 0, 99)`,
        [w.companyId, yard, item, shut]
      );
      const r = await runPhase7LocationList({ companyId: w.companyId, fmt });
      expect(r.table.rows).toEqual([
        [`${w.tag}A`, "A Yard", "Kolwezi", "DRC", "1", "50.00", "Active"],
        [`${w.tag}B`, "B Shut", "—", "—", "0", "0.00", "Inactive"],
        [`${w.tag}L`, "Yard", "—", "—", "0", "0.00", "Active"],
      ]);
      expect(r.stats.map((s) => s.value)).toEqual(["3", "1", "50.00"]);
    }));
});

describe("phase 7 factory worker profile", () => {
  const base = (w: ReportWorld) => ({
    companyId: w.companyId,
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
    fmt,
    fmtDec,
  });

  it("asks for a worker name and reports an unknown worker", () =>
    withReportWorld(async (w) => {
      expect(await runPhase7FactoryWorkerProfile({ ...base(w), params: { queryType: "x" } })).toMatchObject({
        summary: "Please specify a worker name.",
      });
      const other = await w.otherCompany();
      await w.q(`INSERT INTO factory_workers (company_id, full_name) VALUES ($1, 'Foreign Worker')`, [other]);
      expect(
        await runPhase7FactoryWorkerProfile({ ...base(w), params: { queryType: "x", entityName: "Foreign" } })
      ).toMatchObject({ summary: 'No worker found matching "Foreign".' });
    }));

  it("shows a sparse inactive worker with dashes", () =>
    withReportWorld(async (w) => {
      await w.q(
        `INSERT INTO factory_workers (company_id, full_name, active, payment_method, base_salary, per_bale_rate, transport_allowance)
         VALUES ($1, 'Sparse Sam', false, NULL, NULL, NULL, NULL)`,
        [w.companyId]
      );
      const r = await runPhase7FactoryWorkerProfile({ ...base(w), params: { queryType: "x", entityName: "sparse" } });
      expect(r.stats?.map((s) => s.value)).toEqual([
        "Sparse Sam",
        "—",
        "—",
        "—",
        "Inactive",
        "Monthly",
        "0.00",
        "0.000",
        "0",
        "0.000",
      ]);
      expect(r.table?.rows.map((row) => row[1])).toEqual(["—", "—", "—", "—", "—", "—", "—", "—", "—", "—", "0.00"]);
    }));

  it("shows a full active worker with pressed bales in range", () =>
    withReportWorld(async (w) => {
      await w.q(
        `INSERT INTO factory_workers (company_id, full_name, employee_code, position, department, gender, nationality,
           date_of_birth, date_joined, base_salary, per_bale_rate, phone1, bank_name, payment_method, visa_expiry,
           work_permit_expiry, shift_type, transport_allowance)
         VALUES ($1, 'Full Fatima', 'FW1', 'Presser', 'Baling', 'F', 'DRC', '1990-01-02', '2024-03-04', 500, 1.5,
           '+243', 'Rawbank', 'Bank', '2027-01-01', '2027-02-02', 'Day', 20)`,
        [w.companyId]
      );
      await w.q(
        `INSERT INTO factory_bales (company_id, reference_number, worker_name, weight_kg, pressed_at)
         VALUES ($1, $2, 'Full Fatima', 45, '2026-05-05'), ($1, $3, 'Full Fatima', 40, NULL), ($1, $4, 'Full Fatima', 30, '2025-05-05')`,
        [w.companyId, `${w.tag}B1`, `${w.tag}B2`, `${w.tag}B3`]
      );
      const r = await runPhase7FactoryWorkerProfile({ ...base(w), params: { queryType: "x", entityName: "fatima" } });
      expect(r.title).toBe("Worker Profile: Full Fatima");
      expect(r.stats?.map((s) => s.value)).toEqual([
        "Full Fatima",
        "FW1",
        "Presser",
        "Baling",
        "Active",
        "Monthly",
        "500.00",
        "1.500",
        "1",
        "45.000",
      ]);
      expect(r.table?.rows).toEqual([
        ["Phone", "+243"],
        ["Nationality", "DRC"],
        ["Gender", "F"],
        ["Date of Birth", expect.stringMatching(/^(1990-01-02|Tue Jan 02)/)],
        ["Date Joined", expect.any(String)],
        ["Shift Type", "Day"],
        ["Bank", "Rawbank"],
        ["Payment Method", "Bank"],
        ["Visa Expiry", expect.any(String)],
        ["Work Permit Expiry", expect.any(String)],
        ["Transport Allowance", "20.00"],
      ]);
    }));
});
