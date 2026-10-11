import { Suspense } from "react";
import { BarChart3, BookOpen, Building2, Clock, FileBarChart, Landmark, Scale, Waves } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResponsiveReportPage } from "@/components/ui/responsive-report";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { lazyRetry as lazy } from "@/lib/lazyRetry";

const TrialBalanceReport = lazy(() => import("@/pages/financial-reports/TrialBalanceReport"));
const BalanceSheetReport = lazy(() => import("@/pages/financial-reports/BalanceSheetReport"));
const ProfitLossReport = lazy(() => import("@/pages/financial-reports/ProfitLossReport"));
const CashFlowReport = lazy(() => import("@/pages/financial-reports/CashFlowReport"));
const AgingReport = lazy(() => import("@/pages/financial-reports/AgingReport"));
const RatiosReport = lazy(() => import("@/pages/financial-reports/RatiosReport"));
const GeneralLedgerReport = lazy(() => import("@/pages/financial-reports/GeneralLedgerReport"));
const ConsolidationReport = lazy(() => import("@/pages/financial-reports/ConsolidationReport"));

/** The financial statements of the current company (accounting audit phase 27). */
export const FINANCIAL_REPORT_TABS = [
  { key: "trial-balance", label: "Trial Balance", icon: Scale },
  { key: "balance-sheet", label: "Balance Sheet", icon: Landmark },
  { key: "profit-loss", label: "Profit & Loss", icon: FileBarChart },
  { key: "cash-flow", label: "Cash Flow", icon: Waves },
  { key: "aging", label: "Aging", icon: Clock },
  { key: "ratios", label: "Ratios", icon: BarChart3 },
  { key: "general-ledger", label: "General Ledger", icon: BookOpen },
  { key: "consolidation", label: "Consolidation", icon: Building2 },
] as const;

type ReportKey = (typeof FINANCIAL_REPORT_TABS)[number]["key"];
const REPORT_KEYS: ReportKey[] = FINANCIAL_REPORT_TABS.map((tab) => tab.key);

function ReportBody({ report }: { report: ReportKey }) {
  switch (report) {
    case "trial-balance":
      return <TrialBalanceReport />;
    case "balance-sheet":
      return <BalanceSheetReport />;
    case "profit-loss":
      return <ProfitLossReport />;
    case "cash-flow":
      return <CashFlowReport />;
    case "aging":
      return <AgingReport />;
    case "ratios":
      return <RatiosReport />;
    case "general-ledger":
      return <GeneralLedgerReport />;
    case "consolidation":
      return <ConsolidationReport />;
  }
}

export default function FinancialReports() {
  const [activeTab, setTab] = useHubQueryState<ReportKey>({
    key: "tab",
    allowedValues: REPORT_KEYS,
    knownValues: REPORT_KEYS,
    defaultValue: "trial-balance",
  });

  return (
    <ResponsiveReportPage className="p-3 sm:p-4" data-testid="page-financial-reports">
      <PageHeader title="Financial Statements" subtitle="Statements of the current company from the ledger" />
      <Tabs
        value={activeTab}
        onValueChange={(value) => setTab(value as ReportKey)}
        className="flex min-w-0 flex-col gap-4"
      >
        <div className="erp-mobile-scroll-tabs pb-1">
          <TabsList className="h-9 w-max min-w-full sm:w-fit sm:min-w-0">
            {FINANCIAL_REPORT_TABS.map((tab) => (
              <TabsTrigger
                key={tab.key}
                value={tab.key}
                className="flex shrink-0 items-center gap-1.5 text-sm"
                data-testid={`tab-${tab.key}`}
              >
                <tab.icon className="h-3.5 w-3.5" aria-hidden="true" />
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {FINANCIAL_REPORT_TABS.map((tab) => (
          <TabsContent key={tab.key} value={tab.key} className="m-0 min-w-0 p-0">
            {activeTab === tab.key ? (
              <Suspense fallback={<div className="p-8 text-center text-muted-foreground">Loading…</div>}>
                <ReportBody report={tab.key} />
              </Suspense>
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </ResponsiveReportPage>
  );
}
