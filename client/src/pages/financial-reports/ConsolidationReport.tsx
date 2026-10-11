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
} from "./reportShared";

/**
 * GET /api/reports/consolidation?asOf= (phase 26, MC-6). The page reads the
 * fields below defensively: the consolidation service is built by phase 26 and
 * this page shows whichever of them it returns.
 */
export interface ConsolidationResponse {
  asOf?: string;
  presentationCurrency?: string;
  companies?: Array<{ companyId: number; name: string; netAssets?: string }>;
  eliminations?: Array<{ label: string; amount: string }>;
  totals?: { assets?: string; liabilities?: string; equity?: string; netAssets?: string };
  difference?: string;
  balanced?: boolean;
}

export default function ConsolidationReport() {
  const [asOf, setAsOf] = useState("");
  const { data, isLoading, error } = useReport<ConsolidationResponse>(
    reportUrl("/api/reports/consolidation", { asOf })
  );

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="report-consolidation">
      <ReportToolbar>
        <DateField id="consolidation-as-of" label="As of" value={asOf} onChange={setAsOf} />
      </ReportToolbar>
      <ReportState isLoading={isLoading} error={error}>
        {data ? (
          <>
            {data.asOf ? (
              <p className="text-sm text-muted-foreground">
                {`As of ${data.asOf}`}
                {data.presentationCurrency ? ` · ${data.presentationCurrency}` : ""}
              </p>
            ) : null}
            {data.difference ? <DifferenceNotice difference={data.difference} label="Difference" /> : null}
            <ResponsiveMetricGrid>
              <MetricCard
                label="Total assets"
                value={<Amount value={data.totals?.assets ?? null} />}
                testId="metric-cons-assets"
              />
              <MetricCard
                label="Total liabilities"
                value={<Amount value={data.totals?.liabilities ?? null} />}
                testId="metric-cons-liabilities"
              />
              <MetricCard
                label="Net assets"
                value={<Amount value={data.totals?.netAssets ?? null} />}
                testId="metric-cons-net-assets"
              />
            </ResponsiveMetricGrid>
            <StatementTable
              title="Companies"
              testId="section-cons-companies"
              lines={(data.companies ?? []).map((company) => ({
                key: String(company.companyId),
                name: company.name,
                amount: company.netAssets ?? null,
              }))}
            />
            <StatementTable
              title="Eliminations"
              testId="section-cons-eliminations"
              lines={(data.eliminations ?? []).map((line, index) => ({
                key: `${index}`,
                name: line.label,
                amount: line.amount,
              }))}
            />
          </>
        ) : null}
      </ReportState>
    </div>
  );
}
