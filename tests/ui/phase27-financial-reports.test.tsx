/**
 * Phase 27 (RP-1): the financial statement pages render the services' exact
 * figures, flag future-dated vouchers and a difference, and offer the Excel and
 * PDF exports built from the same request.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BalanceSheetReport from "@/pages/financial-reports/BalanceSheetReport";
import CashFlowReport from "@/pages/financial-reports/CashFlowReport";
import TrialBalanceReport from "@/pages/financial-reports/TrialBalanceReport";
import AgingReport from "@/pages/financial-reports/AgingReport";
import RatiosReport from "@/pages/financial-reports/RatiosReport";
import ProfitLossReport from "@/pages/financial-reports/ProfitLossReport";
import FinancialReports, { FINANCIAL_REPORT_TABS } from "@/pages/FinancialReports";
import { reportUrl } from "@/pages/financial-reports/reportShared";

import { renderWithProviders } from "./helpers";

const futureDated = {
  businessDate: "2026-10-11",
  count: 1,
  vouchers: [{ id: 9, voucherNumber: "JV-FUTURE", voucherType: "Journal", bookedOn: "2026-11-10" }],
};
const columns = (od: string, oc: string, pd: string, pc: string, cd: string, cc: string) => ({
  openingDebit: od,
  openingCredit: oc,
  periodDebit: pd,
  periodCredit: pc,
  closingDebit: cd,
  closingCredit: cc,
});
const section = (lines: unknown[], total: string) => ({ lines, total });

const payloads: Record<string, unknown> = {
  "/api/reports/trial-balance": {
    from: "2026-01-01",
    to: "2026-10-11",
    toDefaulted: true,
    comparison: "none",
    comparativePeriod: null,
    rows: [
      {
        kind: "ledger",
        id: 1,
        code: "1000",
        name: "Cash",
        accountType: "Cash",
        ...columns("500.00", "0.00", "1250.00", "0.00", "1750.00", "0.00"),
        comparative: null,
      },
    ],
    totals: columns("500.00", "0.00", "1250.00", "0.00", "1750.00", "0.00"),
    comparativeTotals: null,
    unexplainedDifference: "40.00",
    balanced: false,
    futureDated,
  },
  "/api/reports/balance-sheet": {
    asOfDate: "2026-10-11",
    asOfDefaulted: true,
    businessDate: "2026-10-11",
    futureDated,
    comparative: null,
    fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
    difference: "0.00",
    equity: {
      lines: [{ kind: "ledger", id: 4, code: "3000", name: "Capital", balance: "200.00" }],
      currentEarnings: "520.00",
      retainedEarnings: "500.00",
      total: "1220.00",
    },
    unclassified: section([], "0.00"),
    classified: {
      currentAssets: section([{ kind: "ledger", id: 1, code: "1000", name: "Cash", balance: "1750.00" }], "1750.00"),
      nonCurrentAssets: section([], "0.00"),
      currentLiabilities: section(
        [{ kind: "bank", id: 2, code: "B1", name: "Overdrawn bank", balance: "100.00" }],
        "100.00"
      ),
      nonCurrentLiabilities: section([], "0.00"),
      totals: { assets: "1750.00", liabilities: "100.00", equity: "1220.00", netAssets: "1650.00", cash: "1650.00" },
    },
  },
  "/api/reports/cash-flow": {
    from: "2026-01-01",
    to: "2026-10-11",
    operating: {
      netProfit: "520.00",
      depreciation: section([], "0.00"),
      workingCapital: section([], "0.00"),
      total: "520.00",
    },
    investing: section([], "0.00"),
    financing: section([], "0.00"),
    unclassified: section([], "0.00"),
    computedNetChange: "520.00",
    cash: { opening: "500.00", closing: "1020.00", netChange: "520.00", accounts: [] },
    difference: "0.00",
  },
  "/api/reports/aging?kind=customer": {
    kind: "customer",
    referenceDate: "2026-10-11",
    parties: [
      { id: 3, code: "C1", name: "Customer One", balance: "60.00", buckets: { notDue: "60.00", over90: "0.00" } },
    ],
    totals: { balance: "60.00", buckets: { notDue: "60.00", over90: "0.00" } },
    controlTieOut: { engineTotal: "60.00", agingTotal: "60.00", difference: "0.00", tied: true },
  },
  "/api/reports/ratios": {
    ratios: { grossProfitMargin: 60, netProfitMargin: 49.05, currentRatio: 2.79, debtToEquity: 0.82 },
    exact: {
      revenue: "1000.00",
      costOfSales: "400.00",
      grossProfit: "600.00",
      netProfit: "520.00",
      currentAssets: "1950.00",
      currentLiabilities: "700.00",
      totalAssets: "2220.00",
      totalLiabilities: "1000.00",
      netAssets: "1220.00",
    },
    filters: { startDate: null, endDate: null },
  },
  "/api/reports/profit-loss": {
    incomeItems: [{ id: 5, code: "4000", name: "Sales", balance: 1000 }],
    expenseItems: [{ id: 6, code: "5000", name: "Rent", balance: 480 }],
    sections: {
      revenue: "1000.00",
      costOfSales: "0.00",
      grossProfit: "1000.00",
      otherIncome: "0.00",
      operatingExpenses: "480.00",
      netProfit: "520.00",
    },
    startDate: "2026-01-01",
    endDate: "2026-10-11",
    businessDate: "2026-10-11",
    futureDated: { businessDate: "2026-10-11", count: 0, vouchers: [] },
    comparative: null,
  },
};

const requested: string[] = [];

beforeEach(() => {
  requested.length = 0;
  (global as any).fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const body = url.startsWith("/api/reports/export/") ? {} : payloads[url];
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      json: async () => body ?? { message: "not found" },
      blob: async () => new Blob(["x"]),
      headers: new Headers({ "Content-Disposition": 'attachment; filename="Trial_Balance.xlsx"' }),
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("financial statement pages", () => {
  it("builds report URLs from the defined parameters only", () => {
    expect(reportUrl("/api/reports/trial-balance", { from: "", to: "2026-10-11", compare: null })).toBe(
      "/api/reports/trial-balance?to=2026-10-11"
    );
    expect(reportUrl("/api/reports/cash-flow", {})).toBe("/api/reports/cash-flow");
  });

  it("shows the trial balance, its difference and the future-dated voucher", async () => {
    renderWithProviders(<TrialBalanceReport />);
    expect(await screen.findByTestId("row-tb-ledger-1")).toHaveTextContent("Cash");
    expect(screen.getByTestId("notice-future-dated")).toHaveTextContent("JV-FUTURE");
    expect(screen.getByTestId("notice-difference")).toHaveTextContent("Unexplained difference: 40");
    expect(screen.getByTestId("row-tb-total")).toHaveTextContent("1,750");
  });

  it("downloads the Excel export of the same request", async () => {
    const createObjectURL = vi.fn(() => "blob:report");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    renderWithProviders(<TrialBalanceReport />);
    await screen.findByTestId("row-tb-ledger-1");
    fireEvent.click(screen.getByTestId("button-export-xlsx"));
    await waitFor(() => expect(requested).toContain("/api/reports/export/trial-balance?format=xlsx"));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  });

  it("shows the classified balance sheet with the overdrawn bank as a liability and the earnings split", async () => {
    renderWithProviders(<BalanceSheetReport />);
    const liabilities = await screen.findByTestId("section-current-liabilities");
    expect(liabilities).toHaveTextContent("Overdrawn bank");
    const equity = screen.getByTestId("section-equity");
    expect(equity).toHaveTextContent("Retained earnings (not yet closed)");
    expect(equity).toHaveTextContent("Retained earnings (not yet closed)500");
    expect(equity).toHaveTextContent("Current year earnings");
    expect(screen.getByTestId("metric-bs-net-assets")).toHaveTextContent("1,650");
  });

  it("shows the cash flow, aging, ratios and P&L", async () => {
    const { unmount } = renderWithProviders(<CashFlowReport />);
    expect(await screen.findByTestId("metric-cf-closing")).toHaveTextContent("1,020");
    unmount();
    const aging = renderWithProviders(<AgingReport />);
    expect(await screen.findByTestId("row-aging-3")).toHaveTextContent("Customer One");
    expect(screen.queryByTestId("notice-difference")).toBeNull();
    aging.unmount();
    const ratios = renderWithProviders(<RatiosReport />);
    expect(await screen.findByTestId("metric-ratio-current")).toHaveTextContent("2.79");
    ratios.unmount();
    renderWithProviders(<ProfitLossReport />);
    expect(await screen.findByTestId("section-pl-summary")).toHaveTextContent("520");
    expect(screen.queryByTestId("notice-future-dated")).toBeNull();
  });

  it("lists every statement as a tab on the hub page", async () => {
    window.history.replaceState({}, "", "/financial-reports?tab=balance-sheet");
    renderWithProviders(<FinancialReports />);
    for (const tab of FINANCIAL_REPORT_TABS) expect(screen.getByTestId(`tab-${tab.key}`)).toBeInTheDocument();
    expect(await screen.findByTestId("report-balance-sheet")).toBeInTheDocument();
  });
});
