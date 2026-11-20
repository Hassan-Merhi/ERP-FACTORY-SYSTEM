/**
 * Chat report phase 6 cases (journal entries, employee roster, container
 * items, weekly sales) driven directly against PostgreSQL in one rolled-back
 * transaction per test. Pins multi-line journal folding, Dr/Cr dashes,
 * department filtering, the container-number prompt and the margin fallbacks.
 */
import { describe, expect, it } from "vitest";

import { withReportWorld, type ReportWorld } from "./helpers/reportCaseWorld";
import {
  runPhase6ContainerItemsList,
  runPhase6EmployeeList,
  runPhase6JournalEntries,
  runPhase6WeeklySales,
} from "../server/chat/reports/implementations/phase6ReportCases2";

const fmt = (n: number) => n.toFixed(2);
const fmtDec = (n: number) => n.toFixed(3);
const range = { dateFrom: "2026-01-01", dateTo: "2026-12-31" };

describe("phase 6 journal entries", () => {
  it("returns no data without journals", () =>
    withReportWorld(async (w) => {
      const r = await runPhase6JournalEntries({ companyId: w.companyId, ...range, rowLimit: 10, fmt });
      expect(r).toMatchObject({ noData: true, subtitle: "2026-01-01 → 2026-12-31 · 0 journal(s)" });
    }));

  it("folds up to four entries per journal with dashes for zero sides", () =>
    withReportWorld(async (w) => {
      const accts = [];
      for (const name of ["A1", "A2", "A3", "A4", "A5"]) accts.push(await w.ledger(name, "Expense"));
      const big = await w.voucher("Journal", "2026-03-10", { description: "Five line journal", total: 100 });
      await w.entry(big, accts[0], 100, 0);
      await w.entry(big, accts[1], 0, 40);
      await w.entry(big, accts[2], 0, 30);
      await w.entry(big, accts[3], 10, 0);
      await w.entry(big, accts[4], 0, 40);
      const credit = await w.voucher("Journal", "2026-02-01", { total: 5 });
      await w.entry(credit, accts[0], 0, 5);
      await w.voucher("Payment", "2026-03-11");
      await w.voucher("Journal", "2026-03-12", { optional: true });
      const r = await runPhase6JournalEntries({ companyId: w.companyId, ...range, rowLimit: 10, fmt });
      expect(r.table.rows).toEqual([
        ["2026-03-10", expect.stringContaining("V"), "Five line journal", "A1", "100.00", "—", "USD"],
        ["", "", "", "A2", "—", "40.00", ""],
        ["", "", "", "A3", "—", "30.00", ""],
        ["", "", "", "A4", "10.00", "—", ""],
        ["2026-02-01", expect.any(String), "", "A1", "—", "5.00", "USD"],
      ]);
    }));
});

describe("phase 6 employee roster", () => {
  const employee = (w: ReportWorld, code: string, first: string, dept: string | null, active = true) =>
    w.q(
      `INSERT INTO employees (company_id, code, first_name, last_name, department, employee_type, monthly_salary,
         current_balance, join_date, active)
       VALUES ($1, $2, $3, 'Doe', $4, 'Permanent', 1000, 25, '2025-01-15', $5)`,
      [w.companyId, `${w.tag}${code}`, first, dept, active]
    );

  it("totals active staff and filters by department", () =>
    withReportWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 10, fmt };
      expect(await runPhase6EmployeeList({ ...base, params: { queryType: "employee_list" } })).toMatchObject({
        title: "Employee Roster",
        noData: true,
      });
      await employee(w, "E1", "Ann", "Sorting");
      await employee(w, "E2", "Bob", null);
      await employee(w, "E3", "Cid", "Sorting", false);
      const all = await runPhase6EmployeeList({ ...base, params: { queryType: "employee_list" } });
      expect(all.table.rows.map((r) => [r[1], r[2], r[6]])).toEqual([
        ["Ann Doe", "Sorting", "2025-01-15"],
        ["Bob Doe", "—", "2025-01-15"],
      ]);
      expect(all.stats.map((s) => s.value)).toEqual(["2", "2000.00", "50.00"]);
      const sorting = await runPhase6EmployeeList({ ...base, params: { queryType: "x", entityName: "sort" } });
      expect(sorting.title).toBe("Employees — sort");
      expect(sorting.table.rows).toHaveLength(1);
    }));
});

