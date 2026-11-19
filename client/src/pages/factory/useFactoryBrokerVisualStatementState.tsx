// Extracted from ./FactoryBrokerVisualStatement.tsx to keep that module under the source-size cap.
import { formatNumber } from "@/lib/formatNumber";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DollarSign } from "lucide-react";
import { useFactoryBrokerVisualStatementStatePart1 } from "./useFactoryBrokerVisualStatementStatePart1";
export type { BrokerContainer, BrokerPayment } from "./useFactoryBrokerVisualStatementStatePart1";

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function fmt(n: number, decimals = 2) {
  if (!n || n === 0) return "";
  return formatNumber(Math.abs(n), decimals);
}

export function ccySymbol(cc: string) {
  if (cc === "EUR") return "€";
  if (cc === "AUD") return "A$";
  if (cc === "USD") return "$";
  return cc + " ";
}

export function useFactoryBrokerVisualStatementState() {
  const {
    formatDisplayDate,
    brokerId,
    setBrokerId,
    from,
    setFrom,
    setTo,
    to,
    brokers,
    error,
    isLoading,
    statement,
    containerTotals,
    paymentTotals,
    allCurrencies,
  } = useFactoryBrokerVisualStatementStatePart1();
  return {
    allCurrencies,
    brokerId,
    brokers,
    containerTotals,
    error,
    formatDisplayDate,
    from,
    isLoading,
    paymentTotals,
    setBrokerId,
    setFrom,
    setTo,
    statement,
    to,
  };
}

export function FactoryBrokerVisualStatementTableHeaderSection({
  allCurrencies,
}: Pick<ReturnType<typeof useFactoryBrokerVisualStatementState>, "allCurrencies">) {
  return (
    <TableHeader className="sticky top-0 z-30 bg-background">
      <TableRow className="bg-muted/50 text-xs">
        <TableHead className="h-8 whitespace-nowrap">Supplier</TableHead>
        <TableHead className="h-8 whitespace-nowrap">Container</TableHead>
        <TableHead className="h-8 whitespace-nowrap">Date</TableHead>
        <TableHead className="h-8 text-right whitespace-nowrap">Unit Price</TableHead>
        <TableHead className="h-8 text-right whitespace-nowrap">Weight (kg)</TableHead>
        {/* Goods Cost */}
        {allCurrencies.map((cc) => (
          <TableHead key={`g-${cc}`} className="h-8 text-right whitespace-nowrap text-blue-700 dark:text-blue-400">
            Goods {cc === "USD" ? "$" : ccySymbol(cc)}
          </TableHead>
        ))}
        {/* Freight */}
        {allCurrencies.map((cc) => (
          <TableHead key={`f-${cc}`} className="h-8 text-right whitespace-nowrap text-orange-700 dark:text-orange-400">
            Freight {cc === "USD" ? "$" : ccySymbol(cc)}
          </TableHead>
        ))}
        {/* Commission */}
        {allCurrencies.map((cc) => (
          <TableHead key={`c-${cc}`} className="h-8 text-right whitespace-nowrap text-purple-700 dark:text-purple-400">
            Comm. {cc === "USD" ? "$" : ccySymbol(cc)}
          </TableHead>
        ))}
        {/* Grand Total */}
        {allCurrencies.map((cc) => (
          <TableHead key={`t-${cc}`} className="h-8 text-right whitespace-nowrap font-bold">
            Total {cc === "USD" ? "$" : ccySymbol(cc)}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

export function FactoryBrokerVisualStatementCardSection({
  allCurrencies,
  containerTotals,
  paymentTotals,
}: Pick<
  ReturnType<typeof useFactoryBrokerVisualStatementState>,
  "allCurrencies" | "containerTotals" | "paymentTotals"
>) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <DollarSign className="h-4 w-4" />
          Statement Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow className="bg-muted/50 text-xs">
                <TableHead className="h-8">Item</TableHead>
                {allCurrencies.map((cc) => (
                  <TableHead key={cc} className="h-8 text-right">
                    {cc}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Total Credit */}
              <TableRow className="text-xs">
                <TableCell className="py-2 font-medium">Total Credit (owed to broker)</TableCell>
                {allCurrencies.map((cc) => {
                  const t = containerTotals[cc];
                  const total = t ? t.goods + t.freight + t.commission : 0;
                  return (
                    <TableCell key={cc} className="py-2 text-right tabular-nums font-medium">
                      {total > 0 ? `${ccySymbol(cc)}${fmt(total)}` : "—"}
                    </TableCell>
                  );
                })}
              </TableRow>
              {/* Total Paid */}
              <TableRow className="text-xs">
                <TableCell className="py-2 font-medium text-green-700 dark:text-green-400">
                  Operations (payments made)
                </TableCell>
                {allCurrencies.map((cc) => {
                  const paid = paymentTotals[cc] || 0;
                  return (
                    <TableCell
                      key={cc}
                      className="py-2 text-right tabular-nums font-medium text-green-700 dark:text-green-400"
                    >
                      {paid !== 0 ? `${paid < 0 ? "−" : ""}${ccySymbol(cc)}${fmt(paid)}` : "—"}
                    </TableCell>
                  );
                })}
              </TableRow>
              {/* Remaining Balance */}
              <TableRow className="text-xs bg-muted/40 font-semibold">
                <TableCell className="py-2">Remaining Balance</TableCell>
                {allCurrencies.map((cc) => {
                  const t = containerTotals[cc];
                  const credit = t ? t.goods + t.freight + t.commission : 0;
                  const paid = paymentTotals[cc] || 0;
                  const bal = credit - paid;
                  const isOwe = bal > 0;
                  return (
                    <TableCell
                      key={cc}
                      className={`py-2 text-right tabular-nums font-bold ${isOwe ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                    >
                      {bal !== 0 ? `${bal < 0 ? "−" : ""}${ccySymbol(cc)}${fmt(Math.abs(bal))}` : "—"}
                    </TableCell>
                  );
                })}
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <p className="text-xs text-muted-foreground mt-3">
          Balances shown in original currencies. Use the exchange rates in the existing broker ledger for USD
          conversion. Red = still owed to broker. Green = overpaid.
        </p>
      </CardContent>
    </Card>
  );
}

export function FactoryBrokerVisualStatementCardSection2({
  brokerId,
  brokers,
  from,
  setBrokerId,
  setFrom,
  setTo,
  to,
}: Pick<
  ReturnType<typeof useFactoryBrokerVisualStatementState>,
  "brokerId" | "brokers" | "from" | "setBrokerId" | "setFrom" | "setTo" | "to"
>) {
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="space-y-1 min-w-[220px]">
            <Label>Broker</Label>
            <Select value={brokerId} onValueChange={setBrokerId} disabled={brokers.length === 0}>
              <SelectTrigger data-testid="select-broker">
                <SelectValue placeholder={brokers.length === 0 ? "No brokers found" : "Select broker…"} />
              </SelectTrigger>
              <SelectContent>
                {brokers.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label>From date</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              data-testid="input-date-from"
              className="w-[160px]"
            />
          </div>
          <div className="space-y-1">
            <Label>To date</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              data-testid="input-date-to"
              className="w-[160px]"
            />
          </div>

          {(from || to) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFrom("");
                setTo("");
              }}
              data-testid="button-clear-dates"
            >
              Clear dates
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
