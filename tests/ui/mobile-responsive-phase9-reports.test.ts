import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Mobile responsiveness Phase 9 dashboards and reports", () => {
  it("provides reusable dashboard, report, chart, and legend layouts", () => {
    const report = source("client/src/components/ui/responsive-report.tsx");

    for (const token of [
      "ResponsiveReportPage",
      "ResponsiveMetricGrid",
      "ResponsiveReportGrid",
      "ResponsiveChartPanel",
      "ResponsiveChartViewport",
      "ResponsiveChartHeader",
      "ResponsiveChartTitle",
      "ResponsiveChartDescription",
      "ResponsiveLegendList",
      'data-responsive-report-page="true"',
      'data-responsive-metric-grid="true"',
      'data-responsive-chart-panel="true"',
      'data-responsive-chart-viewport="true"',
      "overflow-x-auto overscroll-x-contain",
      "min-[420px]:grid-cols-2",
    ]) {
      expect(report).toContain(token);
    }
  });

  it("keeps the shared chart container measurable and readable on phones", () => {
    const chart = source("client/src/components/ui/chart.tsx");

    for (const token of [
      'data-responsive-chart="true"',
      'role="img"',
      'chartLabel = "Data visualization"',
      "h-64 w-full min-w-0 max-w-full",
      "minWidth={0}",
      "minHeight={1}",
      "max-w-[min(20rem,calc(100vw-2rem))]",
      "flex-wrap items-center justify-center",
      "wrap-break-word",
    ]) {
      expect(chart).toContain(token);
    }
  });

  it("prevents KPI values and labels from forcing horizontal overflow", () => {
    const statCard = source("client/src/components/StatCard.tsx");

    for (const token of [
      'data-responsive-stat-card="true"',
      "min-w-0 max-w-full",
      "wrap-break-word",
      "min-[360px]:text-2xl",
      'role={isClickable ? "button" : undefined}',
      'event.key !== "Enter"',
      'event.key !== " "',
    ]) {
      expect(statCard).toContain(token);
    }
  });

  it("converts Factory production pie charts to responsive panels", () => {
    const categoryPie = source("client/src/pages/factory/dailyproductionreport/components/CategoryPieChart.tsx");
    const miniPie = source("client/src/pages/factory/dailyproductionreport/components/MiniPieChart.tsx");

    for (const contents of [categoryPie, miniPie]) {
      expect(contents).toContain("ResponsiveChartPanel");
      expect(contents).toContain("ResponsiveChartViewport");
      expect(contents).toContain("ResponsiveLegendList");
      expect(contents).toContain("grid-cols-1");
      expect(contents).toContain("minWidth={0}");
      expect(contents).toContain("minHeight={1}");
      expect(contents).not.toContain("flex items-start gap-3");
    }
  });

  it("keeps responsive visualization primitives free from report mutations", () => {
    const sharedSources = [
      source("client/src/components/ui/responsive-report.tsx"),
      source("client/src/components/ui/chart.tsx"),
      source("client/src/components/StatCard.tsx"),
    ];

    for (const contents of sharedSources) {
      for (const forbidden of ["useMutation(", "queryClient", 'fetch("/api/', "apiRequest(", "costPerKg"]) {
        expect(contents).not.toContain(forbidden);
      }
    }
  });
});
