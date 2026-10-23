/** Phase 11 — company financial statement presentation, export and drill-down. */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Line {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  category: string;
  amountUsd: string;
  openingSideAssumed: boolean;
  currentSourceIsMutable: boolean;
}
interface Section {
  lines: Line[];
  totalUsd: string;
}
interface Single {
  fromDate: string;
  asOfDate: string;
  currency: string;
  financialPosition: {
    assets: Section;
    liabilities: Section;
    equity: Section;
    unclassified: Section;
    unclosedEarningsUsd: string;
    totalEquityIncludingEarningsUsd: string;
    reportedBalanceSheetDifferenceUsd: string;
    assetsMinusLiabilitiesAndEquityUsd: string;
    balanced: boolean;
  };
  profitAndLoss: {
    revenue: Section;
    otherIncome: Section;
    costOfSales: Section;
    operatingExpenses: Section;
    grossProfitUsd: string;
    operatingResultUsd: string;
    periodNetResultUsd: string;
  };
  changesInEquity: {
    openingTotalEquityUsd: string;
    periodResultUsd: string;
    otherBookedEquityMovementsUsd: string;
    closingTotalEquityUsd: string;
    differenceUsd: string;
    otherMovementsRequireReview: boolean;
  };
  cashFlow: {
    operatingUsd: string;
    investingUsd: string;
    financingUsd: string;
    unclassifiedUsd: string;
    recognizedCashMovementUsd: string;
    actualCashMovementUsd: string;
    cashFlowClassificationDifferenceUsd: string;
    openingCashUsd: string;
    closingCashUsd: string;
    sourceVoucherCount: number;
    sampleTruncated: boolean;
    sourceSample: Array<{
      voucherId: number;
      voucherNumber: string;
      bookedOn: string;
      changeUsd: string;
      classification: string;
    }>;
  };
  controls: {
    trialBalanceDifferenceUsd: string;
    trialBalanceBalanced: boolean;
    assumedOpeningSides: number;
    unknownAccounts: number;
    unknownAbsAmountUsd: string;
    recognizedCashAndSourceAgree: boolean;
    certified: false;
    blockers: string[];
    warnings: string[];
  };
}
interface Package {
  companyId: number;
  fromDate: string;
  asOfDate: string;
  currency: "USD";
  current: Single;
  comparison: Single | null;
  comparisonPeriod: { fromDate: string; asOfDate: string } | null;
  reportStatus: "PROVISIONAL_NOT_CERTIFIED";
  historicalFx: {
    ready: boolean;
    legacyCompatibilityMode: boolean;
    unresolvedEntryCount: number;
    unresolvedVoucherCount: number;
    unresolvedLedgerOpeningCount: number;
    unresolvedBankOpeningCount: number;
    unresolvedCustomerOpeningCount: number;
    unresolvedSupplierOpeningCount: number;
    certified: false;
    caveat: string;
  };
  comparisonHistoricalFx: Package["historicalFx"] | null;
  disclosure: Record<string, string>;
}
async function get(url: string): Promise<Package> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? "Unable to retrieve financial statements");
  return body as Package;
}
const number = (v: string) =>
  Number(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
function exportedCsv(record: Package) {
  const rows: string[][] = [
    ["PROVISIONAL FINANCIAL STATEMENTS — NOT CERTIFIED"],
    ["Company", String(record.companyId)],
    ["From", record.fromDate],
    ["As of", record.asOfDate],
    ["Currency", "USD"],
    ["Statement", "Account", "Current USD", "Prior USD"],
  ];
  const current = record.current,
    prior = record.comparison;
  function detail(name: string, section: Section, prev?: Section) {
    const prevMap = new Map((prev?.lines ?? []).map((l) => [`${l.kind}:${l.id}`, l.amountUsd]));
    const included = new Set(section.lines.map((line) => `${line.kind}:${line.id}`));
    for (const line of section.lines) {
      rows.push([
        name,
        line.code ? line.code + " — " + line.name : line.name,
        line.amountUsd,
        prevMap.get(`${line.kind}:${line.id}`) ?? "",
      ]);
    }
    for (const line of prev?.lines ?? []) {
      if (included.has(`${line.kind}:${line.id}`)) continue;
      rows.push([name, line.code ? line.code + " — " + line.name : line.name, "0.00", line.amountUsd]);
    }
    rows.push([name, "TOTAL", section.totalUsd, prev?.totalUsd ?? ""]);
  }
  detail("Revenue", current.profitAndLoss.revenue, prior?.profitAndLoss.revenue);
  detail("Other income", current.profitAndLoss.otherIncome, prior?.profitAndLoss.otherIncome);
  detail("Cost of sales", current.profitAndLoss.costOfSales, prior?.profitAndLoss.costOfSales);
  detail("Operating expenses", current.profitAndLoss.operatingExpenses, prior?.profitAndLoss.operatingExpenses);
  rows.push([
    "Profit and loss",
    "NET RESULT",
    current.profitAndLoss.periodNetResultUsd,
    prior?.profitAndLoss.periodNetResultUsd ?? "",
  ]);
  detail("Assets", current.financialPosition.assets, prior?.financialPosition.assets);
  detail("Liabilities", current.financialPosition.liabilities, prior?.financialPosition.liabilities);
  detail("Equity", current.financialPosition.equity, prior?.financialPosition.equity);
  detail("Unclassified", current.financialPosition.unclassified, prior?.financialPosition.unclassified);
  rows.push([
    "Financial position",
    "Unclosed current earnings",
    current.financialPosition.unclosedEarningsUsd,
    prior?.financialPosition.unclosedEarningsUsd ?? "",
  ]);
  rows.push([
    "Financial position",
    "ASSETS MINUS LIABILITIES AND EQUITY",
    current.financialPosition.reportedBalanceSheetDifferenceUsd,
    prior?.financialPosition.reportedBalanceSheetDifferenceUsd ?? "",
  ]);
  rows.push([
    "Financial position",
    "RESIDUAL AFTER UNCLASSIFIED",
    current.financialPosition.assetsMinusLiabilitiesAndEquityUsd,
    prior?.financialPosition.assetsMinusLiabilitiesAndEquityUsd ?? "",
  ]);
  for (const key of [
    "openingTotalEquityUsd",
    "periodResultUsd",
    "otherBookedEquityMovementsUsd",
    "closingTotalEquityUsd",
    "differenceUsd",
  ] as const) {
    rows.push(["Changes in equity", key, current.changesInEquity[key], prior?.changesInEquity[key] ?? ""]);
  }
  for (const key of [
    "operatingUsd",
    "investingUsd",
    "financingUsd",
    "unclassifiedUsd",
    "actualCashMovementUsd",
    "cashFlowClassificationDifferenceUsd",
    "openingCashUsd",
    "closingCashUsd",
  ] as const) {
    rows.push(["Cash flow", key, current.cashFlow[key], prior?.cashFlow[key] ?? ""]);
  }
  rows.push(["", "DISCLAIMER", "All statements provisional; no ledger adjustment applied", ""]);
  const csv = rows
    .map((row) =>
      row
        .map((value) => {
          const text = String(value);
          // User-provided account and party labels must never execute as formulas
          // when this CSV is opened in Excel.
          const numeric = /^-?[0-9]+(?:\.[0-9]+)?$/.test(text);
          const safe = /^[=+@]/.test(text) || (text.startsWith("-") && !numeric) ? "'" + text : text;
          return '"' + safe.replaceAll('"', '""') + '"';
        })
        .join(",")
    )
    .join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `financial-statements-${record.companyId}-${record.asOfDate}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function SectionTable({ title, current, previous }: { title: string; current: Section; previous?: Section }) {
  const previousMap = new Map((previous?.lines ?? []).map((l) => [`${l.kind}:${l.id}`, l.amountUsd]));
  const existing = new Set(current.lines.map((l) => `${l.kind}:${l.id}`));
  const lines = [
    ...current.lines,
    ...(previous?.lines ?? [])
      .filter((l) => !existing.has(`${l.kind}:${l.id}`))
      .map((l) => ({ ...l, amountUsd: "0.00" })),
  ];
  return (
    <div className="space-y-1">
      <h3 className="font-semibold text-base">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">Account / party</th>
              <th className="p-2 text-right">Current USD</th>
              {previous && <th className="p-2 text-right">Comparison USD</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={line.kind + ":" + line.id + ":" + i} className="border-b">
                <td className="p-2">
                  {line.code ? line.code + " · " : ""}
                  {line.name}
                  {line.openingSideAssumed && (
                    <span className="text-xs text-muted-foreground"> (opening side assumed)</span>
                  )}
                </td>
                <td className="p-2 text-right tabular-nums">{number(line.amountUsd)}</td>
                {previous && (
                  <td className="p-2 text-right tabular-nums">
                    {previousMap.has(`${line.kind}:${line.id}`)
                      ? number(previousMap.get(`${line.kind}:${line.id}`) ?? "0")
                      : "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold border-t">
              <td className="p-2">TOTAL {title.toUpperCase()}</td>
              <td className="p-2 text-right tabular-nums">{number(current.totalUsd)}</td>
              {previous && <td className="p-2 text-right tabular-nums">{number(previous.totalUsd)}</td>}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
function Figure({ label, current, previous }: { label: string; current: string; previous?: string }) {
  return (
    <div className="flex justify-between items-center gap-2 border-b py-2 text-sm">
      <span>{label}</span>
      <div className="flex gap-4 items-center font-semibold tabular-nums">
        <span>{number(current)}</span>
        {previous !== undefined && <span className="text-muted-foreground">{number(previous)}</span>}
      </div>
    </div>
  );
}
export default function ProfessionalFinancialStatements() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [compare, setCompare] = useState(true);
  const [tab, setTab] = useState<"income" | "balance" | "equity" | "cash" | "notes">("income");
  const params = new URLSearchParams({ compare: String(compare) });
  if (start) params.set("fromDate", start);
  if (end) params.set("asOfDate", end);
  const data = useQuery<Package>({
    queryKey: ["/api/accounting/statements/professional", companyId, start, end, compare],
    queryFn: () => get("/api/accounting/statements/professional?" + params),
    enabled: !!companyId,
    retry: false,
  });
  const pkg = data.data,
    now = pkg?.current,
    prior = pkg?.comparison;
  const status = useMemo(
    () => (now?.controls.blockers.length ?? 0) + (prior?.controls.blockers.length ?? 0),
    [now, prior]
  );
  return (
    <div className="space-y-5 p-3 sm:p-5 print:p-0" data-testid="professional-financial-statements">
      <div>
        <h1 className="text-2xl font-semibold">Professional Financial Statements</h1>
        <p className="text-sm text-muted-foreground">
          {selectedCompany?.name ?? "Selected company"} · USD posted historical base · company standalone statements.
          Source accounting vouchers are never modified.
        </p>
      </div>
      <Card className="print:hidden">
        <CardHeader>
          <CardTitle>Statement period</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="statement-from">Period start</Label>
              <Input id="statement-from" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="statement-end">As-of date</Label>
              <Input id="statement-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
            <div className="flex items-end gap-2">
              <Button variant="outline" disabled={data.isFetching} onClick={() => data.refetch()}>
                Refresh
              </Button>
              {pkg && (
                <Button variant="outline" onClick={() => exportedCsv(pkg)}>
                  Export CSV
                </Button>
              )}
              <Button variant="outline" onClick={() => window.print()}>
                Print
              </Button>
            </div>
          </div>
          <label className="flex gap-2 items-center text-sm">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
            Compare with the immediately preceding period of equal length
          </label>
          <p className="text-xs text-muted-foreground">
            Default: January 1 to the company business date. Comparing the same number of days avoids assuming fiscal
            years are already closed.
          </p>
        </CardContent>
      </Card>
      {data.isError && (
        <p role="alert" className="text-sm text-destructive">
          {(data.error as Error).message}
        </p>
      )}
      {data.isLoading && <p className="text-sm text-muted-foreground">Loading financial statements…</p>}
      {pkg && now && (
        <>
          <div className="space-y-2 border-b pb-3">
            <p className="text-base font-semibold">{selectedCompany?.name ?? "Company #" + pkg.companyId}</p>
            <p className="text-sm">
              From {pkg.fromDate} through {pkg.asOfDate} · USD
            </p>
            {pkg.comparisonPeriod && (
              <p className="text-sm text-muted-foreground">
                Comparison: {pkg.comparisonPeriod.fromDate} – {pkg.comparisonPeriod.asOfDate}
              </p>
            )}
            <p className="text-sm font-semibold text-destructive">
              PROVISIONAL — NOT CERTIFIED. {status} current/comparison financial control blocker(s).
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["Period revenue", now.profitAndLoss.revenue.totalUsd],
                ["Gross profit", now.profitAndLoss.grossProfitUsd],
                ["Net result", now.profitAndLoss.periodNetResultUsd],
                ["Assets", now.financialPosition.assets.totalUsd],
                ["Liabilities", now.financialPosition.liabilities.totalUsd],
                ["Equity including unclosed earnings", now.financialPosition.totalEquityIncludingEarningsUsd],
                ["Actual cash movement", now.cashFlow.actualCashMovementUsd],
                ["Reported balance-sheet difference", now.financialPosition.reportedBalanceSheetDifferenceUsd],
              ] as Array<[string, string]>
            ).map(([label, value]) => (
              <div key={label}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="font-semibold text-lg tabular-nums">{number(value)}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 print:hidden">
            {(["income", "balance", "equity", "cash", "notes"] as const).map((value) => (
              <Button
                size="sm"
                key={value}
                variant={tab === value ? "default" : "outline"}
                onClick={() => setTab(value)}
              >
                {
                  (
                    {
                      income: "Income statement",
                      balance: "Balance sheet",
                      equity: "Changes in equity",
                      cash: "Cash-flow workpaper",
                      notes: "Accounting disclosures",
                    } as const
                  )[value]
                }
              </Button>
            ))}
          </div>
          {tab === "income" && (
            <Card>
              <CardHeader>
                <CardTitle>Income statement — profit & loss</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <SectionTable
                  title="Revenue"
                  current={now.profitAndLoss.revenue}
                  previous={prior?.profitAndLoss.revenue}
                />
                <SectionTable
                  title="Cost of sales"
                  current={now.profitAndLoss.costOfSales}
                  previous={prior?.profitAndLoss.costOfSales}
                />
                <Figure
                  label="Gross profit"
                  current={now.profitAndLoss.grossProfitUsd}
                  previous={prior?.profitAndLoss.grossProfitUsd}
                />
                <SectionTable
                  title="Other income"
                  current={now.profitAndLoss.otherIncome}
                  previous={prior?.profitAndLoss.otherIncome}
                />
                <SectionTable
                  title="Other operating expenses"
                  current={now.profitAndLoss.operatingExpenses}
                  previous={prior?.profitAndLoss.operatingExpenses}
                />
                <Figure
                  label="Operating result"
                  current={now.profitAndLoss.operatingResultUsd}
                  previous={prior?.profitAndLoss.operatingResultUsd}
                />
                <Figure
                  label="NET RESULT — PROVISIONAL"
                  current={now.profitAndLoss.periodNetResultUsd}
                  previous={prior?.profitAndLoss.periodNetResultUsd}
                />
                <p className="text-xs text-muted-foreground">
                  Period P&L excludes fiscal closing journals, includes only posted ledger lines, and does not invent
                  inventory costs from operational sales prices.
                </p>
              </CardContent>
            </Card>
          )}
          {tab === "balance" && (
            <Card>
              <CardHeader>
                <CardTitle>Statement of financial position — balance sheet</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <SectionTable
                  title="Assets"
                  current={now.financialPosition.assets}
                  previous={prior?.financialPosition.assets}
                />
                <SectionTable
                  title="Liabilities"
                  current={now.financialPosition.liabilities}
                  previous={prior?.financialPosition.liabilities}
                />
                <SectionTable
                  title="Equity before unclosed earnings"
                  current={now.financialPosition.equity}
                  previous={prior?.financialPosition.equity}
                />
                <Figure
                  label="Unclosed earnings carried in GL accounts"
                  current={now.financialPosition.unclosedEarningsUsd}
                  previous={prior?.financialPosition.unclosedEarningsUsd}
                />
                <Figure
                  label="Total equity including unclosed earnings"
                  current={now.financialPosition.totalEquityIncludingEarningsUsd}
                  previous={prior?.financialPosition.totalEquityIncludingEarningsUsd}
                />
                <SectionTable
                  title="Unclassified accounts (not forced into totals)"
                  current={now.financialPosition.unclassified}
                  previous={prior?.financialPosition.unclassified}
                />
                <Figure
                  label="Assets − liabilities − equity (before unclassified)"
                  current={now.financialPosition.reportedBalanceSheetDifferenceUsd}
                  previous={prior?.financialPosition.reportedBalanceSheetDifferenceUsd}
                />
                <Figure
                  label="Residual after separately disclosed unclassified accounts"
                  current={now.financialPosition.assetsMinusLiabilitiesAndEquityUsd}
                  previous={prior?.financialPosition.assetsMinusLiabilitiesAndEquityUsd}
                />
                <p className="text-xs text-muted-foreground">
                  Customer and supplier credit/debit balances appear on their actual side. Unknown accounts remain
                  visible. A difference is not plugged.
                </p>
              </CardContent>
            </Card>
          )}
          {tab === "equity" && (
            <Card>
              <CardHeader>
                <CardTitle>Statement of changes in equity</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Figure
                  label="Total equity at start of period"
                  current={now.changesInEquity.openingTotalEquityUsd}
                  previous={prior?.changesInEquity.openingTotalEquityUsd}
                />
                <Figure
                  label="Period profit / loss"
                  current={now.changesInEquity.periodResultUsd}
                  previous={prior?.changesInEquity.periodResultUsd}
                />
                <Figure
                  label="Other booked equity movements — allocation unverified"
                  current={now.changesInEquity.otherBookedEquityMovementsUsd}
                  previous={prior?.changesInEquity.otherBookedEquityMovementsUsd}
                />
                <Figure
                  label="TOTAL EQUITY AT END OF PERIOD"
                  current={now.changesInEquity.closingTotalEquityUsd}
                  previous={prior?.changesInEquity.closingTotalEquityUsd}
                />
                <Figure
                  label="Equity movement reconciliation difference"
                  current={now.changesInEquity.differenceUsd}
                  previous={prior?.changesInEquity.differenceUsd}
                />
                <p className="text-sm text-muted-foreground">
                  Other booked equity movements may include capital contributions, withdrawals, retained earnings
                  transfers or source reclassifications. They cannot be certified as shareholder transactions without
                  original voucher review.
                </p>
              </CardContent>
            </Card>
          )}
          {tab === "cash" && (
            <Card>
              <CardHeader>
                <CardTitle>Cash-flow workpaper — classification pending review</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  This is a provisional direct cash journal classification, not a certified IAS 7 or GAAP cash-flow
                  statement. Mixed-purpose and multi-line vouchers are unclassified.
                </p>
                <Figure
                  label="Opening cash and bank accounts"
                  current={now.cashFlow.openingCashUsd}
                  previous={prior?.cashFlow.openingCashUsd}
                />
                <Figure
                  label="Operating cash movements"
                  current={now.cashFlow.operatingUsd}
                  previous={prior?.cashFlow.operatingUsd}
                />
                <Figure
                  label="Investing cash movements"
                  current={now.cashFlow.investingUsd}
                  previous={prior?.cashFlow.investingUsd}
                />
                <Figure
                  label="Financing cash movements"
                  current={now.cashFlow.financingUsd}
                  previous={prior?.cashFlow.financingUsd}
                />
                <Figure
                  label="Unclassified cash movements"
                  current={now.cashFlow.unclassifiedUsd}
                  previous={prior?.cashFlow.unclassifiedUsd}
                />
                <Figure
                  label="Total cash change from voucher lines"
                  current={now.cashFlow.recognizedCashMovementUsd}
                  previous={prior?.cashFlow.recognizedCashMovementUsd}
                />
                <Figure
                  label="Canonical cash-account movement"
                  current={now.cashFlow.actualCashMovementUsd}
                  previous={prior?.cashFlow.actualCashMovementUsd}
                />
                <Figure
                  label="Cash-flow reconciliation difference"
                  current={now.cashFlow.cashFlowClassificationDifferenceUsd}
                  previous={prior?.cashFlow.cashFlowClassificationDifferenceUsd}
                />
                <Figure
                  label="Closing cash and bank accounts"
                  current={now.cashFlow.closingCashUsd}
                  previous={prior?.cashFlow.closingCashUsd}
                />
                <p className="text-xs text-muted-foreground">
                  {now.cashFlow.sourceVoucherCount} vouchers have cash/bank lines in the selected period.
                  {now.cashFlow.sampleTruncated ? " Showing the latest 250 only; totals include all vouchers." : ""}
                </p>
                <div className="max-h-[470px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Voucher</th>
                        <th className="p-2">Date</th>
                        <th className="p-2 text-right">Cash delta USD</th>
                        <th className="p-2">Provisional classification</th>
                      </tr>
                    </thead>
                    <tbody>
                      {now.cashFlow.sourceSample.map((v) => (
                        <tr key={v.voucherId} className="border-b">
                          <td className="p-2">{v.voucherNumber}</td>
                          <td className="p-2">{v.bookedOn}</td>
                          <td className="p-2 text-right tabular-nums">{number(v.changeUsd)}</td>
                          <td className="p-2">{v.classification}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
          {tab === "notes" && (
            <Card>
              <CardHeader>
                <CardTitle>Financial statement controls and disclosures</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm font-semibold">Financial certification has not been granted.</p>
                <p className="text-sm">
                  Current-period historical FX:
                  {pkg.historicalFx.legacyCompatibilityMode
                    ? " legacy compatibility only (not validated)"
                    : pkg.historicalFx.ready
                      ? " ready (not certification)"
                      : " unresolved records detected"}
                  . Entries flagged: {pkg.historicalFx.unresolvedEntryCount}, vouchers flagged:{" "}
                  {pkg.historicalFx.unresolvedVoucherCount}.
                </p>
                <p className="text-xs text-muted-foreground">{pkg.historicalFx.caveat}</p>
                {pkg.comparisonHistoricalFx && (
                  <>
                    <p className="text-sm">
                      Comparison-period historical FX:
                      {pkg.comparisonHistoricalFx.legacyCompatibilityMode
                        ? " legacy compatibility only (not validated)"
                        : pkg.comparisonHistoricalFx.ready
                          ? " ready (not certification)"
                          : " unresolved records detected"}
                      . Entries flagged: {pkg.comparisonHistoricalFx.unresolvedEntryCount}, vouchers flagged:{" "}
                      {pkg.comparisonHistoricalFx.unresolvedVoucherCount}.
                    </p>
                    <p className="text-xs text-muted-foreground">{pkg.comparisonHistoricalFx.caveat}</p>
                  </>
                )}
                {now.controls.blockers.map((text, i) => (
                  <p key={i} className="text-sm text-destructive">
                    {text}
                  </p>
                ))}
                {now.controls.warnings.map((text, i) => (
                  <p key={i} className="text-sm">
                    {text}
                  </p>
                ))}
                {prior?.controls.blockers.map((text, i) => (
                  <p key={`comparison-blocker-${i}`} className="text-sm text-destructive">
                    Comparison: {text}
                  </p>
                ))}
                {prior?.controls.warnings.map((text, i) => (
                  <p key={`comparison-warning-${i}`} className="text-sm">
                    Comparison: {text}
                  </p>
                ))}
                {Object.entries(pkg.disclosure).map(([key, value]) => (
                  <div key={key} className="border-b pb-2">
                    <p className="text-sm font-semibold">{key}</p>
                    <p className="text-sm text-muted-foreground">{value}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
