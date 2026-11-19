#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");

const report = await read("client/src/components/ui/responsive-report.tsx");
const chart = await read("client/src/components/ui/chart.tsx");
const statCard = await read("client/src/components/StatCard.tsx");
const categoryPie = await read("client/src/pages/factory/dailyproductionreport/components/CategoryPieChart.tsx");
const miniPie = await read("client/src/pages/factory/dailyproductionreport/components/MiniPieChart.tsx");
const failures = [];

for (const token of [
  "ResponsiveReportPage",
  "ResponsiveMetricGrid",
  "ResponsiveReportGrid",
  "ResponsiveChartPanel",
  "ResponsiveChartViewport",
  "ResponsiveLegendList",
  'data-responsive-chart-viewport="true"',
  "overflow-x-auto overscroll-x-contain",
]) {
  if (!report.includes(token)) failures.push(`Responsive report contract missing: ${token}`);
}

for (const token of [
  'data-responsive-chart="true"',
  'role="img"',
  "h-64 w-full min-w-0 max-w-full",
  "minWidth={0}",
  "minHeight={1}",
  "max-w-[min(20rem,calc(100vw-2rem))]",
  "flex-wrap items-center justify-center",
]) {
  if (!chart.includes(token)) failures.push(`Shared chart contract missing: ${token}`);
}

for (const token of [
  'data-responsive-stat-card="true"',
  "min-w-0 max-w-full",
  "wrap-break-word",
  "min-[360px]:text-2xl",
  'role={isClickable ? "button" : undefined}',
]) {
  if (!statCard.includes(token)) failures.push(`Responsive KPI contract missing: ${token}`);
}

for (const [name, contents] of [
  ["CategoryPieChart", categoryPie],
  ["MiniPieChart", miniPie],
]) {
  for (const token of [
    "ResponsiveChartPanel",
    "ResponsiveChartViewport",
    "ResponsiveLegendList",
    "grid-cols-1",
    "minWidth={0}",
    "minHeight={1}",
  ]) {
    if (!contents.includes(token)) failures.push(`${name} mobile contract missing: ${token}`);
  }
}

for (const contents of [report, chart, statCard]) {
  for (const forbidden of ["useMutation(", "queryClient", 'fetch("/api/', "apiRequest(", "costPerKg"]) {
    if (contents.includes(forbidden)) failures.push(`Shared visualization primitive contains business logic: ${forbidden}`);
  }
}

if (failures.length) {
  console.error("Mobile responsiveness Phase 9 verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      phase: 9,
      status: "implemented",
      protectedContracts: 38,
      sqlRequired: false,
    },
    null,
    2
  )
);
