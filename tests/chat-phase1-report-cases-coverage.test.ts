/**
 * Chat report phase 1 cases driven directly against PostgreSQL in one
 * rolled-back transaction per test: attendance, supplier / customer balances
 * and statements, receivables, cash position and the P&L summary. Pins the
 * highlight, Dr/Cr opening side and empty-input branches.
 */
import { describe, expect, it } from "vitest";

import { withReportWorld } from "./helpers/reportCaseWorld";
import {
  runPhase1CashPosition,
  runPhase1CustomerStatement,
  runPhase1OutstandingSuppliers,
  runPhase1OverduePayments,
  runPhase1PlSummary,
  runPhase1SupplierStatement,
  runPhase1TopCustomers,
  runPhase1WorkerAttendance,
} from "../server/chat/reports/implementations/phase1ReportCases";

const fmt = (n: number) => n.toFixed(2);
const fmtDec = (n: number) => n.toFixed(3);
const range = { dateFrom: "2026-01-01", dateTo: "2026-12-31" };

describe("phase 1 worker attendance", () => {
  it("reports a placeholder when there is no attendance", () =>
    withReportWorld(async (w) => {
      const r = await runPhase1WorkerAttendance({ companyId: w.companyId, ...range });
      expect(r.stats).toEqual([
        { label: "No Data", value: "No attendance records for this period.", highlight: "muted" },
      ]);
      expect(r.subtitle).toContain("0 record(s)");
    }));

  it("highlights present, absent and other statuses", () =>
    withReportWorld(async (w) => {
      const worker = await w.one(
        `INSERT INTO factory_workers (company_id, full_name) VALUES ($1, 'Ali') RETURNING id`,
        [w.companyId]
      );
      for (const [date, status] of [
        ["2026-03-01", "Present"],
        ["2026-03-02", "Present"],
        ["2026-03-03", "Absent"],
        ["2026-03-04", "Leave"],
        ["2025-03-04", "Absent"],
      ]) {
        await w.q(
          `INSERT INTO factory_attendance (company_id, worker_id, attendance_date, status) VALUES ($1, $2, $3, $4)`,
          [w.companyId, worker, date, status]
        );
      }
      const r = await runPhase1WorkerAttendance({ companyId: w.companyId, ...range });
      expect(r.stats).toEqual([
        { label: "Absent", value: "1 records · 1 worker(s)", highlight: "negative" },
        { label: "Leave", value: "1 records · 1 worker(s)", highlight: "muted" },
        { label: "Present", value: "2 records · 1 worker(s)", highlight: "positive" },
      ]);
      expect(r.subtitle).toContain("4 record(s)");
    }));
});

describe("phase 1 party balances", () => {
  it("lists suppliers owed more than 100 for both opening sides and skips cash and income", () =>
    withReportWorld(async (w) => {
      expect((await runPhase1OutstandingSuppliers({ companyId: w.companyId, rowLimit: 20, fmt })).noData).toBe(true);
      await w.ledger("Cr Opening Supplier", "Supplier", { opening: 500, side: "Cr" });
      const drSide = await w.ledger("Dr Opening Supplier", "Supplier", { opening: 100, side: "Dr" });
      await w.ledger("Small Supplier", "Supplier", { opening: 50, side: "Cr" });
      await w.ledger("Cash Box", "Cash", { opening: 900, side: "Cr" });
      const v = await w.voucher("Purchase", "2026-02-01");
      await w.entry(v, drSide, 0, 400);
      const other = await w.otherCompany();
      await w.ledger("Foreign Supplier", "Supplier", { companyId: other, opening: 999, side: "Cr" });
      const r = await runPhase1OutstandingSuppliers({ companyId: w.companyId, rowLimit: 20, fmt });
      expect(r.table.rows).toEqual([
        ["Cr Opening Supplier", "500.00"],
        ["Dr Opening Supplier", "300.00"],
      ]);
      expect(r.noData).toBe(false);
    }));

  it("lists receivables with and without a last transaction", () =>
    withReportWorld(async (w) => {
      expect((await runPhase1OverduePayments({ companyId: w.companyId, rowLimit: 20, fmt })).noData).toBe(true);
      const crSide = await w.ledger("Cr Customer", "Customer", { opening: 50, side: "Cr" });
      await w.ledger("Idle Customer", "Customer", { opening: 200, side: "Dr" });
      const v = await w.voucher("Sales", "2026-04-05");
      await w.entry(v, crSide, 500, 0);
      const r = await runPhase1OverduePayments({ companyId: w.companyId, rowLimit: 20, fmt });
      expect(r.table.rows).toEqual([
        ["Cr Customer", "450.00", "2026-04-05"],
        ["Idle Customer", "200.00", "—"],
      ]);
    }));

  it("ranks top customers by receipts in range and ignores optional receipts", () =>
    withReportWorld(async (w) => {
      expect((await runPhase1TopCustomers({ companyId: w.companyId, ...range, rowLimit: 5, fmt })).title).toBe(
        "Top 0 Customers by Revenue"
      );
      const a = await w.ledger("Amina", "Customer");
      const b = await w.ledger("Bilal", "Customer");
      const r1 = await w.voucher("Receipt", "2026-05-01");
      await w.entry(r1, a, 0, 300);
      const r2 = await w.voucher("Receipt", "2026-05-02");
      await w.entry(r2, b, 0, 100);
      const opt = await w.voucher("Receipt", "2026-05-03", { optional: true });
      await w.entry(opt, b, 0, 1000);
      const r = await runPhase1TopCustomers({ companyId: w.companyId, ...range, rowLimit: 5, fmt });
      expect(r.table.rows).toEqual([
        ["1", "Amina", "1", "300.00"],
        ["2", "Bilal", "1", "100.00"],
      ]);
    }));
});

