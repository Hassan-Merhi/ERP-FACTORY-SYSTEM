import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Severity = "clear" | "review" | "critical" | "expected";
type Container = {
  id: number;
  number: string;
  status: string;
  currency: string;
  rateConfirmed: boolean;
  receiptCount: number;
  receiptKg: string;
  receiptsUsd: string | null;
  rawReceivedKg: string;
  rawUsedKg: string;
  rawRemainingUsd: string | null;
  originalReceivedKg: string | null;
  declaredKg: string | null;
  firstReceiptDate: string | null;
  lastReceiptDate: string | null;
  issues: string[];
  severity: Severity;
};
type Invoice = {
  orderId: number;
  invoiceNumber: string | null;
  containerNumber: string | null;
  status: string;
  invoiceDate: string;
  grandTotal: string;
  customerId: number;
  postedVoucherId: number | null;
  postedVoucherDate: string | null;
  expectedReceivableNative: string | null;
  postedReceivableNative: string | null;
  postedReceivableUsd: string | null;
  costOfBalesUsd: string;
  postedCogsUsd: string | null;
  postedFinishedGoodsCreditUsd: string | null;
  bales: number;
  issues: string[];
  severity: Severity;
};
type Audit = {
  companyId: number;
  asOfDate: string;
  reportCurrency: string;
  postingReady: boolean;
  cutover: { effectiveFrom: string; openingVoucherId: number | null } | null;
  supplierPartner: boolean;
  valuation: {
    basis: "CURRENT_COSTING" | "CURRENT_COSTING_NOT_HISTORICAL";
    asOfDate: string;
    rawUsd: string;
    wipUsd: string;
    finishedUsd: string;
    totalUsd: string;
    goodsInTransitUsd: string;
    reservedForOpenOrders: { bales: number; cost: string };
    soldNotInvoiced: { bales: number; cost: string };
    unvalued: Array<{ source: string; id: number; reason: string }>;
    ledger: Record<string, { amount: string; difference: string | null }>;
    journal: { number: string; id: number | null; date: string | null };
  };
  containers: Container[];
  invoices: Invoice[];
  summary: {
    containers: number;
    invoices: number;
    unfinalized: number;
    missingFinalizedInvoices: number;
    prematureCustomerPostings: number;
    unverifiedContainerCosts: number;
    unvaluedStock: number;
    critical: number;
    review: number;
    truncated: boolean;
  };
  warnings: string[];
  policy: {
    draftAndVerifiedOrders: string;
    invoiceDate: string;
    freight: string;
    costValuation: string;
    productionVariance: string;
    factoryReceipts: string;
    transfers: string;
    cutover: string;
    historical: string;
  };
};
async function load(url: string): Promise<Audit> {
  const r = await fetch(url, { credentials: "include" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || "Factory accounting report could not be loaded");
  return j as Audit;
}
function severityLabel(s: Severity) {
  return s === "clear"
    ? "No flagged issues"
    : s === "critical"
      ? "Critical review"
      : s === "review"
        ? "Review required"
        : "Expected";
}
function statLabel(s: string) {
  return s.replace(/([A-Z])/g, " $1").trim();
}
export default function FactoryProductionAccounting() {
  const [path] = useLocation();
  const factory = path.startsWith("/factory/");
  const [date, setDate] = useState("");
  const [show, setShow] = useState<"all" | "critical" | "review">("all");
  const [section, setSection] = useState<"invoices" | "containers">("invoices");
  const query = useQuery<Audit>({
    queryKey: ["/api/accounting/factory-production/audit", date],
    queryFn: () =>
      load("/api/accounting/factory-production/audit" + (date ? "?asOfDate=" + encodeURIComponent(date) : "")),
    retry: false,
  });
  const report = query.data;
  const invoices = useMemo(
    () => report?.invoices.filter((i) => show === "all" || i.severity === show) ?? [],
    [report, show]
  );
  const containers = useMemo(
    () => report?.containers.filter((i) => show === "all" || i.severity === show) ?? [],
    [report, show]
  );
  const voucher = (id: number) => (factory ? `/factory/voucher-detail/${id}` : `/voucher-detail/${id}`);
  const target = factory ? "/factory/containers-hub" : "/inventory";
  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="factory-production-accounting">
      <div>
        <h1 className="text-2xl font-semibold">Factory Production & Container Accounting</h1>
        <p className="text-sm text-muted-foreground">
          Read-only accounting trace: containers → raw materials → mixes → bales → finalized invoices. Existing Factory
          cost and financial posting engines remain authoritative.
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-5">
          <div className="space-y-1">
            <Label htmlFor="factory-accounting-date">As-of source date</Label>
            <Input id="factory-accounting-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? "Loading…" : "Refresh accounting audit"}
          </Button>
          <a className="rounded-md border px-3 py-2 text-sm" href={target}>
            Open inventory / containers
          </a>
        </CardContent>
      </Card>
      {query.isError && (
        <p role="alert" className="text-sm text-destructive">
          {(query.error as Error).message}
        </p>
      )}
      {query.isLoading && <p className="text-sm text-muted-foreground">Loading Factory accounting…</p>}
      {report && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Current stock at booked material cost (USD)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {(
                  [
                    ["Raw material", report.valuation.rawUsd],
                    ["Work in progress", report.valuation.wipUsd],
                    ["Finished bales", report.valuation.finishedUsd],
                    ["Total Factory stock", report.valuation.totalUsd],
                    ["Held Goods in Transit", report.valuation.goodsInTransitUsd],
                    ["Reserved in unfinalized orders", report.valuation.reservedForOpenOrders.cost],
                    ["Sold but not invoiced", report.valuation.soldNotInvoiced.cost],
                    ["Unvalued stock records", String(report.valuation.unvalued.length)],
                  ] as Array<[string, string]>
                ).map(([label, amount]) => (
                  <div key={label}>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="text-lg font-semibold tabular-nums">{amount}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                These are the existing Factory costing values as of
                {" " + report.valuation.asOfDate}. They are never recalculated from selling prices.
              </p>
              {report.valuation.basis === "CURRENT_COSTING_NOT_HISTORICAL" && (
                <p className="text-sm text-destructive">
                  Historical raw, mixed, and bale costs are not replayable from current rows. The valuation above is
                  current costing, not the selected historic date.
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="p-2">Control account</th>
                      <th className="p-2 text-right">Posted GL (USD)</th>
                      <th className="p-2 text-right">GL − cost difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(report.valuation.ledger).map(([code, item]) => (
                      <tr key={code} className="border-b">
                        <td className="p-2">{code.replaceAll("_", " ")}</td>
                        <td className="p-2 text-right tabular-nums">{item.amount}</td>
                        <td className="p-2 text-right tabular-nums">{item.difference ?? "Not comparable"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                Daily stock journal:{" "}
                {report.valuation.journal.id ? (
                  <a className="underline" href={voucher(report.valuation.journal.id)}>
                    {report.valuation.journal.number}
                  </a>
                ) : (
                  report.valuation.journal.number + " (not posted)"
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                Perpetual inventory cutover: {report.cutover?.effectiveFrom ?? "not applied"} · Posting gate:{" "}
                {report.postingReady ? "enabled" : "disabled"}. This page does not activate it.
              </p>
            </CardContent>
          </Card>
          {report.warnings.map((w, i) => (
            <p key={i} className="text-sm text-muted-foreground">
              {w}
            </p>
          ))}
          <Card>
            <CardHeader>
              <CardTitle>Accounting source review</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {Object.entries(report.summary)
                  .filter(([k]) => k !== "truncated")
                  .map(([k, v]) => (
                    <div key={k}>
                      <p className="text-xs text-muted-foreground">{statLabel(k)}</p>
                      <p className="text-lg font-semibold tabular-nums">{v}</p>
                    </div>
                  ))}
              </div>
              {report.summary.truncated && (
                <p className="text-sm text-destructive">
                  Only the latest 200 containers and orders are shown. Older source documents have not been reviewed in
                  this view.
                </p>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label>Source</Label>
                  <select
                    className="block h-9 rounded-md border bg-background px-2 text-sm"
                    value={section}
                    onChange={(e) => setSection(e.target.value as "invoices" | "containers")}
                  >
                    <option value="invoices">Customer order invoices</option>
                    <option value="containers">Supplier containers and receipts</option>
                  </select>
                </div>
                <div>
                  <Label>Review status</Label>
                  <select
                    className="block h-9 rounded-md border bg-background px-2 text-sm"
                    value={show}
                    onChange={(e) => setShow(e.target.value as "all" | "critical" | "review")}
                  >
                    <option value="all">All</option>
                    <option value="critical">Critical review</option>
                    <option value="review">Needs review</option>
                  </select>
                </div>
              </div>
              {section === "invoices" ? (
                <div className="max-h-[650px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Order / container</th>
                        <th className="p-2">Status / date</th>
                        <th className="p-2 text-right">Invoice amount</th>
                        <th className="p-2 text-right">Bale cost USD</th>
                        <th className="p-2">Voucher</th>
                        <th className="p-2">Audit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map((row) => (
                        <tr key={row.orderId} className="border-b align-top">
                          <td className="p-2">
                            #{row.orderId}
                            <div className="text-xs text-muted-foreground">
                              {row.invoiceNumber || row.containerNumber || "—"}
                            </div>
                          </td>
                          <td className="p-2">
                            {row.status}
                            <div className="text-xs text-muted-foreground">{row.invoiceDate}</div>
                          </td>
                          <td className="p-2 text-right tabular-nums">
                            {row.grandTotal}
                            {row.status === "FINALIZED" && (
                              <div className="text-xs text-muted-foreground">
                                Invoice net: {row.expectedReceivableNative}
                              </div>
                            )}
                          </td>
                          <td className="p-2 text-right tabular-nums">
                            {row.costOfBalesUsd}
                            <div className="text-xs text-muted-foreground">{row.bales} bales</div>
                          </td>
                          <td className="p-2">
                            {row.postedVoucherId ? (
                              <a className="underline" href={voucher(row.postedVoucherId)}>
                                #{row.postedVoucherId}
                              </a>
                            ) : (
                              <span className="text-xs text-muted-foreground">No GL invoice</span>
                            )}
                          </td>
                          <td className="p-2">
                            <span
                              className={row.severity === "critical" ? "text-destructive" : "text-muted-foreground"}
                            >
                              {severityLabel(row.severity)}
                            </span>
                            {row.issues.map((msg, i) => (
                              <div key={i} className="text-xs">
                                {msg}
                              </div>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!invoices.length && (
                    <p className="p-3 text-sm text-muted-foreground">No orders match these filters.</p>
                  )}
                </div>
              ) : (
                <div className="max-h-[650px] overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">Container</th>
                        <th className="p-2">Native FX</th>
                        <th className="p-2 text-right">Received KG</th>
                        <th className="p-2 text-right">Receipt USD</th>
                        <th className="p-2 text-right">Raw remaining USD</th>
                        <th className="p-2">Audit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {containers.map((c) => (
                        <tr key={c.id} className="border-b align-top">
                          <td className="p-2">
                            {c.number}
                            <div className="text-xs text-muted-foreground">{c.status}</div>
                          </td>
                          <td className="p-2">
                            {c.currency}
                            <div className="text-xs">{c.rateConfirmed ? "Rate confirmed" : "Unconfirmed"}</div>
                          </td>
                          <td className="p-2 text-right tabular-nums">
                            {c.receiptKg}
                            <div className="text-xs text-muted-foreground">Raw {c.rawReceivedKg}</div>
                          </td>
                          <td className="p-2 text-right tabular-nums">{c.receiptsUsd ?? "Unverified"}</td>
                          <td className="p-2 text-right tabular-nums">{c.rawRemainingUsd ?? "Unverified"}</td>
                          <td className="p-2">
                            <span className={c.severity === "critical" ? "text-destructive" : "text-muted-foreground"}>
                              {severityLabel(c.severity)}
                            </span>
                            {c.issues.map((issue, i) => (
                              <div key={i} className="text-xs">
                                {issue}
                              </div>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!containers.length && (
                    <p className="p-3 text-sm text-muted-foreground">No containers match these filters.</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Accounting rules protected</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              {Object.values(report.policy).map((rule, i) => (
                <p key={i}>{rule}</p>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
