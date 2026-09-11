import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { factoryApiRequest } from "@/lib/factoryApi";
import { formatNumber } from "@/lib/formatNumber";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, TrendingUp, CreditCard, DollarSign } from "lucide-react";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const _DISPLAY_CURRENCIES = ["EUR", "AUD", "USD"] as const;
type _DisplayCcy = (typeof _DISPLAY_CURRENCIES)[number];

interface BrokerSupplier {
  id: number;
  name: string;
  parentId?: number | null;
}

interface BrokerContainer {
  id: number;
  supplierName: string;
  containerNumber: string;
  arrivalDate?: string | null;
  ratePerKg: number;
  weight: number;
  goodsAmount: number;
  goodsCurrency: string;
  freightAmount: number;
  freightCurrency: string;
  commissionAmount: number;
  commissionCurrency: string;
}

interface BrokerPayment {
  id: number;
  date?: string | null;
  type: string;
  supplierName?: string | null;
  fromCurrency: string;
  fromAmount: number;
  fxRate?: number | null;
  usdAmount: number;
  notes?: string | null;
}

interface BrokerStatement {
  broker?: { name: string } | null;
  containers: BrokerContainer[];
  payments: BrokerPayment[];
}

function fmt(n: number, decimals = 2) {
  if (!n || n === 0) return "";
  return formatNumber(Math.abs(n), decimals);
}

function fmtSigned(n: number, decimals = 2) {
  if (!n || n === 0) return "";
  const abs = formatNumber(Math.abs(n), decimals);
  return n < 0 ? `−${abs}` : abs;
}

function ccySymbol(cc: string) {
  if (cc === "EUR") return "€";
  if (cc === "AUD") return "A$";
  if (cc === "USD") return "$";
  return cc + " ";
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function FactoryBrokerVisualStatement() {
  const { formatDisplayDate } = useDateFormat();

  const [brokerId, setBrokerId] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  // Suppliers for the current factory company (server reads company from session)
  const { data: suppliers = [] } = useQuery<BrokerSupplier[]>({
    queryKey: ["/api/factory/suppliers"],
  });

  // Brokers = suppliers that have children OR have parentId = null and are linked
  const parentIds = useMemo(() => {
    const ids = new Set<number>();
    for (const s of suppliers) {
      if (s.parentId) ids.add(s.parentId);
    }
    return ids;
  }, [suppliers]);
  const brokers = useMemo(() => suppliers.filter((s) => parentIds.has(s.id)), [suppliers, parentIds]);

  // Visual statement data
  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p.toString();
  }, [from, to]);

  const {
    data: statement,
    isLoading,
    error,
  } = useQuery<BrokerStatement>({
    queryKey: ["/api/factory/suppliers", brokerId, "broker-visual-statement", from, to],
    queryFn: async () => {
      const qs = queryParams ? `?${queryParams}` : "";
      const res = await factoryApiRequest("GET", `/api/factory/suppliers/${brokerId}/broker-visual-statement${qs}`);
      if (!res.ok) throw new Error("Failed to load statement");
      return res.json();
    },
    enabled: !!brokerId,
  });

  // ── Derived totals ──────────────────────────────────────────────────────────

  const containerTotals = useMemo(() => {
    if (!statement?.containers) return {} as Record<string, { goods: number; freight: number; commission: number }>;
    const totals: Record<string, { goods: number; freight: number; commission: number }> = {};
    const add = (cc: string, field: "goods" | "freight" | "commission", amt: number) => {
      if (!totals[cc]) totals[cc] = { goods: 0, freight: 0, commission: 0 };
      totals[cc][field] += amt;
    };
    for (const c of statement.containers) {
      if (c.goodsAmount) add(c.goodsCurrency, "goods", c.goodsAmount);
      if (c.freightAmount) add(c.freightCurrency, "freight", c.freightAmount);
      if (c.commissionAmount) add(c.commissionCurrency, "commission", c.commissionAmount);
    }
    return totals;
  }, [statement]);

  const paymentTotals = useMemo(() => {
    if (!statement?.payments) return {} as Record<string, number>;
    const totals: Record<string, number> = {};
    for (const p of statement.payments) {
      totals[p.fromCurrency] = (totals[p.fromCurrency] || 0) + p.fromAmount;
    }
    return totals;
  }, [statement]);

  // All currencies present across containers + payments
  const allCurrencies = useMemo(() => {
    const set = new Set<string>();
    for (const cc of Object.keys(containerTotals)) set.add(cc);
    for (const cc of Object.keys(paymentTotals)) set.add(cc);
    // Preferred order
    const order = ["EUR", "AUD", "USD"];
    return [...order.filter((c) => set.has(c)), ...[...set].filter((c) => !order.includes(c))];
  }, [containerTotals, paymentTotals]);

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
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow className="bg-muted/50 text-xs">
                      <TableHead className="h-8 whitespace-nowrap">Supplier</TableHead>
                      <TableHead className="h-8 whitespace-nowrap">Container</TableHead>
                      <TableHead className="h-8 whitespace-nowrap">Date</TableHead>
                      <TableHead className="h-8 text-right whitespace-nowrap">Unit Price</TableHead>
                      <TableHead className="h-8 text-right whitespace-nowrap">Weight (kg)</TableHead>
                      {/* Goods Cost */}
                      {allCurrencies.map((cc) => (
                        <TableHead
                          key={`g-${cc}`}
                          className="h-8 text-right whitespace-nowrap text-blue-700 dark:text-blue-400"
                        >
                          Goods {cc === "USD" ? "$" : ccySymbol(cc)}
                        </TableHead>
                      ))}
                      {/* Freight */}
                      {allCurrencies.map((cc) => (
                        <TableHead
                          key={`f-${cc}`}
                          className="h-8 text-right whitespace-nowrap text-orange-700 dark:text-orange-400"
                        >
                          Freight {cc === "USD" ? "$" : ccySymbol(cc)}
                        </TableHead>
                      ))}
                      {/* Commission */}
                      {allCurrencies.map((cc) => (
                        <TableHead
                          key={`c-${cc}`}
                          className="h-8 text-right whitespace-nowrap text-purple-700 dark:text-purple-400"
                        >
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
                <Table>
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
        </div>
      )}
    </div>
  );
}
