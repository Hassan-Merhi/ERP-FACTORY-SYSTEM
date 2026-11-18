// Extracted from ./UnifiedAccountingDashboard.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { money, read, type Dashboard, type Line } from "./UnifiedAccountingDashboardTypes";

export function Details({ title, rows }: { title: string; rows: Line[] }) {
  return (
    <div className="space-y-2">
      <h3 className="font-semibold">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">Account</th>
              <th className="p-2">Source</th>
              <th className="p-2 text-right">Booked USD</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((line, i) => (
              <tr className="border-b" key={line.kind + ":" + line.id + ":" + i}>
                <td className="p-2">
                  {line.code ? line.code + " · " : ""}
                  {line.name}
                  {line.openingSideAssumed && (
                    <span className="text-xs text-muted-foreground"> (opening side assumed)</span>
                  )}
                </td>
                <td className="p-2">{line.kind}</td>
                <td className="p-2 text-right tabular-nums">{money(line.amountUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">No booked amounts in this section.</p>}
    </div>
  );
}

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
    downloadBlob(
      new Blob(["\ufeff", contents], { type: "text/csv;charset=utf-8" }),
      exportFileName(`unified accounting ${x.companyId}`, "csv", { from: x.fromDate, to: x.asOfDate })
    );
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
          <ExportButton kind="csv" disabled={!x} onClick={csv} />
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