describe("phase 1 statements", () => {
  for (const [label, run, emptyTitle, prefix] of [
    ["supplier", runPhase1SupplierStatement, "Supplier Statement", "Supplier: "],
    ["customer", runPhase1CustomerStatement, "Customer Statement", "Statement: "],
  ] as const) {
    it(`${label} statement asks for a name, reports an unknown name and lists debits and credits`, () =>
      withReportWorld(async (w) => {
        const base = { companyId: w.companyId, rowLimit: 10, fmtDec };
        expect(await run({ ...base, params: { queryType: "x" } })).toMatchObject({ title: emptyTitle });
        const missing = await run({ ...base, params: { queryType: "x", entityName: "Nobody" } });
        expect(missing.summary).toBe("No account found matching that name.");
        const acct = await w.ledger("Zed Party", "Supplier");
        const empty = await run({ ...base, params: { queryType: "x", entityName: "zed" } });
        expect(empty).toMatchObject({ title: `${prefix}Zed Party`, noData: true });
        const v1 = await w.voucher("Payment", "2026-06-01", { description: "Paid in cash" });
        await w.entry(v1, acct, 250, 0);
        const v2 = await w.voucher("Purchase", "2026-06-02");
        await w.entry(v2, acct, 0, 75.5);
        const r = await run({ ...base, params: { queryType: "x", entityName: "zed" } });
        expect(r.table?.rows).toEqual([
          ["2026-06-02", "Purchase", "", "—", "75.500"],
          ["2026-06-01", "Payment", "Paid in cash", "250.000", "—"],
        ]);
      }));
  }
});

describe("phase 1 cash and P&L", () => {
  it("reports cash and bank balances with positive and negative highlights", () =>
    withReportWorld(async (w) => {
      await w.ledger("Main Cash", "Cash", { opening: 100, side: "Dr" });
      await w.ledger("Overdrawn Bank", "Bank", { opening: 400, side: "Cr" });
      const r = await runPhase1CashPosition({ companyId: w.companyId, fmt, todayStr: "2026-11-20" });
      expect(r.stats).toEqual([
        { label: "Overdrawn Bank (Bank)", value: "-400.00", highlight: "negative" },
        { label: "Main Cash (Cash)", value: "100.00", highlight: "positive" },
        { label: "TOTAL CASH & BANK", value: "-300.00", highlight: "negative" },
      ]);
    }));

  it("reports a zero cash total as positive", () =>
    withReportWorld(async (w) => {
      const r = await runPhase1CashPosition({ companyId: w.companyId, fmt, todayStr: "2026-11-20" });
      expect(r.stats).toEqual([{ label: "TOTAL CASH & BANK", value: "0.00", highlight: "positive" }]);
    }));

  it("splits income, direct and operating expenses into a profitable P&L", () =>
    withReportWorld(async (w) => {
      const sales = await w.ledger("Sales", "Income");
      const cogs = await w.ledger("Purchases", "Expense", { subType: "Direct Expense" });
      const rent = await w.ledger("Rent", "Indirect Expense");
      const v = await w.voucher("Journal", "2026-07-01");
      await w.entry(v, sales, 0, 1000);
      await w.entry(v, cogs, 600, 0);
      await w.entry(v, rent, 100, 0);
      const r = await runPhase1PlSummary({ companyId: w.companyId, ...range, fmt });
      expect(r.stats.map((s) => [s.label, s.value, s.highlight])).toEqual([
        ["Revenue", "1000.00", "positive"],
        ["Cost of Goods Sold", "600.00", "muted"],
        ["Gross Profit", "400.00", "positive"],
        ["Operating Expenses", "100.00", "muted"],
        ["Net Profit / (Loss)", "300.00", "positive"],
      ]);
    }));

  it("marks negative revenue, gross and net as negative", () =>
    withReportWorld(async (w) => {
      const sales = await w.ledger("Sales Returns", "Income");
      const cogs = await w.ledger("Direct Cost", "Direct Expense");
      const v = await w.voucher("Journal", "2026-07-01");
      await w.entry(v, sales, 50, 0);
      await w.entry(v, cogs, 20, 0);
      const r = await runPhase1PlSummary({ companyId: w.companyId, ...range, fmt });
      expect(r.stats.map((s) => s.highlight)).toEqual(["negative", "muted", "negative", "muted", "negative"]);
    }));
});
