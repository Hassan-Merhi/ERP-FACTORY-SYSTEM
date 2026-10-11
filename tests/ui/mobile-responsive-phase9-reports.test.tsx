import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatCard } from "@/components/StatCard";
import { ChartContainer } from "@/components/ui/chart";
import {
  ResponsiveChartDescription,
  ResponsiveChartHeader,
  ResponsiveChartPanel,
  ResponsiveChartTitle,
  ResponsiveChartViewport,
  ResponsiveLegendList,
  ResponsiveMetricGrid,
  ResponsiveReportGrid,
  ResponsiveReportPage,
} from "@/components/ui/responsive-report";
import { CategoryPieChart } from "@/pages/factory/dailyproductionreport/components/CategoryPieChart";
import { MiniPieChart } from "@/pages/factory/dailyproductionreport/components/MiniPieChart";

/** Phase 9 contract for dashboards and reports, checked on rendered output. */
afterEach(cleanup);

describe("Mobile responsiveness Phase 9 dashboards and reports", () => {
  it("lays out report pages with phone-first metric grids and chart panels", () => {
    render(
      <ResponsiveReportPage data-testid="page">
        <ResponsiveMetricGrid data-testid="metrics">
          <div>KPI</div>
        </ResponsiveMetricGrid>
        <ResponsiveReportGrid data-testid="grid">
          <ResponsiveChartPanel data-testid="panel">
            <ResponsiveChartHeader>
              <ResponsiveChartTitle>Sales by month</ResponsiveChartTitle>
              <ResponsiveChartDescription>Last twelve months</ResponsiveChartDescription>
            </ResponsiveChartHeader>
            <ResponsiveChartViewport data-testid="viewport">
              <svg width="600" height="200" />
            </ResponsiveChartViewport>
            <ResponsiveLegendList data-testid="legend">
              <li>Sales</li>
            </ResponsiveLegendList>
          </ResponsiveChartPanel>
        </ResponsiveReportGrid>
      </ResponsiveReportPage>
    );

    expect(screen.getByTestId("page")).toHaveAttribute("data-responsive-report-page", "true");
    expect(screen.getByTestId("metrics")).toHaveAttribute("data-responsive-metric-grid", "true");
    expect(screen.getByTestId("metrics").className).toMatch(/min-\[420px\]:grid-cols-2/);
    expect(screen.getByTestId("panel")).toHaveAttribute("data-responsive-chart-panel", "true");
    const viewport = screen.getByTestId("viewport");
    expect(viewport).toHaveAttribute("data-responsive-chart-viewport", "true");
    // Wide charts scroll sideways inside their panel instead of widening the page.
    expect(viewport.className).toContain("overflow-x-auto");
    expect(viewport.className).toContain("overscroll-x-contain");
    expect(screen.getByTestId("legend")).toHaveAttribute("data-responsive-chart-legend", "true");
  });

  it("keeps the shared chart container measurable, labelled and readable on phones", () => {
    render(
      <ChartContainer config={{ sales: { label: "Sales", color: "#123456" } }} chartLabel="Sales chart">
        <svg />
      </ChartContainer>
    );
    const chart = screen.getByRole("img", { name: "Sales chart" });
    expect(chart).toHaveAttribute("data-responsive-chart", "true");
    // A fixed phone height, then the aspect ratio from sm; never wider than its column.
    expect(chart.className).toContain("h-64");
    expect(chart.className).toContain("min-w-0");
    expect(chart.className).toContain("max-w-full");
    expect(chart.className).toContain("sm:aspect-video");
  });

  it("keeps KPI cards inside their column and operable from the keyboard", () => {
    const onClick = vi.fn();
    render(<StatCard title="Receivable" value="$ 1,234,567.00" onClick={onClick} />);
    const card = screen.getByRole("button", { name: "Receivable: $ 1,234,567.00" });
    expect(card).toHaveAttribute("data-responsive-stat-card", "true");
    expect(card).toHaveAttribute("tabindex", "0");
    expect(card.className).toContain("min-w-0");
    const value = screen.getByText("$ 1,234,567.00");
    expect(value.className).toContain("wrap-break-word");
    expect(value.className).toMatch(/min-\[360px\]:text-2xl/);
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(card, { key: "a" });
    expect(onClick).toHaveBeenCalledTimes(2);

    cleanup();
    render(<StatCard title="Payable" value="10" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the Factory production pie charts as responsive panels with legends", () => {
    const rows = [
      { categoryName: "Cotton", totalWeightKg: 120 },
      { categoryName: "Wool", totalWeightKg: 80 },
    ];
    render(
      <>
        <CategoryPieChart byCategory={rows} wipersGarbageKg={5} />
        <MiniPieChart
          title="Mix"
          allRows={rows}
          classifyFn={(name) => name}
          order={["Cotton", "Wool"]}
          colors={{ Cotton: "#111", Wool: "#222" }}
          testId="mini-pie"
        />
      </>
    );
    const panels = document.querySelectorAll("[data-responsive-chart-panel]");
    expect(panels.length).toBeGreaterThanOrEqual(2);
    for (const panel of Array.from(panels)) {
      const viewport = panel.querySelector("[data-responsive-chart-viewport]") as HTMLElement;
      expect(viewport).toHaveAttribute("role", "region");
      expect(viewport.getAttribute("aria-label")).toMatch(/pie chart/i);
      const legend = panel.querySelector("[data-responsive-chart-legend]") as HTMLElement;
      expect(legend).not.toBeNull();
      expect(within(legend).getAllByRole("listitem").length).toBeGreaterThanOrEqual(1);
    }
    expect(screen.getByTestId("mini-pie")).toBeInTheDocument();
  });

  it("keeps responsive visualization primitives free from report mutations", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(
      <ResponsiveReportPage>
        <ResponsiveMetricGrid>
          <StatCard title="A" value="1" />
        </ResponsiveMetricGrid>
        <ChartContainer config={{}}>
          <svg />
        </ChartContainer>
      </ResponsiveReportPage>
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
