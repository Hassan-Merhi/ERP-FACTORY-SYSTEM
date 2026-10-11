import { useState } from "react";

import { ResponsiveMetricGrid } from "@/components/ui/responsive-report";

import {
  Amount,
  DateField,
  DifferenceNotice,
  FutureDatedNotice,
  MetricCard,
  ReportState,
  ReportToolbar,
  StatementTable,
  reportUrl,
  useReport,
  type FutureDated,
  type StatementLine,
} from "./reportShared";

interface SheetLine {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  balance: string;
}

interface Section {
  lines: SheetLine[];
  total: string;
}

interface BalanceSheetBody {
  asOfDate: string | null;
  equity: Section & { currentEarnings: string; retainedEarnings: string };
  unclassified: Section;
  difference: string;
  fiscalYear: { start: string; end: string } | null;
  classified: {
    currentAssets: Section;
    nonCurrentAssets: Section;
    currentLiabilities: Section;
    nonCurrentLiabilities: Section;
    totals: { assets: string; liabilities: string; equity: string; netAssets: string; cash: string };
  };
}

export interface BalanceSheetResponse extends BalanceSheetBody {
  asOfDefaulted: boolean;
  businessDate: string;
  futureDated: FutureDated;
  comparative: BalanceSheetBody | null;
}

const lineKey = (line: SheetLine) => `${line.kind}:${line.id ?? line.name}`;

function sectionLines(section: Section, compare: Section | undefined, totalLabel: string): StatementLine[] {
  const compared = new Map((compare?.lines ?? []).map((line) => [lineKey(line), line.balance] as const));
  return [
    ...section.lines.map((line) => ({
      key: lineKey(line),
      code: line.code,
      name: line.name,
      amount: line.balance,
      compare: compare ? (compared.get(lineKey(line)) ?? "0.00") : null,
    })),
    { key: "total", name: totalLabel, amount: section.total, compare: compare?.total ?? null, emphasis: true },
  ];
}

export default function BalanceSheetReport() {
  const [asOfDate, setAsOfDate] = useState("");
  const [compareAsOfDate, setCompareAsOfDate] = useState("");
  const params = { asOfDate, compareAsOfDate };
  const { data, isLoading, error } = useReport<BalanceSheetResponse>(reportUrl("/api/reports/balance-sheet", params));
  const compare = data?.comparative ?? null;
  const compareLabel = compare ? "Comparative" : null;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="report-balance-sheet">
      <ReportToolbar exportPath={reportUrl("/api/reports/export/balance-sheet", { asOfDate })}>
        <DateField id="bs-as-of" label="As of" value={asOfDate} onChange={setAsOfDate} />
        <DateField id="bs-compare" label="Compare with" value={compareAsOfDate} onChange={setCompareAsOfDate} />
      </ReportToolbar>
      <ReportState isLoading={isLoading} error={error}>
        {data ? (
          <>
            <p className="text-sm text-muted-foreground" data-testid="text-bs-as-of">
              {`As of ${data.asOfDate ?? data.businessDate}`}
              {data.fiscalYear ? ` · ${`Fiscal year from ${data.fiscalYear.start}`}` : ""}
            </p>
            <FutureDatedNotice futureDated={data.futureDated} />
            <DifferenceNotice difference={data.difference} label="Difference" />
            <ResponsiveMetricGrid>
              <MetricCard
                label="Total assets"
                value={<Amount value={data.classified.totals.assets} />}
                testId="metric-bs-assets"
              />
              <MetricCard
                label="Total liabilities"
                value={<Amount value={data.classified.totals.liabilities} />}
                testId="metric-bs-liabilities"
              />
              <MetricCard
                label="Net assets"
                value={<Amount value={data.classified.totals.netAssets} />}
                testId="metric-bs-net-assets"
              />
              <MetricCard
                label="Cash and bank"
                value={<Amount value={data.classified.totals.cash} />}
                testId="metric-bs-cash"
              />
            </ResponsiveMetricGrid>
            <StatementTable
              title="Current assets"
              testId="section-current-assets"
              compareLabel={compareLabel}
              lines={sectionLines(
                data.classified.currentAssets,
                compare?.classified.currentAssets,
                "Total current assets"
              )}
            />
            <StatementTable
              title="Non-current assets"
              testId="section-non-current-assets"
              compareLabel={compareLabel}
              lines={sectionLines(
                data.classified.nonCurrentAssets,
                compare?.classified.nonCurrentAssets,
                "Total non-current assets"
              )}
            />
            <StatementTable
              title="Current liabilities"
              testId="section-current-liabilities"
              compareLabel={compareLabel}
              lines={sectionLines(
                data.classified.currentLiabilities,
                compare?.classified.currentLiabilities,
                "Total current liabilities"
              )}
            />
            <StatementTable
              title="Non-current liabilities"
              testId="section-non-current-liabilities"
              compareLabel={compareLabel}
              lines={sectionLines(
                data.classified.nonCurrentLiabilities,
                compare?.classified.nonCurrentLiabilities,
                "Total non-current liabilities"
              )}
            />
            <StatementTable
              title="Equity"
              testId="section-equity"
              compareLabel={compareLabel}
              lines={[
                ...sectionLines({ lines: data.equity.lines, total: "" }, compare?.equity, "").slice(0, -1),
                {
                  key: "retained",
                  name: "Retained earnings (not yet closed)",
                  amount: data.equity.retainedEarnings,
                  compare: compare?.equity.retainedEarnings ?? null,
                },
                {
                  key: "current",
                  name: "Current year earnings",
                  amount: data.equity.currentEarnings,
                  compare: compare?.equity.currentEarnings ?? null,
                },
                {
                  key: "total",
                  name: "Total equity",
                  amount: data.equity.total,
                  compare: compare?.equity.total ?? null,
                  emphasis: true,
                },
              ]}
            />
            {data.unclassified.lines.length > 0 ? (
              <StatementTable
                title="Unclassified"
                testId="section-unclassified"
                compareLabel={compareLabel}
                lines={sectionLines(data.unclassified, compare?.unclassified, "Total unclassified")}
              />
            ) : null}
          </>
        ) : null}
      </ReportState>
    </div>
  );
}
