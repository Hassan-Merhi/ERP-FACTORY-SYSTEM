/**
 * Phase 9: intercompany / provisional consolidation.
 * Source journals are never edited; proposed Dr/Cr eliminations are reporting
 * adjustments ONLY. This screen is not a certified consolidated statement.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Company {
  id: number;
  code: string;
  name: string;
  companyType: string;
  baseCurrency: string;
  parentCompanyId: number | null;
}
interface CompanyList {
  companies: Company[];
  scope: string;
}
type FinancialRow = {
  companyId: number;
  companyName: string;
  companyCode: string;
  accountKind: string;
  accountId: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  financialClass: string;
  openingSideAssumed: boolean;
  bookedUsd: string;
  periodMovementUsd: string;
  eliminationUsd: string;
  adjustedUsd: string;
};
interface Pair {
  companyIds: number[];
  companyNames: string[];
  status: string;
  receivables: string;
  payables: string;
  matchedUsd: string;
  differenceUsd: string;
  appliedUsd: string;
  reason: string | null;
}
interface Elimination {
  pairCompanyIds: number[];
  debitCompanyId: number;
  debitAccountId: number;
  creditCompanyId: number;
  creditAccountId: number;
  amountUsd: string;
  narrative: string;
  posted: false;
}
interface Consolidation {
  asOfDate: string;
  fromDate: string;
  currency: "USD";
  mode: "PROVISIONAL_LEDGER_CONSOLIDATION";
  companies: Array<
    Company & {
      companyId: number;
      companyName: string;
      companyCode: string;
      balances: number;
      historicalFxReady: boolean;
      unresolvedCurrencyCount: number;
    }
  >;
  rows: FinancialRow[];
  pairs: Pair[];
  eliminations: Elimination[];
  totals: {
    grossDebitUsd: string;
    grossCreditUsd: string;
    grossUnbalancedUsd: string;
    eliminationDebitUsd: string;
    eliminationCreditUsd: string;
    adjustedDebitUsd: string;
    adjustedCreditUsd: string;
    adjustedUnbalancedUsd: string;
    assetsUsd: string;
    liabilitiesUsd: string;
    equityUsd: string;
    periodIncomeUsd: string;
    periodCostOfSalesUsd: string;
    periodOperatingExpensesUsd: string;
    periodResultBeforeInternalSalesEliminationUsd: string;
    unmatchedIntercompanyUsd: string;
  };
  certification: {
    historicalFxResolved: boolean;
    unknownBalanceRows: number;
    unknownAmountUsd: string;
    unpairedOrMismatchedPairs: number;
    blockedEliminationPairs: number;
    bookBalanced: boolean;
    certified: false;
    blockers: string[];
  };
  policy: Record<string, string>;
}
interface Transfer {
  transferId: number;
  type: string;
  fromCompanyId: number;
  toCompanyId: number;
  transferDate: string;
  amountSourceUsd: string;
  fromVoucherId: number | null;
  toVoucherId: number | null;
  fromVoucherNumber: string | null;
  toVoucherNumber: string | null;
  sourceSideUsd: string | null;
  destinationSideUsd: string | null;
  status: string;
  explanation: string;
}
interface TransferReport {
  rows: Transfer[];
  summary: { total: number; matched: number; flagged: number; truncated: boolean };
  policy: string;
}
async function read<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? "Accounting report could not be loaded");
  return data as T;
}
const label = (s: string) => s.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
export default function GroupConsolidationAccounting() {
  const [chosen, setChosen] = useState<number[]>([]);
  const [from, setFrom] = useState("");
  const [asOf, setAsOf] = useState("");
  const [filter, setFilter] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [tab, setTab] = useState<"pairs" | "trial" | "transfers" | "workpaper">("pairs");
  const companies = useQuery<CompanyList>({
    queryKey: ["/api/accounting/consolidation/companies"],
    queryFn: () => read("/api/accounting/consolidation/companies"),
    retry: false,
  });
  const available = companies.data?.companies ?? [];
  useEffect(() => {
    if (available.length && chosen.length === 0) {
      setChosen(available.map((x) => x.id));
    }
    // Identity of accessible selection is defined by company IDs, not array object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies.data?.scope, available.map((x) => x.id).join(",")]);
  const companyString = useMemo(
    () =>
      chosen
        .slice()
        .sort((a, b) => a - b)
        .join(","),
    [chosen]
  );
  const query = new URLSearchParams({ companyIds: companyString });
  if (from) query.set("fromDate", from);
  if (asOf) query.set("asOfDate", asOf);
  const ready = chosen.length > 0 && companies.isSuccess;
  const report = useQuery<Consolidation>({
    queryKey: ["/api/accounting/consolidation/report", companyString, from, asOf],
    queryFn: () => read("/api/accounting/consolidation/report?" + query.toString()),
    enabled: ready,
    retry: false,
  });
  const transfers = useQuery<TransferReport>({
    queryKey: ["/api/accounting/consolidation/transfers", companyString, asOf],
    queryFn: () => {
      const p = new URLSearchParams({ companyIds: companyString });
      if (asOf) p.set("asOfDate", asOf);
      return read("/api/accounting/consolidation/transfers?" + p.toString());
    },
    enabled: ready && tab === "transfers",
    retry: false,
  });
  const companyName = (id: number) => available.find((c) => c.id === id)?.name ?? "Company #" + id;
  const financialRows = useMemo(
    () =>
      report.data?.rows.filter(
        (x) =>
          (includeZero || Math.abs(Number(x.bookedUsd)) + Math.abs(Number(x.eliminationUsd)) > 0.005) &&
          (!filter ||
            [x.companyName, x.name, x.code, x.accountKind, x.financialClass].some((s) =>
              String(s ?? "")
                .toLowerCase()
                .includes(filter.toLowerCase())
            ))
      ) ?? [],
    [report.data, includeZero, filter]
  );
  // A voucher belongs to its own company. Opening its ID inside the user's
  // selected company would show the wrong ledger or leak an unrelated voucher.
  // Display reference and owner company; switch to that company to drill in.
  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="group-accounting-consolidation">
      <div>
        <h1 className="text-2xl font-semibold">Intercompany & Consolidation</h1>
        <p className="text-sm text-muted-foreground">
          USD ledger workpaper across authorized companies: trial balances, paired intercompany receivables/payables,
          reconciliation and hypothetical elimination entries. Source vouchers remain unchanged.
        </p>
      </div>
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
            <Card>
              <CardHeader>
                <CardTitle>Member GL trial balance at historical USD</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-3 items-center">
                  <Input
                    className="max-w-xs"
                    placeholder="Search company, account, code or class"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <label className="flex gap-2 items-center text-sm">
                    <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />{" "}
                    Show zero-balance lines
                  </label>
                </div>
                <div className="max-h-[650px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Company</th>
                        <th className="p-2">Account</th>
                        <th className="p-2">Class</th>
                        <th className="p-2 text-right">Booked USD</th>
                        <th className="p-2 text-right">Period movement</th>
                        <th className="p-2 text-right">Elimination</th>
                        <th className="p-2 text-right">Adjusted USD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {financialRows.map((r, i) => (
                        <tr
                          className="border-b align-top"
                          key={r.companyId + ":" + r.accountKind + ":" + r.accountId + ":" + i}
                        >
                          <td className="p-2">{r.companyName}</td>
                          <td className="p-2">
                            {r.code ?? r.accountKind}: {r.name}
                            {r.openingSideAssumed && (
                              <div className="text-xs text-muted-foreground">Opening balance side was inferred</div>
                            )}
                          </td>
                          <td className="p-2">{r.financialClass}</td>
                          <td className="p-2 text-right tabular-nums">{r.bookedUsd}</td>
                          <td className="p-2 text-right tabular-nums">{r.periodMovementUsd}</td>
                          <td className="p-2 text-right tabular-nums">{r.eliminationUsd}</td>
                          <td className="p-2 text-right tabular-nums">{r.adjustedUsd}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
          {tab === "transfers" && (
            <Card>
              <CardHeader>
                <CardTitle>Cash and loan transfer legs</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {transfers.isFetching && <p className="text-sm text-muted-foreground">Loading transfer evidence…</p>}
                {transfers.isError && <p className="text-destructive text-sm">{(transfers.error as Error).message}</p>}
                {transfers.data && (
                  <>
                    <p className="text-sm">
                      Checked {transfers.data.summary.total} · Matched
                      {" " + transfers.data.summary.matched} · Flagged {transfers.data.summary.flagged}
                      {transfers.data.summary.truncated ? " · Latest 250 per company (truncated)" : ""}
                    </p>
                    <div className="max-h-[600px] overflow-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left">
                            <th className="p-2">Transfer</th>
                            <th className="p-2">Companies</th>
                            <th className="p-2 text-right">Source USD</th>
                            <th className="p-2">From voucher</th>
                            <th className="p-2">To voucher</th>
                            <th className="p-2">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {transfers.data.rows
                            .filter((t) => !onlyIssues || t.status !== "matched")
                            .map((t) => (
                              <tr key={t.transferId} className="border-b align-top">
                                <td className="p-2">
                                  #{t.transferId} · {t.type}
                                  <div className="text-xs">{t.transferDate}</div>
                                </td>
                                <td className="p-2">
                                  {companyName(t.fromCompanyId)}
                                  <div className="text-muted-foreground">→ {companyName(t.toCompanyId)}</div>
                                </td>
                                <td className="p-2 text-right tabular-nums">{t.amountSourceUsd}</td>
                                <td className="p-2">
                                  {t.fromVoucherId ? (
                                    <span>{t.fromVoucherNumber ?? "#" + t.fromVoucherId}</span>
                                  ) : (
                                    "Missing"
                                  )}
                                  <div className="text-xs">Interco GL: {t.sourceSideUsd ?? "Missing"}</div>
                                </td>
                                <td className="p-2">
                                  {t.toVoucherId ? <span>{t.toVoucherNumber ?? "#" + t.toVoucherId}</span> : "Missing"}
                                  <div className="text-xs">Interco GL: {t.destinationSideUsd ?? "Missing"}</div>
                                </td>
                                <td className="p-2">
                                  {label(t.status)}
                                  <div className="text-xs text-muted-foreground">{t.explanation}</div>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
                      Show only flagged transfers
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Voucher IDs belong to their own company. Switch to that authorized company before opening its
                      original voucher; this page never substitutes the active company's voucher.
                    </p>
                    <p className="text-xs text-muted-foreground">{transfers.data.policy}</p>
                  </>
                )}
              </CardContent>
            </Card>
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
