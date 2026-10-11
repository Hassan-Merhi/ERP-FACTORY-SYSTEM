import { useState } from "react";

import { ResponsiveMetricGrid } from "@/components/ui/responsive-report";

import {
  Amount,
  DateField,
  DifferenceNotice,
  MetricCard,
  ReportState,
  ReportToolbar,
  StatementTable,
  reportUrl,
  useReport,
  type StatementLine,
} from "./reportShared";

interface FlowLine {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  amount: string;
}

interface FlowSection {
  lines: FlowLine[];
  total: string;
}

export interface CashFlowResponse {
  from: string;
  to: string;
  operating: { netProfit: string; depreciation: FlowSection; workingCapital: FlowSection; total: string };
  investing: FlowSection;
  financing: FlowSection;
  unclassified: FlowSection;
  computedNetChange: string;
  cash: { opening: string; closing: string; netChange: string; accounts: FlowLine[] };
  difference: string;
}

const flowLines = (section: FlowSection): StatementLine[] =>
  section.lines.map((line) => ({
    key: `${line.kind}:${line.id ?? line.name}`,
    code: line.code,
    name: line.name,
    amount: line.amount,
  }));

export default function CashFlowReport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const params = { from, to };
  const { data, isLoading, error } = useReport<CashFlowResponse>(reportUrl("/api/reports/cash-flow", params));

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="report-cash-flow">
      <ReportToolbar exportPath={reportUrl("/api/reports/export/cash-flow", params)}>
        <DateField id="cf-from" label="From" value={from} onChange={setFrom} />
        <DateField id="cf-to" label="To" value={to} onChange={setTo} />
      </ReportToolbar>
      <ReportState isLoading={isLoading} error={error}>
        {data ? (
          <>
            <p className="text-sm text-muted-foreground" data-testid="text-cf-period">
              {`Period ${data.from} to ${data.to}`}
            </p>
            <p className="text-xs text-muted-foreground">
              Indirect method. Cash is the bank accounts and the Cash/Bank ledger accounts.
            </p>
            <DifferenceNotice difference={data.difference} label="Difference (unbalanced lines)" />
            <ResponsiveMetricGrid>
              <MetricCard
                label="Cash at the start"
                value={<Amount value={data.cash.opening} />}
                testId="metric-cf-opening"
              />
              <MetricCard
                label="Net change in cash"
                value={<Amount value={data.cash.netChange} />}
                testId="metric-cf-change"
              />
              <MetricCard
                label="Cash at the end"
                value={<Amount value={data.cash.closing} />}
                testId="metric-cf-closing"
              />
            </ResponsiveMetricGrid>
            <StatementTable
              title="Operating activities"
              testId="section-cf-operating"
              lines={[
                { key: "net-profit", name: "Net profit", amount: data.operating.netProfit },
                ...flowLines(data.operating.depreciation),
                ...flowLines(data.operating.workingCapital),
                {
                  key: "total",
                  name: "Net cash from operating activities",
                  amount: data.operating.total,
                  emphasis: true,
                },
              ]}
            />
            <StatementTable
              title="Investing activities"
              testId="section-cf-investing"
              lines={[
                ...flowLines(data.investing),
                {
                  key: "total",
                  name: "Net cash from investing activities",
                  amount: data.investing.total,
                  emphasis: true,
                },
              ]}
            />
            <StatementTable
              title="Financing activities"
              testId="section-cf-financing"
              lines={[
                ...flowLines(data.financing),
                {
                  key: "total",
                  name: "Net cash from financing activities",
                  amount: data.financing.total,
                  emphasis: true,
                },
              ]}
            />
            {data.unclassified.lines.length > 0 ? (
              <StatementTable
                title="Unclassified"
                testId="section-cf-unclassified"
                lines={[
                  ...flowLines(data.unclassified),
                  { key: "total", name: "Total unclassified", amount: data.unclassified.total, emphasis: true },
                ]}
              />
            ) : null}
            <StatementTable
              title="Cash and bank accounts"
              testId="section-cf-cash"
              lines={flowLines({ lines: data.cash.accounts, total: data.cash.closing })}
            />
          </>
        ) : null}
      </ReportState>
    </div>
  );
}
