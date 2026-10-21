/**
 * Phase 5: shared ERP / Factory / Properties currency accounting.
 *
 * Dated monetary revaluation is report-only by design. A realized FX journal
 * may be posted explicitly only for a valid, foreign-currency Phase 3 match.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Phase 15 source-only rollout: an independent financial release is still required.
const UNIFIED_FINANCIAL_POSTING_CERTIFIED = false;
type Domain = "customer" | "supplier" | "factory_supplier";
type Account = { accountKind: "bank" | "ledger"; accountId: number; name: string };
type Rate = {
  currency: string;
  baseCurrency: string;
  effectiveDate: string;
  rateBasePerUnit: string;
  rateUnitPerBase: string;
  source: string;
  rateId: number | null;
};
type RateMatrix = { asOfDate: string; baseCurrency: string; rates: Array<{ currency: string; rate: Rate | null }> };
type Bucket = {
  currency: string;
  nativeBalance: string;
  historicalUsdBasis: string;
  rate: Rate | null;
  translatedUsd: string | null;
  unrealizedDifferenceUsd: string | null;
  verified: boolean;
  issues: string[];
  journalTreatment: string;
};
type Valuation = {
  accountName: string;
  accountKind: string;
  asOfDate: string;
  accountId: number;
  buckets: Bucket[];
  totals: {
    historicalUsd: string;
    translatedUsd: string | null;
    unrealizedDifferenceUsd: string | null;
    unresolvedCurrencies: string[];
    posting: string;
  };
};
type Realized = {
  matchId: number;
  domain: Domain;
  partyId: number;
  nativeCurrency: string;
  nativeMatchedAmount: string;
  chargeVoucher: string;
  settlementVoucher: string;
  chargeHistoricalUsd: string;
  settlementHistoricalUsd: string;
  realizedGainUsd: string;
  status: "ready" | "no_difference" | "recognized" | "reversed" | "blocked";
  postable: boolean;
  issue: string | null;
  recognitionVoucherId: number | null;
};
type RealizedList = {
  items: Realized[];
  asOfDate: string;
  limitedToMostRecent: number;
  recognitionStatusAsOf: boolean;
  asOfLimitations: string;
};
async function load<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? "Cannot load FX accounting report");
  return body as T;
}
function currency(v: string | null) {
  return v === null ? "Unavailable" : v;
}
export default function MonetaryFxAccounting() {
  const [location] = useLocation();
  const factory = location.startsWith("/factory/");
  const properties = location.startsWith("/properties/");
  const voucher = (id: number) =>
    factory
      ? `/factory/voucher-detail/${id}`
      : properties
        ? `/properties/voucher-detail/${id}`
        : `/voucher-detail/${id}`;
  const { toast } = useToast();
  const qc = useQueryClient();
  const accounts = useQuery<Account[]>({
    queryKey: ["/api/accounting/cash-bank/accounts"],
    queryFn: () => load("/api/accounting/cash-bank/accounts"),
    retry: false,
  });
  const [account, setAccount] = useState("");
  const [asOfDate, setAsOfDate] = useState("");
  const [domain, setDomain] = useState<Domain | "">("");
  const [partyId, setPartyId] = useState("");
  const [reason, setReason] = useState("");
  const target = useMemo(
    () => accounts.data?.find((a) => account === `${a.accountKind}:${a.accountId}`),
    [account, accounts.data]
  );
  const rates = useQuery<RateMatrix>({
    queryKey: ["/api/accounting/monetary-fx/rates", asOfDate],
    queryFn: () => load(`/api/accounting/monetary-fx/rates${asOfDate ? "?asOfDate=" + asOfDate : ""}`),
    retry: false,
  });
  const valuationUrl = target
    ? `/api/accounting/monetary-fx/cash-bank?accountKind=${target.accountKind}&accountId=${target.accountId}${asOfDate ? "&asOfDate=" + asOfDate : ""}`
    : null;
  const valuation = useQuery<Valuation>({
    queryKey: ["/api/accounting/monetary-fx/cash-bank", valuationUrl],
    queryFn: () => load(valuationUrl!),
    enabled: !!valuationUrl,
    retry: false,
  });
  const pId = partyId ? Number(partyId) : null;
  const query = new URLSearchParams();
  if (domain) query.set("domain", domain);
  if (pId && Number.isSafeInteger(pId) && pId > 0) query.set("partyId", String(pId));
  if (asOfDate) query.set("asOfDate", asOfDate);
  const realized = useQuery<RealizedList>({
    queryKey: ["/api/accounting/monetary-fx/realized", domain, partyId, asOfDate],
    queryFn: () => load(`/api/accounting/monetary-fx/realized?${query.toString()}`),
    retry: false,
  });
  const recognize = useMutation({
    mutationFn: async (matchId: number) => {
      const response = await apiRequest("POST", `/api/accounting/monetary-fx/realized/${matchId}/recognize`, {
        reason,
      });
      return response.json();
    },
    onSuccess: async () => {
      toast({
        title: "Realized FX journal posted",
        description: "Matched invoice and settlement originals remain unchanged.",
      });
      setReason("");
      await qc.invalidateQueries({ queryKey: ["/api/accounting/monetary-fx/realized"] });
      await qc.invalidateQueries({ queryKey: ["/api/accounting/monetary-fx/cash-bank"] });
    },
    onError: (err: Error) =>
      toast({ title: "FX recognition refused", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="unified-monetary-fx">
      <div>
        <h1 className="text-2xl font-semibold">Multi-Currency Accounting</h1>
        <p className="text-sm text-muted-foreground">
          Dated foreign-exchange rates, monetary cash/bank valuation and separately recognized invoice/payment exchange
          differences — ERP, Factory and Rentals.
        </p>
      </div>
      <Card>
        <CardContent className="grid gap-3 pt-5 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="fx-asof">As-of date</Label>
            <Input id="fx-asof" value={asOfDate} type="date" onChange={(e) => setAsOfDate(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                rates.refetch();
                valuation.refetch();
                realized.refetch();
              }}
            >
              Refresh FX analysis
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recorded company exchange rates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Stored company rates effective on or before the selected business date. A blank rate means no verified rate
            is recorded; no market or future rates are substituted. Factory costing retains its separate rate
            convention.
          </p>
          {rates.isError && <p className="text-sm text-destructive">{(rates.error as Error).message}</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">Currency</th>
                  <th className="p-2 text-right">USD per unit</th>
                  <th className="p-2 text-right">Units per USD</th>
                  <th className="p-2">Effective date</th>
                  <th className="p-2">Stored direction</th>
                </tr>
              </thead>
              <tbody>
                {(rates.data?.rates ?? []).map((row) => (
                  <tr key={row.currency} className="border-b">
                    <td className="p-2 font-medium">{row.currency}</td>
                    <td className="p-2 text-right tabular-nums">{row.rate?.rateBasePerUnit ?? "Missing"}</td>
                    <td className="p-2 text-right tabular-nums">{row.rate?.rateUnitPerBase ?? "Missing"}</td>
                    <td className="p-2">{row.rate?.effectiveDate ?? "—"}</td>
                    <td className="p-2 text-xs text-muted-foreground">{row.rate?.source ?? "No recorded rate"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>1. Cash and Bank — dated monetary revaluation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Valuation is informational. No revaluation journal or changes to original transactions are created when
            rates change.
          </p>
          <Label htmlFor="fx-account">Cash or bank account</Label>
          <select
            id="fx-account"
            className="h-10 w-full rounded-md border bg-background px-2"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="">Select bank or cash account...</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.accountKind + ":" + a.accountId} value={a.accountKind + ":" + a.accountId}>
                {a.name} ({a.accountKind})
              </option>
            ))}
          </select>
          {valuation.isError && <p className="text-sm text-destructive">{(valuation.error as Error).message}</p>}
          {accounts.isError && <p className="text-sm text-destructive">{(accounts.error as Error).message}</p>}
          {valuation.data && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="p-2">Currency</th>
                      <th className="p-2 text-right">Native balance</th>
                      <th className="p-2 text-right">Historical USD</th>
                      <th className="p-2 text-right">Dated USD / unit</th>
                      <th className="p-2 text-right">Translated USD</th>
                      <th className="p-2 text-right">Unrealized difference</th>
                      <th className="p-2">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {valuation.data.buckets.map((b) => (
                      <tr key={b.currency} className="border-b align-top">
                        <td className="p-2 font-medium">{b.currency}</td>
                        <td className="p-2 text-right tabular-nums">{b.nativeBalance}</td>
                        <td className="p-2 text-right tabular-nums">{b.historicalUsdBasis}</td>
                        <td className="p-2 text-right tabular-nums">{b.rate?.rateBasePerUnit ?? "Missing"}</td>
                        <td className="p-2 text-right tabular-nums">{currency(b.translatedUsd)}</td>
                        <td className="p-2 text-right tabular-nums">{currency(b.unrealizedDifferenceUsd)}</td>
                        <td className="p-2 text-xs">
                          {b.rate && (
                            <span>
                              {b.rate.source} · effective {b.rate.effectiveDate}
                            </span>
                          )}
                          {b.issues.map((issue, i) => (
                            <p className="text-destructive" key={i}>
                              {issue}
                            </p>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-muted-foreground">Historical USD</p>
                  <p className="font-semibold">{valuation.data.totals.historicalUsd}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Translated USD</p>
                  <p className="font-semibold">{currency(valuation.data.totals.translatedUsd)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Unrealized USD difference</p>
                  <p className="font-semibold">{currency(valuation.data.totals.unrealizedDifferenceUsd)}</p>
                </div>
              </div>
              {valuation.data.totals.unresolvedCurrencies.length > 0 && (
                <p className="text-destructive text-sm">
                  Total withheld until all currency evidence and dated rates are available:
                  {" " + valuation.data.totals.unresolvedCurrencies.join(", ")}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>2. Realized FX on matched invoices and settlements</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Calculated from recorded historical USD on each posted invoice/payment and the matched original-currency
            amount. Positive realized difference is an FX gain, negative is a loss. Factory suppliers follow their
            special inside/outside settlement policy, so this view does not automatically adjust them.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>Area</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-2"
                value={domain}
                onChange={(e) => setDomain(e.target.value as Domain | "")}
              >
                <option value="">All matched parties</option>
                <option value="customer">Customers</option>
                <option value="supplier">ERP suppliers</option>
                <option value="factory_supplier">Factory suppliers (report only)</option>
              </select>
            </div>
            <div>
              <Label>Party ID (optional)</Label>
              <Input type="number" min="1" value={partyId} onChange={(e) => setPartyId(e.target.value)} />
            </div>
            <div>
              <Label>Reason for authorized FX posting</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why recognize this realized difference?"
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Phase 15 source-release control: realized-FX accounting journals are locked pending independent Claude and
            finance certification, regardless of metadata pilot status. Dated valuation and reporting remain read-only.
          </p>
          {asOfDate && (
            <p className="text-sm text-muted-foreground">
              Historical as-of views are read-only and can never post an FX adjustment.
            </p>
          )}
          {asOfDate && realized.data && (
            <p className="text-xs text-muted-foreground">{realized.data.asOfLimitations}</p>
          )}
          {realized.isError && <p className="text-sm text-destructive">{(realized.error as Error).message}</p>}
          {realized.data && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2">Match / party</th>
                    <th className="p-2">Invoice / settlement</th>
                    <th className="p-2 text-right">Native matched</th>
                    <th className="p-2 text-right">Invoice basis USD</th>
                    <th className="p-2 text-right">Settlement basis USD</th>
                    <th className="p-2 text-right">Realized FX USD</th>
                    <th className="p-2">Posting</th>
                  </tr>
                </thead>
                <tbody>
                  {realized.data.items.map((item) => (
                    <tr key={item.matchId} className="border-b align-top">
                      <td className="p-2">
                        #{item.matchId}
                        <div className="text-xs text-muted-foreground">
                          {item.domain} #{item.partyId}
                        </div>
                      </td>
                      <td className="p-2">
                        {item.chargeVoucher}
                        <div className="text-muted-foreground">{item.settlementVoucher}</div>
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {item.nativeMatchedAmount} {item.nativeCurrency}
                      </td>
                      <td className="p-2 text-right tabular-nums">{item.chargeHistoricalUsd}</td>
                      <td className="p-2 text-right tabular-nums">{item.settlementHistoricalUsd}</td>
                      <td className="p-2 text-right tabular-nums">{item.realizedGainUsd}</td>
                      <td className="p-2">
                        <span>{item.status}</span>
                        {item.recognitionVoucherId && (
                          <div>
                            <a className="underline text-xs" href={voucher(item.recognitionVoucherId)}>
                              Journal #{item.recognitionVoucherId}
                            </a>
                          </div>
                        )}
                        {item.issue && <div className="text-xs text-destructive">{item.issue}</div>}
                        {item.postable && (
                          <div className="mt-2">
                            <Button
                              size="sm"
                              disabled={
                                !UNIFIED_FINANCIAL_POSTING_CERTIFIED ||
                                !!asOfDate ||
                                reason.trim().length < 3 ||
                                recognize.isPending
                              }
                              onClick={() => recognize.mutate(item.matchId)}
                            >
                              Recognize FX
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
