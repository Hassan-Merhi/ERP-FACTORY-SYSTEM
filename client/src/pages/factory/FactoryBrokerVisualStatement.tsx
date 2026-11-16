import { formatNumber } from "@/lib/formatNumber";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, TrendingUp, CreditCard } from "lucide-react";
import {
  FactoryBrokerVisualStatementCardSection,
  FactoryBrokerVisualStatementCardSection2,
  FactoryBrokerVisualStatementTableHeaderSection,
  ccySymbol,
  fmt,
  useFactoryBrokerVisualStatementState,
  type BrokerContainer,
} from "./useFactoryBrokerVisualStatementState";

function fmtSigned(n: number, decimals = 2) {
  if (!n || n === 0) return "";
  const abs = formatNumber(Math.abs(n), decimals);
  return n < 0 ? `−${abs}` : abs;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function FactoryBrokerVisualStatement() {
  const {
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
  } = useFactoryBrokerVisualStatementState();

  // Per-container grand total by currency
  function containerGrandTotal(c: BrokerContainer): Partial<Record<string, number>> {
    const out: Record<string, number> = {};
    const add = (cc: string, amt: number) => {
      out[cc] = (out[cc] || 0) + amt;
    };
    if (c.goodsAmount) add(c.goodsCurrency, c.goodsAmount);
    if (c.freightAmount) add(c.freightCurrency, c.freightAmount);
    if (c.commissionAmount) add(c.commissionCurrency, c.commissionAmount);
    return out;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 space-y-4 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
        <div>
          <PageHeader
            title="Broker Statement"
            subtitle="Container-level view of goods cost, freight, commission, and payments"
          />
        </div>
      </div>

      {/* Selectors */}
      <FactoryBrokerVisualStatementCardSection2
        brokerId={brokerId}
        brokers={brokers}
        from={from}
        setBrokerId={setBrokerId}
        setFrom={setFrom}
        setTo={setTo}
        to={to}
      />

      {!brokerId && <p className="text-sm text-muted-foreground">Select a broker to view the statement.</p>}

      {brokerId && isLoading && (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {brokerId && error && <p className="text-sm text-destructive">Failed to load statement. Please try again.</p>}

      {statement && (
        <div className="space-y-6">
          {/* ── Section 1: Container Table ───────────────────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Containers — {statement.broker?.name}
                <Badge variant="secondary" className="ml-1">
                  {statement.containers?.length ?? 0}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 overflow-x-auto">
              {statement.containers?.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No containers found for this broker{from || to ? " in the selected date range" : ""}.
                </p>
              ) : (
                <Table mobileLayout="cards">
                  <FactoryBrokerVisualStatementTableHeaderSection allCurrencies={allCurrencies} />
                  <TableBody>
                    {statement.containers.map((c) => {
                      const grandTotal = containerGrandTotal(c);
                      return (
                        <TableRow key={c.id} className="text-xs" data-testid={`row-container-${c.id}`}>
                          <TableCell className="py-1.5 font-medium whitespace-nowrap">{c.supplierName}</TableCell>
                          <TableCell className="py-1.5 font-mono whitespace-nowrap">{c.containerNumber}</TableCell>
                          <TableCell className="py-1.5 whitespace-nowrap text-muted-foreground">
                            {c.arrivalDate ? formatDisplayDate(c.arrivalDate) : "—"}
                          </TableCell>
                          <TableCell className="py-1.5 text-right tabular-nums">
                            {c.ratePerKg > 0 ? c.ratePerKg : "—"}
                          </TableCell>
                          <TableCell className="py-1.5 text-right tabular-nums">{fmt(c.weight, 0)}</TableCell>
                          {/* Goods */}
                          {allCurrencies.map((cc) => (
                            <TableCell
                              key={`g-${cc}`}
                              className="py-1.5 text-right tabular-nums text-blue-700 dark:text-blue-400"
                            >
                              {c.goodsCurrency === cc && c.goodsAmount > 0 ? fmt(c.goodsAmount) : ""}
                            </TableCell>
                          ))}
                          {/* Freight */}
                          {allCurrencies.map((cc) => (
                            <TableCell
                              key={`f-${cc}`}
                              className="py-1.5 text-right tabular-nums text-orange-700 dark:text-orange-400"
                            >
                              {c.freightCurrency === cc && c.freightAmount > 0 ? fmt(c.freightAmount) : ""}
                            </TableCell>
                          ))}
                          {/* Commission */}
                          {allCurrencies.map((cc) => (
                            <TableCell
                              key={`c-${cc}`}
                              className="py-1.5 text-right tabular-nums text-purple-700 dark:text-purple-400"
                            >
                              {c.commissionCurrency === cc && c.commissionAmount > 0 ? fmt(c.commissionAmount) : ""}
                            </TableCell>
                          ))}
                          {/* Grand Total */}
                          {allCurrencies.map((cc) => (
                            <TableCell key={`t-${cc}`} className="py-1.5 text-right tabular-nums font-semibold">
                              {grandTotal[cc] ? fmt(grandTotal[cc]!) : ""}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}

                    {/* Totals row */}
                    <TableRow className="bg-muted/60 font-semibold text-xs border-t-2">
                      <TableCell className="py-2" colSpan={5}>
                        TOTAL — {statement.containers?.length} containers
                      </TableCell>
                      {/* Goods totals */}
                      {allCurrencies.map((cc) => (
                        <TableCell
                          key={`gt-g-${cc}`}
                          className="py-2 text-right tabular-nums text-blue-700 dark:text-blue-400"
                        >
                          {containerTotals[cc]?.goods ? fmt(containerTotals[cc].goods) : ""}
                        </TableCell>
                      ))}
                      {/* Freight totals */}
                      {allCurrencies.map((cc) => (
                        <TableCell
                          key={`gt-f-${cc}`}
                          className="py-2 text-right tabular-nums text-orange-700 dark:text-orange-400"
                        >
                          {containerTotals[cc]?.freight ? fmt(containerTotals[cc].freight) : ""}
                        </TableCell>
                      ))}
                      {/* Commission totals */}
                      {allCurrencies.map((cc) => (
                        <TableCell
                          key={`gt-c-${cc}`}
                          className="py-2 text-right tabular-nums text-purple-700 dark:text-purple-400"
                        >
                          {containerTotals[cc]?.commission ? fmt(containerTotals[cc].commission) : ""}
                        </TableCell>
                      ))}
                      {/* Grand totals */}
                      {allCurrencies.map((cc) => {
                        const t = containerTotals[cc];
                        const grand = t ? t.goods + t.freight + t.commission : 0;
                        return (
                          <TableCell key={`gt-t-${cc}`} className="py-2 text-right tabular-nums font-bold">
                            {grand > 0 ? fmt(grand) : ""}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* ── Section 2: Payments ──────────────────────────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <CreditCard className="h-4 w-4" />
                Payments &amp; Conversions
                <Badge variant="secondary" className="ml-1">
                  {statement.payments?.length ?? 0}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0 overflow-x-auto">
              {statement.payments?.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payments recorded.</p>
              ) : (
                <Table mobileLayout="cards">
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow className="bg-muted/50 text-xs">
                      <TableHead className="h-8">Date</TableHead>
                      <TableHead className="h-8">Type</TableHead>
                      <TableHead className="h-8">Supplier / Details</TableHead>
                      <TableHead className="h-8">Currency</TableHead>
                      <TableHead className="h-8 text-right">Amount</TableHead>
                      <TableHead className="h-8 text-right">FX Rate</TableHead>
                      <TableHead className="h-8 text-right">$ USD</TableHead>
                      <TableHead className="h-8">Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statement.payments.map((p) => {
                      const isNeg = p.fromAmount < 0 || p.usdAmount < 0;
                      const typeLabel: Record<string, string> = {
                        payment: "Payment",
                        fx_in: "FX In",
                        fx_out: "FX Out",
                        voucher: "Voucher",
                      };
                      const typeBadge: Record<string, "outline" | "secondary" | "default" | "destructive"> = {
                        payment: "secondary",
                        fx_in: "default",
                        fx_out: "outline",
                        voucher: "outline",
                      };
                      const amtColor = isNeg
                        ? "text-green-600 dark:text-green-400"
                        : p.type === "fx_out"
                          ? "text-amber-600 dark:text-amber-400"
                          : "";
                      return (
                        <TableRow key={p.id} className="text-xs" data-testid={`row-payment-${p.id}`}>
                          <TableCell className="py-1.5 whitespace-nowrap text-muted-foreground">
                            {p.date ? formatDisplayDate(p.date) : "—"}
                          </TableCell>
                          <TableCell className="py-1.5">
                            <Badge variant={typeBadge[p.type] || "outline"} className="text-xs font-normal py-0">
                              {typeLabel[p.type] || p.type}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-1.5 max-w-[180px] truncate">{p.supplierName || "—"}</TableCell>
                          <TableCell className="py-1.5">
                            <Badge variant="outline" className="font-mono text-xs py-0">
                              {p.fromCurrency}
                            </Badge>
                          </TableCell>
                          <TableCell className={`py-1.5 text-right tabular-nums font-medium ${amtColor}`}>
                            {p.fromCurrency === "USD" ? "" : ccySymbol(p.fromCurrency)}
                            {fmtSigned(p.fromAmount)}
                          </TableCell>
                          <TableCell className="py-1.5 text-right tabular-nums text-muted-foreground">
                            {p.fxRate ? p.fxRate.toFixed(4) : "—"}
                          </TableCell>
                          <TableCell className={`py-1.5 text-right tabular-nums font-semibold ${amtColor}`}>
                            {fmtSigned(p.usdAmount)}
                          </TableCell>
                          <TableCell className="py-1.5 text-muted-foreground max-w-[160px] truncate">
                            {p.notes || "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}

                    {/* Payment totals */}
                    <TableRow className="bg-muted/60 font-semibold text-xs border-t-2">
                      <TableCell colSpan={4} className="py-2">
                        TOTAL PAID
                      </TableCell>
                      <TableCell className="py-2 text-right tabular-nums" colSpan={2}>
                        {Object.entries(paymentTotals)
                          .filter(([, v]) => v !== 0)
                          .map(([cc, v]) => (
                            <span key={cc} className="block">
                              {ccySymbol(cc)}
                              {fmt(v)}
                            </span>
                          ))}
                      </TableCell>
                      <TableCell className="py-2 text-right tabular-nums font-bold">
                        {fmt(statement.payments.reduce((s: number, p) => s + p.usdAmount, 0))}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* ── Section 3: Balance Summary ───────────────────────────────── */}
          <FactoryBrokerVisualStatementCardSection
            allCurrencies={allCurrencies}
            containerTotals={containerTotals}
            paymentTotals={paymentTotals}
          />
        </div>
      )}
    </div>
  );
}
