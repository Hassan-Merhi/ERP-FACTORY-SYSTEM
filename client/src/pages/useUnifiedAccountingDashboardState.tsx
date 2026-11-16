// Extracted from ./UnifiedAccountingDashboard.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { read, type Dashboard } from "./UnifiedAccountingDashboardTypes";

export function useUnifiedAccountingDashboardState() {
  const [path, go] = useLocation();
  const { selectedCompany } = useCompany(),
    companyId = selectedCompany?.id;
  const prefix = path.startsWith("/factory/") ? "/factory" : path.startsWith("/properties/") ? "/properties" : "";
  const [fromDate, setFromDate] = useState("");
  const [asOfDate, setAsOfDate] = useState("");
  const [showOperations, setShowOperations] = useState(false);
  const [tab, setTab] = useState<"position" | "profit" | "budgets" | "stock" | "controls">("position");
  const params = new URLSearchParams({
    valuationBasis: "cost",
    includeOperational: String(showOperations),
  });
  if (fromDate) params.set("fromDate", fromDate);
  if (asOfDate) params.set("asOfDate", asOfDate);
  const data = useQuery<Dashboard>({
    queryKey: ["/api/accounting/unified-dashboard", companyId, fromDate, asOfDate, showOperations],
    queryFn: () => read("/api/accounting/unified-dashboard?" + params.toString()),
    enabled: !!companyId,
    retry: false,
  });
  // Never render a response for a different company or book basis, including
  // when a session company switches while a previous request is in flight.
  const x =
    data.data?.companyId === Number(companyId) &&
    data.data.currency === "USD" &&
    data.data.presentation === "STANDALONE_BOOKED_NOT_GROUP_CONSOLIDATED"
      ? data.data
      : undefined;
  const nav = (url: string) => go(prefix + url);
  const csv = () => {
    if (!x) return;
    const rows: string[][] = [
      ["PROVISIONAL UNIFIED ACCOUNTING NET POSITION"],
      ["Company", String(x.companyId)],
      ["Period begins", x.fromDate],
      ["As of", x.asOfDate],
      ["Currency", "USD"],
      ["Basis", "POSTED_HISTORICAL_BASE"],
      ["Booked assets", x.financialPosition.assetsUsd],
      ["Booked liabilities", x.financialPosition.liabilitiesUsd],
      ["Booked net assets", x.financialPosition.netAssetsUsd],
      ["Equity incl. unclosed earnings", x.financialPosition.equityIncludingEarningsUsd],
      [
        "Assets less liabilities and equity (before unclassified)",
        x.financialPosition.reportedBalanceSheetDifferenceUsd,
      ],
      ["Unclassified account net balance", x.financialPosition.unclassifiedUsd],
      ["Ledger residual after unclassified", x.financialPosition.unexplainedDifferenceUsd],
      ["Sales revenue", x.performance.salesRevenueUsd],
      ["Cost of sales", x.performance.costOfSalesUsd],
      ["Gross profit", x.performance.grossProfitUsd],
      ["Other income", x.performance.otherIncomeUsd],
      ["Operating expenses", x.performance.operatingExpensesUsd],
      ["Net profit", x.performance.netProfitUsd],
      ["ERP operational cost (separate memo)", x.operations.erpStock?.costUsd ?? "NOT_LOADED"],
      ["ERP operational cost date basis", x.operations.erpStock?.asOfBasis ?? "NOT_LOADED"],
      ["ERP unattributed historical movement USD", x.operations.erpStock?.unitemizedMovementValueUsd ?? "NOT_LOADED"],
      ["Factory operational cost (CURRENT ONLY; separate memo)", x.operations.factoryStock?.totalUsd ?? "NOT_LOADED"],
      ["Combined ERP and Factory cost memorandum", x.operations.managementCostCandidateUsd ?? "WITHHELD"],
      ["Combined memorandum date/completeness policy", x.operations.managementCostCandidateBasis],
      ["Operational cost added to booked net assets", "NO"],
      ["Valuation", "Selling value not included in accounting book amounts"],
      ["Control status", "PROVISIONAL - NOT CERTIFIED"],
    ];
    const contents = rows
      .map((row) =>
        row
          .map((v) => {
            const t = String(v),
              isNumeric = /^-?\d+(\.\d+)?$/.test(t);
            const safe = /^[=+@]/.test(t) || (t.startsWith("-") && !isNumeric) ? "'" + t : t;
            return '"' + safe.replaceAll('"', '""') + '"';
          })
          .join(",")
      )
      .join("\r\n");
    const object = URL.createObjectURL(new Blob(["\ufeff", contents], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = object;
    link.download = "unified-accounting-" + x.companyId + "-" + x.asOfDate + ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(object);
  };
  return {
    asOfDate,
    csv,
    data,
    fromDate,
    go,
    nav,
    prefix,
    selectedCompany,
    setAsOfDate,
    setFromDate,
    setShowOperations,
    setTab,
    showOperations,
    tab,
    x,
  };
}

export function UnifiedAccountingDashboardCardSection({
  asOfDate,
  csv,
  data,
  fromDate,
  setAsOfDate,
  setFromDate,
  setShowOperations,
  showOperations,
  x,
}: Pick<
  ReturnType<typeof useUnifiedAccountingDashboardState>,
  | "asOfDate"
  | "csv"
  | "data"
  | "fromDate"
  | "setAsOfDate"
  | "setFromDate"
  | "setShowOperations"
  | "showOperations"
  | "x"
>) {
  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <div className="grid sm:grid-cols-4 gap-3 items-end">
          <div>
            <Label>Period start</Label>
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div>
            <Label>As-of date</Label>
            <Input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </div>
          <Button variant="outline" disabled={data.isFetching} onClick={() => data.refetch()}>
            Refresh
          </Button>
          <Button variant="outline" disabled={!x} onClick={csv}>
            Export overview CSV
          </Button>
        </div>
        <label className="text-sm flex gap-2 items-center">
          <input type="checkbox" checked={showOperations} onChange={(e) => setShowOperations(e.target.checked)} />
          Load cost-valued ERP and Factory stock comparison (management memo)
        </label>
        <p className="text-xs text-muted-foreground">
          Operations are loaded separately. They do not alter the booked accounting statement or add assets twice. For a
          past date, Factory production stock cost is current, not historical.
        </p>
      </CardContent>
    </Card>
  );
}