describe("phase 6 container items", () => {
  it("asks for a container number when none is given", () =>
    withReportWorld(async (w) => {
      const r = await runPhase6ContainerItemsList({
        companyId: w.companyId,
        rowLimit: 10,
        fmt,
        fmtDec,
        params: { queryType: "container_items_list" },
      });
      expect(r).toEqual({
        queryType: "container_items_list",
        title: "Container Items",
        summary: "Please specify a container number.",
      });
    }));

  it("lists PO lines for the container and returns only a total row for an unknown container", () =>
    withReportWorld(async (w) => {
      const base = { companyId: w.companyId, rowLimit: 10, fmt, fmtDec };
      const supplier = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Acme Mills', '') RETURNING id`,
        [w.companyId, `${w.tag}S`]
      );
      const container = await w.one(
        `INSERT INTO containers (company_id, container_number, import_date, supplier_id) VALUES ($1, $2, '2026-04-01', $3) RETURNING id`,
        [w.companyId, `${w.tag}CN`, supplier]
      );
      const po = await w.one(
        `INSERT INTO purchase_orders (company_id, container_id, po_number, supplier_id, currency) VALUES ($1, $2, $3, $4, 'EUR') RETURNING id`,
        [w.companyId, container, `${w.tag}PO`, supplier]
      );
      const item = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Cream', 'KG') RETURNING id`,
        [w.companyId, `${w.tag}I`]
      );
      await w.q(
        `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total) VALUES ($1, $2, 'Cream', 10, 2.5, 25)`,
        [po, item]
      );
      const r = await runPhase6ContainerItemsList({
        ...base,
        params: { queryType: "x", containerNumber: `${w.tag}CN` },
      });
      expect(r.title).toBe(`Items in Container: ${w.tag}CN`);
      expect(r.subtitle).toBe("Supplier: Acme Mills · Import: 2026-04-01");
      expect(r.table?.rows).toEqual([
        ["Cream", `${w.tag}I`, "10.000 KG", "2.500", "25.00", `${w.tag}PO`, "EUR"],
        ["TOTAL", "", "", "", "25.00", "", ""],
      ]);
      expect(r.noData).toBe(false);
      const none = await runPhase6ContainerItemsList({ ...base, params: { queryType: "x", entityName: "NO-SUCH" } });
      expect(none).toMatchObject({ title: "Items in Container: NO-SUCH", subtitle: "", noData: true });
    }));
});

describe("phase 6 weekly sales", () => {
  it("returns no data and no total row without sales", () =>
    withReportWorld(async (w) => {
      const r = await runPhase6WeeklySales({ companyId: w.companyId, ...range, rowLimit: 10, fmt });
      expect(r).toMatchObject({ noData: true });
      expect(r.table.rows).toEqual([]);
    }));

  it("computes weekly margins and dashes zero-revenue weeks", () =>
    withReportWorld(async (w) => {
      const item = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Cream', 'KG') RETURNING id`,
        [w.companyId, `${w.tag}I`]
      );
      const sale = async (date: string, sales: number, cost: number) => {
        const v = await w.voucher("Sales", date);
        await w.q(
          `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
           VALUES ($1, $2, 1, $3, $4, $3, $4, $3::numeric - $4::numeric)`,
          [v, item, sales, cost]
        );
      };
      await sale("2026-03-02", 200, 150);
      await sale("2026-03-09", 0, 10);
      const r = await runPhase6WeeklySales({ companyId: w.companyId, ...range, rowLimit: 10, fmt });
      expect(r.table.rows.map((row) => [row[1], row[2], row[4], row[5]])).toEqual([
        ["1", "0.00", "-10.00", "—"],
        ["1", "200.00", "50.00", "25.0%"],
        ["", "200.00", "40.00", "20.0%"],
      ]);
    }));

  it("dashes the total margin when total revenue is zero", () =>
    withReportWorld(async (w) => {
      const item = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Cream', 'KG') RETURNING id`,
        [w.companyId, `${w.tag}I`]
      );
      const v = await w.voucher("Sales", "2026-05-05");
      await w.q(
        `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
         VALUES ($1, $2, 1, 0, 0, 0, 0, 0)`,
        [v, item]
      );
      const r = await runPhase6WeeklySales({ companyId: w.companyId, ...range, rowLimit: 10, fmt });
      expect(r.table.rows.at(-1)).toEqual(["TOTAL", "", "0.00", "0.00", "0.00", "—"]);
    }));
});
