import { useState } from "react";

import { ResponsiveMetricGrid } from "@/components/ui/responsive-report";

import {
  Amount,
  DateField,
  FutureDatedNotice,
  MetricCard,
  ReportState,
  ReportToolbar,
  StatementTable,
  reportUrl,
  useReport,
  type FutureDated,
} from "./reportShared";

interface Item {
  id: number;
  code: string;
  name: string;
  balance: number;
}

interface Sections {
  revenue: string;
  costOfSales: string;
  grossProfit: string;
  otherIncome: string;
  operatingExpenses: string;
  netProfit: string;
}

interface ProfitLossBody {
  incomeItems: Item[];
  expenseItems: Item[];
  sections: Sections;
  startDate: string | null;
  endDate: string | null;
}

export interface ProfitLossResponse extends ProfitLossBody {
  businessDate: string;
  futureDated: FutureDated;
  comparative: ProfitLossBody | null;
}

function itemLines(items: Item[], compare: Item[] | undefined) {
  const compared = new Map((compare ?? []).map((item) => [item.id, item.balance] as const));
  return items.map((item) => ({
    key: String(item.id),
    code: item.code,
    name: item.name,
    amount: item.balance,
    compare: compare ? (compared.get(item.id) ?? 0) : null,
  }));
}

export default function ProfitLossReport() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [compareStartDate, setCompareStartDate] = useState("");
  const [compareEndDate, setCompareEndDate] = useState("");
  const params = { startDate, endDate, compareStartDate, compareEndDate };
  const { data, isLoading, error } = useReport<ProfitLossResponse>(reportUrl("/api/reports/profit-loss", params));
  const compare = data?.comparative ?? null;
  const compareLabel = compare ? "Comparative" : null;
  const s = data?.sections;
  const cs = compare?.sections;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="report-profit-loss">
      <ReportToolbar exportPath={reportUrl("/api/reports/export/profit-loss", { startDate, endDate })}>
        <DateField id="pl-start" label="From" value={startDate} onChange={setStartDate} />
        <DateField id="pl-end" label="To" value={endDate} onChange={setEndDate} />
        <DateField id="pl-compare-start" label="Compare from" value={compareStartDate} onChange={setCompareStartDate} />
        <DateField id="pl-compare-end" label="Compare to" value={compareEndDate} onChange={setCompareEndDate} />
      </ReportToolbar>
      <ReportState isLoading={isLoading} error={error}>
        {data && s ? (
          <>
            <p className="text-sm text-muted-foreground" data-testid="text-pl-period">
              {`Period ${data.startDate ?? ""} to ${data.endDate ?? data.businessDate}`}
            </p>
            <FutureDatedNotice futureDated={data.futureDated} />
            <ResponsiveMetricGrid>
              <MetricCard label="Revenue" value={<Amount value={s.revenue} />} testId="metric-pl-revenue" />
              <MetricCard label="Gross profit" value={<Amount value={s.grossProfit} />} testId="metric-pl-gross" />
              <MetricCard label="Net profit" value={<Amount value={s.netProfit} />} testId="metric-pl-net" />
            </ResponsiveMetricGrid>
            <StatementTable
              title="Income"
              testId="section-income"
              compareLabel={compareLabel}
              lines={itemLines(data.incomeItems, compare?.incomeItems)}
            />
            <StatementTable
              title="Expenses"
              testId="section-expenses"
              compareLabel={compareLabel}
              lines={itemLines(data.expenseItems, compare?.expenseItems)}
            />
            <StatementTable
              title="Summary"
              testId="section-pl-summary"
              compareLabel={compareLabel}
              lines={[
                { key: "revenue", name: "Revenue", amount: s.revenue, compare: cs?.revenue ?? null },
                { key: "cos", name: "Cost of sales", amount: s.costOfSales, compare: cs?.costOfSales ?? null },
                {
                  key: "gross",
                  name: "Gross profit",
                  amount: s.grossProfit,
                  compare: cs?.grossProfit ?? null,
                  emphasis: true,
                },
                { key: "other", name: "Other income", amount: s.otherIncome, compare: cs?.otherIncome ?? null },
                {
                  key: "opex",
                  name: "Operating expenses",
                  amount: s.operatingExpenses,
                  compare: cs?.operatingExpenses ?? null,
                },
                { key: "net", name: "Net profit", amount: s.netProfit, compare: cs?.netProfit ?? null, emphasis: true },
              ]}
            />
          </>
        ) : null}
      </ReportState>
    </div>
  );
}
