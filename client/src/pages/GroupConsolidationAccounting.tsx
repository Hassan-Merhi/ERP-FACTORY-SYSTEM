import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { label } from "./GroupConsolidationAccountingTypes";
import {
  GroupConsolidationAccountingCardSection,
  useGroupConsolidationAccountingState,
} from "./useGroupConsolidationAccountingState";
import { GroupConsolidationAccountingCardSection2 } from "./GroupConsolidationAccountingCardSection2";

export default function GroupConsolidationAccounting() {
  const {
    asOf,
    available,
    chosen,
    companies,
    companyName,
    filter,
    financialRows,
    from,
    includeZero,
    onlyIssues,
    ready,
    report,
    setAsOf,
    setChosen,
    setFilter,
    setFrom,
    setIncludeZero,
    setOnlyIssues,
    setTab,
    tab,
    transfers,
  } = useGroupConsolidationAccountingState();
  // A voucher belongs to its own company. Opening its ID inside the user's
  // selected company would show the wrong ledger or leak an unrelated voucher.
  // Display reference and owner company; switch to that company to drill in.
  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="group-accounting-consolidation">
      <PageHeader
        title="Intercompany & Consolidation"
        subtitle="USD ledger workpaper across authorized companies: trial balances, paired intercompany receivables/payables, reconciliation and hypothetical elimination entries. Source vouchers remain unchanged."
      />
      <Card>
        <CardHeader>
          <CardTitle>Group scope and dates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {companies.isError && <p className="text-destructive text-sm">{(companies.error as Error).message}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setChosen(available.map((c) => c.id))}>
              Select all accessible
            </Button>
            <Button variant="outline" size="sm" onClick={() => setChosen([])}>
              Clear selection
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-[220px] overflow-y-auto">
            {available.map((c) => (
              <label key={c.id} className="flex gap-2 items-start text-sm rounded border p-2">
                <input
                  type="checkbox"
                  checked={chosen.includes(c.id)}
                  onChange={(e) =>
                    setChosen((old) =>
                      e.target.checked ? [...old.filter((v) => v !== c.id), c.id] : old.filter((v) => v !== c.id)
                    )
                  }
                />
                <span>
                  {c.name}
                  <span className="text-xs block text-muted-foreground">
                    {c.code} · {c.companyType} · {c.baseCurrency} · parent {c.parentCompanyId ?? "none"}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Statement period from</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label>Balance as of</Label>
              <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button
                className="w-full"
                variant="outline"
                disabled={!ready}
                onClick={() => {
                  report.refetch();
                  if (tab === "transfers") transfers.refetch();
                }}
              >
                Refresh financial workpaper
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The statement starts January 1 of the selected as-of year by default. Companies are never added beyond your
            authorized selection. This report includes selected company types; existing Group Net Position may exclude
            some.
          </p>
        </CardContent>
      </Card>
      {report.isError && (
        <p role="alert" className="text-destructive text-sm">
          {(report.error as Error).message}
        </p>
      )}
      {report.isFetching && <p className="text-sm text-muted-foreground">Reading member company accounting…</p>}
      {report.data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Consolidated ledger — provisional USD</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {(
                  [
                    ["Total assets", report.data.totals.assetsUsd],
                    ["Total liabilities", report.data.totals.liabilitiesUsd],
                    ["Total equity", report.data.totals.equityUsd],
                    ["Period income", report.data.totals.periodIncomeUsd],
                    ["Period cost of sales", report.data.totals.periodCostOfSalesUsd],
                    ["Period operating expenses", report.data.totals.periodOperatingExpensesUsd],
                    [
                      "Period result (pre internal-sale elimination)",
                      report.data.totals.periodResultBeforeInternalSalesEliminationUsd,
                    ],
                    ["Unmatched intercompany balances", report.data.totals.unmatchedIntercompanyUsd],
                  ] as Array<[string, string]>
                ).map(([title, value]) => (
                  <div key={title}>
                    <p className="text-xs text-muted-foreground">{title}</p>
                    <p className="font-semibold text-lg tabular-nums">{value}</p>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Original debits</span>
                  <p className="font-medium tabular-nums">{report.data.totals.grossDebitUsd}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Original credits</span>
                  <p className="font-medium tabular-nums">{report.data.totals.grossCreditUsd}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Presentation-only elimination</span>
                  <p className="font-medium tabular-nums">{report.data.totals.eliminationDebitUsd} per side</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Adjusted debits</span>
                  <p className="font-medium tabular-nums">{report.data.totals.adjustedDebitUsd}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Adjusted credits</span>
                  <p className="font-medium tabular-nums">{report.data.totals.adjustedCreditUsd}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Unbalanced difference</span>
                  <p className="font-medium tabular-nums">{report.data.totals.adjustedUnbalancedUsd}</p>
                </div>
              </div>
              <p className="text-sm font-semibold">This is not a certified consolidated financial statement.</p>
              {report.data.certification.blockers.map((w, i) => (
                <p className="text-xs text-muted-foreground" key={i}>
                  • {w}
                </p>
              ))}
            </CardContent>
          </Card>
          <div className="flex flex-wrap gap-2">
            {(["pairs", "trial", "transfers", "workpaper"] as const).map((t) => (
              <Button size="sm" key={t} variant={tab === t ? "default" : "outline"} onClick={() => setTab(t)}>
                {t === "pairs"
                  ? "Intercompany pairs"
                  : t === "trial"
                    ? "Trial balance"
                    : t === "transfers"
                      ? "Transfer integrity"
                      : "Elimination workpaper"}
              </Button>
            ))}
          </div>
          {tab === "pairs" && (
            <Card>
              <CardHeader>
                <CardTitle>Paired intercompany balances</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Two-way unmatched amounts stay visible. Shared accounts involving several counterparties are not
                  arbitrarily allocated to one company.
                </p>
                <div className="max-h-[630px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Companies</th>
                        <th className="p-2 text-right">Receivable USD</th>
                        <th className="p-2 text-right">Payable USD</th>
                        <th className="p-2 text-right">Matched USD</th>
                        <th className="p-2 text-right">Residual USD</th>
                        <th className="p-2">Review</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.data.pairs
                        .filter((p) => !onlyIssues || p.status !== "matched" || p.reason)
                        .map((p) => (
                          <tr key={p.companyIds.join(":")} className="border-b align-top">
                            <td className="p-2">{p.companyNames.join(" ↔ ")}</td>
                            <td className="p-2 text-right tabular-nums">{p.receivables}</td>
                            <td className="p-2 text-right tabular-nums">{p.payables}</td>
                            <td className="p-2 text-right tabular-nums">
                              {p.matchedUsd}
                              <div className="text-xs text-muted-foreground">Applied: {p.appliedUsd}</div>
                            </td>
                            <td className="p-2 text-right tabular-nums">{p.differenceUsd}</td>
                            <td className="p-2">
                              {label(p.status)}
                              {p.reason && <p className="text-destructive text-xs">{p.reason}</p>}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <label className="text-sm flex gap-2 items-center">
                  <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
                  Show mismatches or blocked pairs only
                </label>
              </CardContent>
            </Card>
          )}
          {tab === "trial" && (
            <GroupConsolidationAccountingCardSection2
              filter={filter}
              financialRows={financialRows}
              includeZero={includeZero}
              setFilter={setFilter}
              setIncludeZero={setIncludeZero}
            />
          )}
          {tab === "transfers" && (
            <GroupConsolidationAccountingCardSection
              companyName={companyName}
              onlyIssues={onlyIssues}
              setOnlyIssues={setOnlyIssues}
              transfers={transfers}
            />
          )}
          {tab === "workpaper" && (
            <Card>
              <CardHeader>
                <CardTitle>Balanced presentation-only eliminations</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  These debits and credits exist only in this consolidated report. They are not accounting vouchers,
                  cannot be posted from this page and do not alter the selected companies.
                </p>
                <div className="max-h-[540px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Debit — internal payable</th>
                        <th className="p-2">Credit — internal receivable</th>
                        <th className="p-2 text-right">USD each side</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.data.eliminations.map((item, i) => (
                        <tr className="border-b" key={i}>
                          <td className="p-2">
                            {companyName(item.debitCompanyId)} · Ledger #{item.debitAccountId}
                          </td>
                          <td className="p-2">
                            {companyName(item.creditCompanyId)} · Ledger #{item.creditAccountId}
                          </td>
                          <td className="p-2 text-right tabular-nums">{item.amountUsd}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!report.data.eliminations.length && (
                  <p className="text-sm text-muted-foreground">
                    No source-verified two-company matching adjustments could be produced for this selection.
                  </p>
                )}
                <p className="text-sm font-semibold">Source postings changed: zero.</p>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Consolidation accounting limits</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              {Object.values(report.data.policy).map((v, i) => (
                <p key={i}>{v}</p>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
