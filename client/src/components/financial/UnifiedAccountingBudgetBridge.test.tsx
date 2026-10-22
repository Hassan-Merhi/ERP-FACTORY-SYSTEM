import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A plain recorder rather than vi.fn(): Vitest reports a rejection produced by
// a mock implementation as a test failure even when React Query handles it.
const reader = vi.hoisted(() => ({
  calls: [] as string[],
  respond: (_path: string): Promise<unknown> => Promise.resolve(undefined),
}));
vi.mock("@/api/costCentersApi", () => ({
  readCostCenterApi: (path: string) => {
    reader.calls.push(path);
    return reader.respond(path);
  },
}));

import { UnifiedAccountingBudgetBridge } from "./UnifiedAccountingBudgetBridge";

const COMPANY = 7;
const FROM = "2026-09-01";
const AS_OF = "2026-09-30";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    scope: "company",
    companyIds: [COMPANY],
    currency: "USD",
    period: { from: FROM, to: AS_OF, budgetBasis: "whole_calendar_months" },
    totals: {
      expense: "1234.560000",
      inventoryCost: "50.000000",
      budget: "1000.000000",
      unallocated: "10.000000",
      recognizedExpense: "1244.560000",
      variance: "244.560000",
      unallocatedApplicable: true,
    },
    centers: [
      {
        companyId: COMPANY,
        costCenterId: 1,
        code: "CC-ADMIN",
        name: "Administration",
        expense: "1234.560000",
        budget: "1000.000000",
        variance: "234.560000",
        inventoryCost: "50.000000",
        utilization: "123.46",
      },
    ],
    months: [],
    ...overrides,
  };
}

function renderBridge(mode: "erp" | "factory" | "properties") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UnifiedAccountingBudgetBridge
        companyId={COMPANY}
        fromDate={FROM}
        asOfDate={AS_OF}
        mode={mode}
        onOpenCostCenters={() => undefined}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  reader.calls = [];
  reader.respond = () => Promise.resolve(summary());
});
afterEach(() => cleanup());

describe("UnifiedAccountingBudgetBridge", () => {
  it("makes no cost-center request and shows no budget in Properties/Rentals", async () => {
    renderBridge("properties");
    expect(screen.getByText(/does not have a native cost-center workspace/)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reader.calls).toEqual([]);
    expect(screen.queryByText("Whole-month budget")).toBeNull();
  });

  it("reads the single-company ERP summary and Factory from its own boundary", async () => {
    renderBridge("erp");
    await screen.findByText(/Administration/);
    expect(reader.calls).toContain(`/api/cost-centers/reports/summary?fromDate=${FROM}&toDate=${AS_OF}&treatment=ALL`);
    cleanup();
    renderBridge("factory");
    await waitFor(() =>
      expect(reader.calls).toContain(
        `/api/factory/cost-centers/reports/summary?fromDate=${FROM}&toDate=${AS_OF}&treatment=ALL`
      )
    );
    for (const call of reader.calls) expect(call).not.toContain("consolidated");
  });

  it.each([
    ["a consolidated response", { scope: "consolidated", companyIds: [COMPANY, 8] }],
    ["a consolidated scope naming only this company", { scope: "consolidated" }],
    ["another company", { companyIds: [8] }],
    ["a non-USD currency", { currency: "EUR" }],
    ["mismatched dates", { period: { from: "2026-08-01", to: AS_OF, budgetBasis: "whole_calendar_months" } }],
  ])("withholds every total for %s", async (_label, overrides) => {
    reader.respond = () => Promise.resolve(summary(overrides));
    renderBridge("erp");
    expect(await screen.findByText(/Analytical totals are\s+withheld/)).toBeInTheDocument();
    expect(screen.queryByText(/Administration/)).toBeNull();
    expect(screen.queryByText("Whole-month budget")).toBeNull();
  });

  it("shows an explicit error instead of estimating when the report is unavailable", async () => {
    reader.respond = () => Promise.reject(new Error("503: cost centers schema missing"));
    renderBridge("erp");
    expect(await screen.findByRole("alert")).toHaveTextContent("No budget values were estimated");
    expect(screen.queryByText("Whole-month budget")).toBeNull();
  });

  it("states an empty company plainly", async () => {
    reader.respond = () => Promise.resolve(summary({ centers: [] }));
    renderBridge("erp");
    expect(await screen.findByText("No cost centers have been configured for this company.")).toBeInTheDocument();
  });
});
