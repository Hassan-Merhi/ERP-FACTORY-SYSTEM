// Extracted from ./MonetaryFxAccounting.tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Domain } from "./monetaryFxAccountingTypes";
import { UNIFIED_FINANCIAL_POSTING_CERTIFIED } from "./MonetaryFxAccountingHelpers";
import { useMonetaryFxAccountingState } from "./useMonetaryFxAccountingState";

export function MonetaryFxAccountingCard({
  asOfDate,
  domain,
  partyId,
  realized,
  reason,
  recognize,
  setDomain,
  setPartyId,
  setReason,
  voucher,
}: Pick<
  ReturnType<typeof useMonetaryFxAccountingState>,
  | "asOfDate"
  | "domain"
  | "partyId"
  | "realized"
  | "reason"
  | "recognize"
  | "setDomain"
  | "setPartyId"
  | "setReason"
  | "voucher"
>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>2. Realized FX on matched invoices and settlements</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Calculated from recorded historical USD on each posted invoice/payment and the matched original-currency
          amount. Positive realized difference is an FX gain, negative is a loss. Factory suppliers follow their special
          inside/outside settlement policy, so this view does not automatically adjust them.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label>Area</Label>
            <Select
              value={domain || "__all__"}
              onValueChange={(value) => setDomain(value === "__all__" ? "" : (value as Domain))}
            >
              <SelectTrigger className="h-10 w-full" aria-label="Area">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All matched parties</SelectItem>
                <SelectItem value="customer">Customers</SelectItem>
                <SelectItem value="supplier">ERP suppliers</SelectItem>
                <SelectItem value="factory_supplier">Factory suppliers (report only)</SelectItem>
              </SelectContent>
            </Select>
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
        {asOfDate && realized.data && <p className="text-xs text-muted-foreground">{realized.data.asOfLimitations}</p>}
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
  );
}
