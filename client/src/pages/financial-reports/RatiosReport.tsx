import { useState } from "react";

import { ResponsiveMetricGrid } from "@/components/ui/responsive-report";
import { formatNumber } from "@/lib/formatNumber";

import {
  DateField,
  MetricCard,
  ReportState,
  ReportToolbar,
  StatementTable,
  reportUrl,
  useReport,
} from "./reportShared";

export interface RatiosResponse {
  ratios: { grossProfitMargin: number; netProfitMargin: number; currentRatio: number; debtToEquity: number };
  exact: {
    revenue: string;
    costOfSales: string;
    grossProfit: string;
    netProfit: string;
    currentAssets: string;
    currentLiabilities: string;
    totalAssets: string;
    totalLiabilities: string;
    netAssets: string;
  };
  filters: { startDate: string | null; endDate: string | null };
}

export default function RatiosReport() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const params = { startDate, endDate };
  const { data, isLoading, error } = useReport<RatiosResponse>(reportUrl("/api/reports/ratios", params));

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="report-ratios">
      <ReportToolbar exportPath={reportUrl("/api/reports/export/ratios", params)}>
        <DateField id="ratios-start" label="From" value={startDate} onChange={setStartDate} />
        <DateField id="ratios-end" label="To" value={endDate} onChange={setEndDate} />
      </ReportToolbar>
      <ReportState isLoading={isLoading} error={error}>
        {data ? (
          <>
            <ResponsiveMetricGrid>
              <MetricCard
                label="Gross profit margin %"
                value={formatNumber(data.ratios.grossProfitMargin, 2)}
                testId="metric-ratio-gross"
              />
              <MetricCard
                label="Net profit margin %"
                value={formatNumber(data.ratios.netProfitMargin, 2)}
                testId="metric-ratio-net"
              />
              <MetricCard
                label="Current ratio"
                value={formatNumber(data.ratios.currentRatio, 2)}
                testId="metric-ratio-current"
              />
              <MetricCard
                label="Debt to equity"
                value={formatNumber(data.ratios.debtToEquity, 2)}
                testId="metric-ratio-debt"
              />
            </ResponsiveMetricGrid>
            <StatementTable
              title="Underlying figures"
              testId="section-ratio-underlying"
              lines={[
                { key: "revenue", name: "Revenue", amount: data.exact.revenue },
                { key: "cos", name: "Cost of sales", amount: data.exact.costOfSales },
                { key: "gross", name: "Gross profit", amount: data.exact.grossProfit },
                { key: "net", name: "Net profit", amount: data.exact.netProfit },
                { key: "ca", name: "Current assets", amount: data.exact.currentAssets },
                { key: "cl", name: "Current liabilities", amount: data.exact.currentLiabilities },
                { key: "ta", name: "Total assets", amount: data.exact.totalAssets },
                { key: "tl", name: "Total liabilities", amount: data.exact.totalLiabilities },
                { key: "na", name: "Net assets", amount: data.exact.netAssets, emphasis: true },
              ]}
            />
          </>
        ) : null}
      </ReportState>
    </div>
  );
}
