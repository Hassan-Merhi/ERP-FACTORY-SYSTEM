import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import {
  HistoricalAccountingSection,
  HistoricalAccountingSection2,
  useHistoricalAccountingState,
} from "./useHistoricalAccountingState";
const prettify = (s: string) => s.replaceAll("_", " ").replace(/\b\w/g, (k) => k.toUpperCase());

export default function HistoricalAccounting() {
  const {
    accounts,
    asOf,
    from,
    includeZero,
    links,
    report,
    search,
    section,
    selected,
    setAsOf,
    setFrom,
    setIncludeZero,
    setSearch,
    setSection,
    setShowRetired,
    showRetired,
    stock,
    vouchers,
  } = useHistoricalAccountingState();
  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="historical-accounting">
      <PageHeader
        title="Historical Accounting & As-of Dates"
        subtitle="Retrospective company ledger at the selected business date. Distinguishes posted ledger evidence from changes recorded afterward and source data whose former state cannot be reconstructed."
      />
      <Card>
        <CardHeader>
          <CardTitle>As-of financial period</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="history-from">Period from</Label>
              <Input id="history-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="history-asof">As-of business date</Label>
              <Input id="history-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button
                variant="outline"
                className="w-full"
                disabled={report.isFetching}
                onClick={() => {
                  report.refetch();
                  if (section === "stock" && asOf) stock.refetch();
                }}
              >
                Refresh historical evidence
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Date blank means the company business date. The period defaults to January 1 of the selected year. No as-of
            date posts, edits or reverses a voucher.
          </p>
        </CardContent>
      </Card>
      {report.isError && (
        <p role="alert" className="text-destructive text-sm">
          {(report.error as Error).message}
        </p>
      )}
      {report.isLoading && <p className="text-sm text-muted-foreground">Loading dated ledger evidence…</p>}
      {selected && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Retrospective accounting balances (USD)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm">
                {selected.fromDate} → {selected.asOfDate} · Accounting basis: {prettify(selected.basis)} · Trial
                balance:{" "}
                {selected.balance.balanced ? "Balanced under current ledger rules" : "Not balanced; no plug applied"}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {(
                  [
                    ["Opening debits", selected.balance.totals.openingDebit],
                    ["Opening credits", selected.balance.totals.openingCredit],
                    ["Closing debits", selected.balance.totals.closingDebit],
                    ["Closing credits", selected.balance.totals.closingCredit],
                    ["Unexplained difference", selected.balance.unexplainedDifferenceUsd],
                    ["Period income", selected.pnl.incomeUsd],
                    ["Period COGS", selected.pnl.costOfSalesUsd],
                    ["Period operating expenses", selected.pnl.otherExpensesUsd],
                    ["Period result (provisional)", selected.pnl.profitBeforeOtherEliminationsUsd],
                  ] as Array<[string, string]>
                ).map(([key, val]) => (
                  <div key={key}>
                    <p className="text-xs text-muted-foreground">{key}</p>
                    <p className="text-lg font-semibold tabular-nums">{val}</p>
                  </div>
                ))}
              </div>
              <p className="text-sm font-semibold">
                Historical certification: unavailable. This is not a system-time or legally certified financial
                statement.
              </p>
              {selected.reliability.blockers.map((x, i) => (
                <p key={i} className="text-sm text-destructive">
                  {x}
                </p>
              ))}
            </CardContent>
          </Card>
          <div className="flex flex-wrap gap-2">
            {(["trial", "timeline", "matching", "stock", "limits"] as const).map((s) => (
              <Button key={s} size="sm" variant={section === s ? "default" : "outline"} onClick={() => setSection(s)}>
                {
                  (
                    {
                      trial: "Trial balance",
                      timeline: "Posting chronology",
                      matching: "Reconciliation evidence",
                      stock: "ERP stock at cost",
                      limits: "Historical data limitations",
                    } as const
                  )[s]
                }
              </Button>
            ))}
          </div>
          {section === "trial" && (
            <Card>
              <CardHeader>
                <CardTitle>Account and party balances</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    placeholder="Find account, type or code"
                    className="max-w-xs"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <label className="text-sm flex gap-2 items-center">
                    <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />{" "}
                    Include zero balances
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  {selected.balance.openingSidesAssumed} opening-side assumption(s). Source balances are from live
                  posted vouchers effective by the selected date; retired vouchers are excluded under the canonical
                  ledger policy.
                </p>
                <HistoricalAccountingSection2 accounts={accounts} />
              </CardContent>
            </Card>
          )}
          {section === "timeline" && (
            <Card>
              <CardHeader>
                <CardTitle>Vouchers whose recorded lifecycle crosses the date</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Business posting date and creation/retirement timestamp are different. Later backdated entries may
                  appear in today's retrospective balances even though they did not exist on the selected historic day.
                  No historical contents are reconstructed after an edit.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {Object.entries(selected.postingEvidence.totals).map(([k, v]) => (
                    <div key={k}>
                      <p className="text-xs text-muted-foreground">{prettify(k)}</p>
                      <p className="font-semibold tabular-nums">{v}</p>
                    </div>
                  ))}
                </div>
                <label className="flex gap-2 text-sm items-center">
                  <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />{" "}
                  Include retired source documents
                </label>
                {selected.postingEvidence.truncated && (
                  <p className="text-xs text-destructive">
                    At most {selected.postingEvidence.sampleLimit} documents shown; counts are across all qualifying
                    vouchers.
                  </p>
                )}
                <HistoricalAccountingSection vouchers={vouchers} />
              </CardContent>
            </Card>
          )}
          {section === "matching" && (
            <Card>
              <CardHeader>
                <CardTitle>Reconciliation and FX evidence</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Matching, statement imports and FX recognition are operational events, not extra vouchers. Their
                  recorded timestamps need not equal the source accounting business date.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Source</th>
                        <th className="p-2 text-right">Count</th>
                        <th className="p-2 text-right">Recorded afterward</th>
                        <th className="p-2 text-right">Currently voided</th>
                        <th className="p-2 text-right">Voided afterward</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.reconciliationEvidence.items.map((r) => (
                        <tr key={r.source} className="border-b">
                          <td className="p-2">{prettify(r.source)}</td>
                          {[r.total, r.recordedAfterAsOf, r.voidedCurrently, r.voidedAfterAsOf].map((v, i) => (
                            <td key={i} className="p-2 text-right tabular-nums">
                              {v}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-sm">
                  Historical currency readiness:{" "}
                  {selected.historicalFx.legacyCompatibilityMode
                    ? "Legacy compatibility mode — historical USD conversion unverified"
                    : selected.historicalFx.ready
                      ? "Historical base-field completeness passed (not certification)"
                      : "Unresolved historical non-USD entries or openings detected"}
                  .
                </p>
                <p className="text-xs text-muted-foreground">{selected.historicalFx.note}</p>
              </CardContent>
            </Card>
          )}
          {section === "stock" && (
            <Card>
              <CardHeader>
                <CardTitle>Replayed ERP stock cost</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {!asOf && (
                  <p className="text-sm text-muted-foreground">
                    Select an explicit as-of date above before running ERP stock replay.
                  </p>
                )}
                {asOf && stock.isFetching && <p className="text-sm">Loading ERP stock replay…</p>}
                {stock.isError && <p className="text-sm text-destructive">{(stock.error as Error).message}</p>}
                {stock.data && (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-xs text-muted-foreground">ERP stock at cost (USD)</p>
                        <p className="text-lg font-semibold">{stock.data.report.total}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">ERP subledger signed value (USD)</p>
                        <p className="text-lg font-semibold">{stock.data.report.subLedgerTotal}</p>
                      </div>
                    </div>
                    {stock.data.caveats.map((x, i) => (
                      <p key={i} className="text-sm text-muted-foreground">
                        {x}
                      </p>
                    ))}
                  </>
                )}
                <p className="text-sm font-medium">
                  Factory raw/WIP/finished historic cost is not reconstructed from today's overwritten material and bale
                  costs.
                </p>
              </CardContent>
            </Card>
          )}
          {section === "limits" && (
            <Card>
              <CardHeader>
                <CardTitle>Historical evidence limitations</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm font-semibold">
                  Knowledge-at-date reconstruction is not available from the existing mutable source records. This
                  report is retrospective only.
                </p>
                {selected.reliability.warnings.map((s, i) => (
                  <p key={i} className="text-sm">
                    {s}
                  </p>
                ))}
                <div className="space-y-1">
                  {Object.entries(selected.sourceAvailability).map(([name, state]) => (
                    <div key={name} className="flex flex-wrap gap-2 justify-between border-b py-1 text-sm">
                      <span className="font-medium">{prettify(name)}</span>
                      <span className="text-muted-foreground">{prettify(state)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {links.map(([title, href]) => (
                    <a key={title} className="underline text-sm" href={href}>
                      {title}
                    </a>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
