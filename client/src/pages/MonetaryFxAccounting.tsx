/**
 * Phase 5: shared ERP / Factory / Properties currency accounting.
 *
 * Dated monetary revaluation is report-only by design. A realized FX journal
 * may be posted explicitly only for a valid, foreign-currency Phase 3 match.
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { MonetaryFxExportMenu } from "./MonetaryFxExportMenu";
import { currency } from "./MonetaryFxAccountingHelpers";
import { useMonetaryFxAccountingState } from "./useMonetaryFxAccountingState";
import { MonetaryFxAccountingCard } from "./MonetaryFxAccountingCard";

export default function MonetaryFxAccounting() {
  const {
    voucher,
    accounts,
    account,
    setAccount,
    asOfDate,
    setAsOfDate,
    domain,
    setDomain,
    partyId,
    setPartyId,
    reason,
    setReason,
    rates,
    valuation,
    realized,
    recognize,
  } = useMonetaryFxAccountingState();

  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="unified-monetary-fx">
      <PageHeader
        title="Multi-Currency Accounting"
        subtitle="Dated foreign-exchange rates, monetary cash/bank valuation and separately recognized invoice/payment exchange differences — ERP, Factory and Rentals."
      >
        <MonetaryFxExportMenu
          asOfDate={asOfDate}
          rates={rates.data}
          valuation={valuation.data}
          realized={realized.data}
        />
      </PageHeader>
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
            Original transactions and native balances never change. When a company rate is saved, one automatic FX
            revaluation journal brings cash, bank, customer and loan balances to the new rate.
          </p>
          <Label htmlFor="fx-account">Cash or bank account</Label>
          <Select
            value={account || "__none__"}
            onValueChange={(value) => setAccount(value === "__none__" ? "" : value)}
          >
            <SelectTrigger id="fx-account" className="h-10 w-full">
              <SelectValue placeholder="Select bank or cash account..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Select bank or cash account...</SelectItem>
              {(accounts.data ?? []).map((a) => (
                <SelectItem key={a.accountKind + ":" + a.accountId} value={a.accountKind + ":" + a.accountId}>
                  {a.name} ({a.accountKind})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
      <MonetaryFxAccountingCard
        asOfDate={asOfDate}
        domain={domain}
        partyId={partyId}
        realized={realized}
        reason={reason}
        recognize={recognize}
        setDomain={setDomain}
        setPartyId={setPartyId}
        setReason={setReason}
        voucher={voucher}
      />
    </div>
  );
}
