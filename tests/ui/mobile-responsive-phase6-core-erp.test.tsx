import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CoreErpFilterGrid,
  CoreErpHeader,
  CoreErpHeaderActions,
  CoreErpPage,
  CoreErpSummaryGrid,
  CoreErpSummaryItem,
  CoreErpSummaryLabel,
  CoreErpSummaryValue,
} from "@/components/ui/core-erp-mobile";
import { PeriodFilter, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DaybookFilters } from "@/pages/daybook/DaybookFilters";
import { renderWithProviders } from "./helpers";
import { pageState, resetPageState, stubFetchRoutes } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);
vi.mock("@/contexts/ConnectivityContext", async () => (await import("./pageMocks")).connectivityMock);
vi.mock("@/contexts/LocationContext", async () => (await import("./pageMocks")).locationContextMock);
vi.mock("@/contexts/CursorNavContext", async () => (await import("./pageMocks")).cursorNavMock);

/** Phase 6 contract for the core ERP page layouts, checked on rendered output. */
beforeEach(() => {
  resetPageState();
  stubFetchRoutes();
});
afterEach(cleanup);

describe("Mobile responsiveness Phase 6 core ERP", () => {
  it("lays out core ERP pages with a header, wrapping actions, a filter grid and a summary grid", () => {
    render(
      <CoreErpPage data-testid="page">
        <CoreErpHeader data-testid="header">
          <h1>Daybook</h1>
          <CoreErpHeaderActions data-testid="actions">
            <button type="button">Export</button>
            <button type="button">Print</button>
          </CoreErpHeaderActions>
        </CoreErpHeader>
        <CoreErpFilterGrid data-testid="filters" label="Daybook filters">
          <input aria-label="Search" />
        </CoreErpFilterGrid>
        <CoreErpSummaryGrid data-testid="summary">
          <CoreErpSummaryItem>
            <CoreErpSummaryLabel>Debit</CoreErpSummaryLabel>
            <CoreErpSummaryValue>1,000</CoreErpSummaryValue>
          </CoreErpSummaryItem>
        </CoreErpSummaryGrid>
      </CoreErpPage>
    );

    expect(screen.getByTestId("page")).toHaveAttribute("data-core-erp-page", "true");
    expect(screen.getByTestId("header")).toHaveAttribute("data-core-erp-header", "true");
    expect(screen.getByTestId("actions")).toHaveAttribute("data-core-erp-actions", "true");
    expect(screen.getByTestId("filters")).toHaveAttribute("data-core-erp-filters", "true");
    expect(screen.getByTestId("summary")).toHaveAttribute("data-core-erp-summary", "true");
    // Filters and summary tiles are one column on the narrowest phones and two from 360/420px.
    expect(screen.getByTestId("filters").className).toMatch(/grid-cols-1/);
    expect(screen.getByTestId("filters").className).toMatch(/min-\[(360|420)px\]:grid-cols-2/);
    expect(screen.getByTestId("summary").className).toMatch(/min-\[(360|420)px\]:grid-cols-2/);
    // The filter grid is a labelled search landmark.
    expect(screen.getByRole("search", { name: "Daybook filters" })).toBe(screen.getByTestId("filters"));
  });

  it("renders core ERP tabs as a sideways-scrolling, touch-sized tab list", () => {
    const onChange = vi.fn();
    render(
      <Tabs value="entries" onValueChange={onChange}>
        <TabsList aria-label="Daybook sections">
          <TabsTrigger value="entries">Entries</TabsTrigger>
          <TabsTrigger value="summary">Summary</TabsTrigger>
        </TabsList>
        <TabsContent value="entries">rows</TabsContent>
      </Tabs>
    );

    const list = screen.getByRole("tablist", { name: "Daybook sections" });
    expect(list).toHaveAttribute("data-responsive-tabs", "true");
    expect(list.className).toContain("overflow-x-auto");
    expect(list.className).toContain("touch-pan-x");
    const [entries, summary] = screen.getAllByRole("tab");
    expect(entries).toHaveAttribute("aria-selected", "true");
    expect(summary).toHaveAttribute("aria-selected", "false");
    expect(summary.className).toMatch(/\bmin-h-11\b/);
    fireEvent.click(summary);
    expect(onChange).toHaveBeenCalledWith("summary");
  });

  it("keeps the period filter menu inside the phone width", () => {
    render(<PeriodFilter value={getDefaultPeriodValue()} onChange={vi.fn()} />);
    fireEvent.pointerDown(screen.getByTestId("period-filter-dropdown"), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByTestId("period-filter-dropdown"));
    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("max-w-[calc(100vw-1rem)]");
    expect(within(menu).getByTestId("period-preset-today")).toBeInTheDocument();
  });

  it("renders Daybook filters inside the shared filter grid without changing filter behaviour", () => {
    const setFilters = vi.fn();
    renderWithProviders(
      <DaybookFilters
        periodFilter={getDefaultPeriodValue()}
        setPeriodFilter={vi.fn()}
        filters={{ voucherType: "all", searchQuery: "", sortOrder: "desc", statusFilter: "all" } as any}
        setFilters={setFilters}
      />
    );

    const grid = screen.getByRole("search", { name: "Daybook filters" });
    expect(grid).toHaveAttribute("data-core-erp-filters", "true");
    expect(within(grid).getByTestId("select-voucher-type")).toBeInTheDocument();
    expect(within(grid).getByTestId("select-status-filter")).toBeInTheDocument();
    const search = within(grid).getByTestId("input-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "rent" } });
    expect(setFilters).toHaveBeenCalled();
    const next = setFilters.mock.calls[0][0];
    const resolved =
      typeof next === "function"
        ? next({ voucherType: "all", searchQuery: "", sortOrder: "desc", statusFilter: "all" })
        : next;
    expect(resolved).toMatchObject({ searchQuery: "rent", sortOrder: "desc" });
  });

  it("mounts stock item history on the shared page, summary and data-list contracts", async () => {
    pageState.params = { id: "7" };
    stubFetchRoutes({
      "/api/stock-items/7/monthly-summary": {
        stockItem: { id: 7, name: "Cotton Bale", uom: "kg" },
        year: 2026,
        monthlyData: [
          {
            month: 1,
            monthName: "January",
            inwardQty: 10,
            outwardQty: 4,
            closingQty: 6,
            inwardValue: 100,
            outwardValue: 40,
            closingValue: 60,
          },
        ],
        grandTotal: {
          inwardQty: 10,
          inwardValue: 100,
          outwardQty: 4,
          outwardValue: 40,
          closingQty: 6,
          closingValue: 60,
        },
      },
      "/api/stock-items/7": { id: 7, name: "Cotton Bale" },
    });
    const { default: StockItemHistory } = await import("@/pages/StockItemHistory");
    renderWithProviders(<StockItemHistory />);

    expect(document.querySelector("[data-core-erp-page]")).not.toBeNull();
    expect(await screen.findByTestId("select-year")).toBeInTheDocument();
    // The month table is a labelled scroll region; the phone list is the semantic data list.
    const region = await screen.findByRole("region", { name: "Stock item monthly summary" });
    expect(region).toHaveAttribute("data-table-scroll-region", "true");
    expect((await screen.findAllByText(/January/)).length).toBeGreaterThan(0);
    expect(document.querySelector("[data-core-erp-summary]")).not.toBeNull();
    const list = document.querySelector("[data-mobile-data-list]") as HTMLElement;
    expect(list).not.toBeNull();
    // Phone list, hidden from md but back on landscape phones.
    expect((list.parentElement as HTMLElement).className).toContain("md:hidden phone-land:block");
  });
});
