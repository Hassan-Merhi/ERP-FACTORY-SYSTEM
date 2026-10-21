/**
 * Historical Accounting — retrospective ERP / Factory / Properties workpaper.
 * No mutations, no automatic backfills, no past-date false certification.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Row = {
  kind: string;
  id: number | null;
  code: string | null;
  name: string;
  accountType: string | null;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
  deleted: boolean;
};
type Voucher = {
  id: number;
  voucher_number: string;
  voucher_type: string;
  booked_on: string;
  created_on: string;
  deleted_on: string | null;
  currency: string;
  source_module: string | null;
  debit_base: string;
  credit_base: string;
  posted_now: boolean;
  late_created: boolean;
  later_retired: boolean;
};
type Workpaper = {
  companyId: number;
  asOfDate: string;
  fromDate: string;
  businessDate: string;
  basis: string;
  balance: {
    balanced: boolean;
    unexplainedDifferenceUsd: string;
    openingSidesAssumed: number;
    totals: {
      openingDebit: string;
      openingCredit: string;
      periodDebit: string;
      periodCredit: string;
      closingDebit: string;
      closingCredit: string;
    };
    differenceComponents: {
      openingBalances: string;
      singleSidedStockVouchers: string;
      otherUnbalancedVouchers: string;
    };
    rows: Row[];
  };
  pnl: {
    incomeUsd: string;
    costOfSalesUsd: string;
    otherExpensesUsd: string;
    profitBeforeOtherEliminationsUsd: string;
    excludesClosingJournals: boolean;
    historicalAccountClassificationVerified: boolean;
  };
  postingEvidence: {
    totals: {
      documents: number;
      currentlyLive: number;
      lateCreated: number;
      retiredAfterDate: number;
      retiredBeforeDate: number;
      lateCreatedDebitsUsd: string;
      lateCreatedCreditsUsd: string;
      currentlyLiveDebitsUsd: string;
      currentlyLiveCreditsUsd: string;
    };
    documents: Voucher[];
    sampleLimit: number;
    truncated: boolean;
  };
  reconciliationEvidence: {
    items: Array<{
      source: string;
      total: number;
      recordedAfterAsOf: number;
      voidedCurrently: number;
      voidedAfterAsOf: number;
    }>;
    isPostingLedger: false;
  };
  sourceAvailability: Record<string, string>;
  reliability: {
    financialTotals: string;
    historicalKnowledgeAtDate: string;
    certified: false;
    blockers: string[];
    warnings: string[];
  };
  historicalFx: {
    ready: boolean;
    legacyCompatibilityMode: boolean;
    unresolvedEntryCount: number;
    unresolvedVoucherCount: number;
    unresolvedLedgerOpeningCount: number;
    unresolvedBankOpeningCount: number;
    unresolvedCustomerOpeningCount: number;
    unresolvedSupplierOpeningCount: number;
    note: string;
    certified: false;
  };
};
type Stock = {
  asOfDate: string;
  mode: string;
  report: { total: string; subLedgerTotal: string; excluded?: Record<string, unknown> };
  certified: false;
  caveats: string[];
};
async function read<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message ?? "Historical accounting report unavailable");
  return body as T;
}
const prettify = (s: string) => s.replaceAll("_", " ").replace(/\b\w/g, (k) => k.toUpperCase());
export default function HistoricalAccounting() {
  const [location] = useLocation();
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const origin = location.startsWith("/factory/")
    ? "/factory"
    : location.startsWith("/properties/")
      ? "/properties"
      : "";
  const [asOf, setAsOf] = useState("");
  const [from, setFrom] = useState("");
  const [section, setSection] = useState<"trial" | "timeline" | "matching" | "stock" | "limits">("trial");
  const [search, setSearch] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [showRetired, setShowRetired] = useState(true);
  const params = new URLSearchParams();
  if (asOf) params.set("asOfDate", asOf);
  if (from) params.set("fromDate", from);
  const report = useQuery<Workpaper>({
    queryKey: ["/api/accounting/history/report", companyId, asOf, from],
    queryFn: () => read("/api/accounting/history/report?" + params.toString()),
    enabled: !!companyId,
    retry: false,
  });
  const stock = useQuery<Stock>({
    queryKey: ["/api/accounting/history/erp-stock", companyId, asOf],
    queryFn: () => read("/api/accounting/history/erp-stock?asOfDate=" + asOf),
    enabled: !!companyId && section === "stock" && !!asOf,
    retry: false,
  });
  const selected = report.data;
  const accounts = useMemo(
    () =>
      selected?.balance.rows.filter(
        (r) =>
          (includeZero || Math.abs(Number(r.closingDebit)) + Math.abs(Number(r.closingCredit)) > 0.005) &&
          (!search ||
            [r.name, r.code, r.kind, r.accountType].some((v) =>
              String(v ?? "")
                .toLowerCase()
                .includes(search.toLowerCase())
            ))
      ) ?? [],
    [selected, includeZero, search]
  );
  const vouchers = useMemo(
    () => selected?.postingEvidence.documents.filter((v) => showRetired || !v.deleted_on) ?? [],
    [selected, showRetired]
  );
  const links = [
    ["Bank / cash FX", origin + "/accounting/monetary-fx"],
    ["Rental accounting", origin + "/accounting/rentals"],
    ["Intercompany", origin + "/accounting/consolidation"],
    ...(origin === ""
      ? [
          ["ERP inventory audit", "/accounting/erp-inventory"],
          ["Factory production audit", "/accounting/factory-production"],
        ]
      : []),
    ...(origin === "/factory" ? [["Factory production audit", "/factory/accounting/production"]] : []),
  ];
  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="historical-accounting">
      <div>
        <h1 className="text-2xl font-semibold">Historical Accounting & As-of Dates</h1>
        <p className="text-sm text-muted-foreground">
          Retrospective company ledger at the selected business date. Distinguishes posted ledger evidence from changes
          recorded afterward and source data whose former state cannot be reconstructed.
        </p>
      </div>
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
                <div className="max-h-[660px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Account</th>
                        <th className="p-2">Kind / type</th>
                        <th className="p-2 text-right">Opening Dr</th>
                        <th className="p-2 text-right">Opening Cr</th>
                        <th className="p-2 text-right">Activity Dr</th>
                        <th className="p-2 text-right">Activity Cr</th>
                        <th className="p-2 text-right">Closing Dr</th>
                        <th className="p-2 text-right">Closing Cr</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accounts.map((r, i) => (
                        <tr key={r.kind + ":" + r.id + ":" + i} className="border-b">
                          <td className="p-2">
                            {r.code ?? r.kind}: {r.name}
                          </td>
                          <td className="p-2">
                            {r.kind}
                            <div className="text-xs text-muted-foreground">{r.accountType}</div>
                          </td>
                          {(
                            [
                              r.openingDebit,
                              r.openingCredit,
                              r.periodDebit,
                              r.periodCredit,
                              r.closingDebit,
                              r.closingCredit,
                            ] as string[]
                          ).map((v, j) => (
                            <td key={j} className="p-2 text-right tabular-nums">
                              {v}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
                <div className="max-h-[520px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Voucher</th>
                        <th className="p-2">Effective</th>
                        <th className="p-2">Recorded</th>
                        <th className="p-2">Retired</th>
                        <th className="p-2 text-right">Booked Dr/Cr USD</th>
                        <th className="p-2">Evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vouchers.map((v) => (
                        <tr key={v.id} className="border-b align-top">
                          <td className="p-2">
                            {v.voucher_number}
                            <div className="text-xs">
                              {v.voucher_type} · {v.source_module ?? "legacy"} · {v.currency}
                            </div>
                          </td>
                          <td className="p-2">{v.booked_on}</td>
                          <td className="p-2">{v.created_on}</td>
                          <td className="p-2">{v.deleted_on ?? "—"}</td>
                          <td className="p-2 text-right tabular-nums">
                            {v.debit_base} / {v.credit_base}
                          </td>
                          <td className="p-2">
                            {v.late_created ? "Entered later; effective earlier" : ""}
                            {v.later_retired && <div>Retired after as-of</div>}
                            {!v.posted_now && <div className="text-muted-foreground">Not in current live ledger</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
