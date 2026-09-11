import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { DollarSign, FileText, TrendingUp, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import type { CurrencyGroup } from "./factory-suppliers/factorySupplierTypes";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatNumber } from "@/lib/formatNumber";
import type { AuthMe, ApiListRow } from "@shared/apiTypes";

const _CURRENCIES = ["USD", "EUR", "GBP", "AUD", "LBP", "XOF", "XAF"];

// ─── Row-total helpers ───────────────────────────────────────────────────────

/**
 * Canonical row total for the GOODS SUPPLIER perspective
 * (how much this supplier should receive for this container).
 *
 * Priority:
 *  1. `finalPayableAmount` (set at offload) — this is the ALL-IN company cost
 *     (base + freight + OC + commission + duty).  We display it as-is and note
 *     that commission is "incl. in total" so the user knows the breakdown.
 *  2. Pre-offload fallback: `value` only (kg × rate + same-currency freight).
 *     Commission is a SEPARATE obligation to the broker — it is not owed to this
 *     goods supplier, so we do NOT add it to the row total.
 *
 * The group "Net Owed to Supplier" footer uses the backend's netPayable field
 * (totalValue − effectiveCommission − paid) which correctly excludes the
 * commission from what this supplier receives.
 */
/** A row inside the supplier statement — base entry plus the extra fields the
 * broker-container view and commission display read. */
interface StatementRow {
  id: number;
  name?: string;
  containerNumber?: string | null;
  status?: string;
  date?: string;
  arrivalDate?: string | null;
  origin?: string | null;
  supplierName?: string;
  value: string;
  totalKg?: string | null;
  ratePerKg?: string | null;
  actualReceivedKg?: string | null;
  finalPayableAmount?: string | null;
  commissionAmount?: string | null;
  commissionCurrencyCode?: string | null;
  totalCommission?: string;
}

function getRowTotalOwed(c: StatementRow): number {
  const fp = parseFloat(c.finalPayableAmount ?? "");
  if (!isNaN(fp) && fp > 0) return fp;
  // Pre-offload: goods value only (no commission — that goes to the broker)
  return parseFloat(c.value || "0");
}

/** True when the row is using the backend canonical total (post-offload). */
function rowUsesCanonical(c: StatementRow): boolean {
  const fp = parseFloat(c.finalPayableAmount ?? "");
  return !isNaN(fp) && fp > 0;
}

/**
 * Commission to display for a row.
 * Post-offload: use totalCommission (canonical factoryContainerCommissions sum).
 * Pre-offload: use commissionAmount (container-level estimate).
 */
function rowCommissionDisplay(c: StatementRow): { amount: number; currency: string } {
  if (rowUsesCanonical(c)) {
    const tc = parseFloat(c.totalCommission ?? "0");
    if (tc > 0) return { amount: tc, currency: c.commissionCurrencyCode || "USD" };
  }
  return {
    amount: parseFloat(c.commissionAmount || "0"),
    currency: c.commissionCurrencyCode || "USD",
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function FactorySupplierStatement() {
  const { formatDisplayDate } = useDateFormat();
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [supplierId, setSupplierId] = useState<string>("");
  const [estimatedRates, setEstimatedRates] = useState<Record<string, string>>({});

  const { data: companies = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/user/companies"],
  });

  const { data: me } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const isAdmin = me?.role === "Admin" || me?.role === "Owner" || me?.role === "Developer";

  const { data: suppliers = [], isLoading: suppliersLoading } = useQuery<ApiListRow[]>({
    queryKey: ["/api/factory/suppliers", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/suppliers?companyId=${companyId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch suppliers");
      return res.json();
    },
    enabled: !!companyId,
  });

  const { data: statement, isLoading: statementLoading } = useQuery({
    queryKey: ["/api/factory/suppliers", supplierId, "statement"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/suppliers/${supplierId}/statement`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch statement");
      return res.json();
    },
    enabled: !!supplierId,
  });

  const getRate = (cc: string) => parseFloat(estimatedRates[cc] || (cc === "USD" ? "1" : "0")) || 0;

  /**
   * Estimated USD total uses the per-currency NET PAYABLE (outstanding to the
   * goods supplier) — not totalOwed (which includes broker commission).
   * This gives a more accurate picture of what the company still owes each supplier.
   */
  const estimatedUsdTotal = statement?.currencyGroups
    ? statement.currencyGroups.reduce((sum: number, g: CurrencyGroup) => {
        const rate = getRate(g.currencyCode);
        // netPayable is what we still owe this supplier after deducting commission and payments.
        const outstanding = parseFloat(g.netPayable || "0");
        if (outstanding <= 0) return sum;
        return sum + outstanding * rate;
      }, 0)
    : 0;

  const currenciesInStatement: string[] = statement?.currencyGroups
    ? [...new Set<string>(statement.currencyGroups.map((g: CurrencyGroup) => g.currencyCode as string))].filter(
        (c) => c !== "USD"
      )
    : [];

  return (
    <div className="space-y-6">
      <div>
        <PageHeader title="Supplier Statement" subtitle="Multi-currency supplier account statement" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-4 flex-wrap">
            {companies.length > 1 && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Company</Label>
                <Select
                  value={companyId ? String(companyId) : ""}
                  onValueChange={(val) => {
                    setCompanyId(Number(val));
                    setSupplierId("");
                  }}
                >
                  <SelectTrigger className="w-48" data-testid="select-company">
                    <SelectValue placeholder="Select company" />
                  </SelectTrigger>
                  <SelectContent>
                    {companies.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Supplier</Label>
              <Select
                value={supplierId || ""}
                onValueChange={(val) => setSupplierId(val)}
                disabled={!companyId || suppliersLoading}
              >
                <SelectTrigger className="w-56" data-testid="select-supplier">
                  <SelectValue placeholder="Select supplier..." />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {statementLoading && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm">Loading statement...</p>
          </CardContent>
        </Card>
      )}

      {statement && !statementLoading && (
        <>
          {statement.currencyGroups?.map((group: CurrencyGroup) => {
            // Goods value owed to this supplier (before commission deduction)
            const groupTotalValue = parseFloat(group.totalValue || "0");
            // Effective commission — what goes to the BROKER, deducted from supplier payment
            const groupCommission = parseFloat(group.totalCommission || group.totalDirectCommission || "0");
            // Net owed to this goods supplier = goods − broker commission
            const groupNetToSupplier = groupTotalValue - groupCommission;
            // Already-paid amount
            const groupPaid = parseFloat(group.totalPaid || "0");
            // Outstanding = netPayable from backend (cross-checked)
            const groupOutstanding = parseFloat(group.netPayable || "0");

            return (
              <Card key={group.currencyCode}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Badge variant="secondary" data-testid={`badge-currency-${group.currencyCode}`}>
                      {group.currencyCode}
                    </Badge>
                    Containers
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="table-responsive">
                    <Table>
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead>Container</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Origin</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Kg</TableHead>
                          <TableHead className="text-right">Rate</TableHead>
                          <TableHead className="text-right">
                            Goods Value
                            <span className="block text-xs font-normal text-muted-foreground">
                              ({group.currencyCode})
                            </span>
                          </TableHead>
                          <TableHead className="text-right">
                            <span className="flex items-center justify-end gap-1">
                              Commission
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                                </TooltipTrigger>
                                <TooltipContent side="left" className="max-w-48">
                                  Commission is paid to the broker — it is deducted from this supplier's net payment.
                                </TooltipContent>
                              </Tooltip>
                            </span>
                          </TableHead>
                          <TableHead className="text-right">
                            Total Owed
                            <span className="block text-xs font-normal text-muted-foreground">(all-in cost)</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.containers.map((c: StatementRow) => {
                          const rowTotal = getRowTotalOwed(c);
                          const isCanonical = rowUsesCanonical(c);
                          const { amount: commAmt, currency: commCcy } = rowCommissionDisplay(c);
                          return (
                            <TableRow key={c.id} data-testid={`row-container-${c.id}`}>
                              <TableCell className="font-mono font-medium">{c.containerNumber}</TableCell>
                              <TableCell className="text-muted-foreground text-sm">
                                {c.date ? formatDisplayDate(c.date) : "—"}
                              </TableCell>
                              <TableCell>{c.origin || "—"}</TableCell>
                              <TableCell>
                                <Badge variant="outline">{c.status}</Badge>
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatNumber(parseFloat(c.actualReceivedKg || c.totalKg || "0"))}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatNumber(parseFloat(c.ratePerKg || "0"))}
                              </TableCell>
                              {/* Goods value — never includes commission */}
                              <TableCell className="text-right font-mono font-medium">
                                {formatNumber(parseFloat(c.value))}
                              </TableCell>
                              {/* Commission — paid to broker, deducted from supplier net */}
                              <TableCell className="text-right font-mono">
                                {commAmt > 0 ? (
                                  <span className="text-amber-600 dark:text-amber-400">
                                    {formatNumber(commAmt)}
                                    {commCcy !== group.currencyCode && <span className="ml-1 text-xs">{commCcy}</span>}
                                    <span className="block text-xs text-muted-foreground font-normal">
                                      {isCanonical ? "canonical" : "est."}
                                    </span>
                                  </span>
                                ) : (
                                  "—"
                                )}
                              </TableCell>
                              {/* Total owed = finalPayableAmount (all-in) post-offload, or goods value pre-offload */}
                              <TableCell
                                className="text-right font-mono font-medium"
                                data-testid={`text-row-total-${c.id}`}
                              >
                                {formatNumber(rowTotal)}
                                {isCanonical ? (
                                  <span className="block text-xs text-muted-foreground font-normal">all-in</span>
                                ) : (
                                  <span className="block text-xs text-muted-foreground font-normal">est.</span>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>

                  {/* ── Group footer ────────────────────────────────────── */}
                  <div className="mt-4 flex justify-end">
                    <div className="space-y-1 text-sm text-right min-w-56">
                      <div className="flex justify-between gap-8">
                        <span className="text-muted-foreground">Goods Value</span>
                        <span className="font-mono font-medium">
                          {formatNumber(groupTotalValue)} {group.currencyCode}
                        </span>
                      </div>

                      {groupCommission > 0 && (
                        <div className="flex justify-between gap-8">
                          <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                            Less: Commission
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Info className="h-3 w-3 cursor-help" />
                              </TooltipTrigger>
                              <TooltipContent side="left" className="max-w-48">
                                Paid to broker separately — deducted from this supplier's payment.
                              </TooltipContent>
                            </Tooltip>
                          </span>
                          <span className="font-mono text-amber-600 dark:text-amber-400">
                            −{formatNumber(groupCommission)} {group.currencyCode}
                          </span>
                        </div>
                      )}

                      <div className="flex justify-between gap-8 border-t pt-1">
                        <span className="font-medium">Net Owed to Supplier</span>
                        <span
                          className="font-mono font-bold"
                          data-testid={`text-group-net-supplier-${group.currencyCode}`}
                        >
                          {formatNumber(groupNetToSupplier)} {group.currencyCode}
                        </span>
                      </div>

                      {groupPaid > 0 && (
                        <div className="flex justify-between gap-8">
                          <span className="text-muted-foreground">Less: Paid</span>
                          <span className="font-mono text-green-600 dark:text-green-400">
                            −{formatNumber(groupPaid)} {group.currencyCode}
                          </span>
                        </div>
                      )}

                      <div className={`flex justify-between gap-8 ${groupPaid > 0 ? "border-t pt-1" : ""}`}>
                        <span className="font-medium">Outstanding Balance</span>
                        <span
                          className={`font-mono font-bold ${groupOutstanding < 0 ? "text-green-600 dark:text-green-400" : ""}`}
                          data-testid={`text-group-total-${group.currencyCode}`}
                        >
                          {formatNumber(Math.abs(groupOutstanding))} {group.currencyCode}
                          {groupOutstanding < 0 && (
                            <span className="block text-xs font-normal text-green-600 dark:text-green-400">credit</span>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground mt-3">
                    <span className="font-medium">Row "Total Owed"</span>: post-offload rows show the all-in backend
                    cost (base + freight + OC + commission + duty). Pre-offload rows show goods value only (est.).
                    <span className="ml-1 font-medium">Group totals</span> are always computed by the server. Commission
                    is a broker deduction — it reduces what this supplier receives.
                  </p>
                </CardContent>
              </Card>
            );
          })}

          {isAdmin && statement.currencyGroups?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" />
                  Estimated USD Outstanding
                  <Badge variant="outline" className="ml-1">
                    Admin Only
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Approximate USD equivalent of what is still outstanding to this supplier (after commission deduction
                  and payments). This is a helper estimate only and does not affect accounting balances. Set exchange
                  rates below to compute the conversion.
                </p>

                {currenciesInStatement.length > 0 && (
                  <div className="grid grid-cols-2 gap-3 mb-4 max-w-sm">
                    {currenciesInStatement.map((cc) => (
                      <div key={cc} className="space-y-1">
                        <Label className="text-xs text-muted-foreground">1 {cc} = USD</Label>
                        <Input
                          type="number"
                          placeholder="0.00"
                          value={estimatedRates[cc] || ""}
                          onChange={(e) => setEstimatedRates((prev) => ({ ...prev, [cc]: e.target.value }))}
                          data-testid={`input-est-rate-${cc}`}
                        />
                      </div>
                    ))}
                  </div>
                )}

                <div className="space-y-2 text-sm">
                  {statement.currencyGroups.map((g: CurrencyGroup) => {
                    const rate = getRate(g.currencyCode);
                    // Use netPayable = outstanding balance owed to this goods supplier
                    const outstanding = parseFloat(g.netPayable || "0");
                    const usdEq = outstanding * rate;
                    return (
                      <div key={g.currencyCode} className="flex justify-between gap-8 max-w-sm text-muted-foreground">
                        <span>
                          {formatNumber(outstanding)} {g.currencyCode}
                          <span className="text-xs ml-1">(outstanding)</span>
                          {rate ? ` × ${rate}` : ""}
                        </span>
                        <span className="font-mono">{rate ? `≈ ${formatNumber(usdEq)} USD` : "—"}</span>
                      </div>
                    );
                  })}
                  <div className="flex justify-between gap-8 max-w-sm border-t pt-2">
                    <span className="font-medium flex items-center gap-1">
                      <DollarSign className="h-4 w-4" />
                      Estimated Grand Total
                    </span>
                    <span className="font-mono font-bold" data-testid="text-estimated-usd-total">
                      {formatNumber(estimatedUsdTotal)} USD
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {(!statement.currencyGroups || statement.currencyGroups.length === 0) && (
            <Card>
              <CardContent className="pt-6">
                <div className="text-center py-8">
                  <FileText className="mx-auto h-10 w-10 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground mt-3">No containers found for this supplier.</p>
                </div>
              </CardContent>
            </Card>
          )}

          {statement.brokerContainers && statement.brokerContainers.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-muted-foreground" />
                  Commission Earned (as Broker)
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  Containers where this supplier earns commission as broker on <em>another</em> supplier's goods. This
                  is a separate obligation and does not overlap with the goods payable above.
                </p>
              </CardHeader>
              <CardContent>
                <div className="table-responsive">
                  <Table>
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Container</TableHead>
                        <TableHead>Purchase Supplier</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Commission Earned</TableHead>
                        <TableHead className="text-right">Currency</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {statement.brokerContainers.map((c: StatementRow) => (
                        <TableRow key={c.id} data-testid={`row-broker-container-${c.id}`}>
                          <TableCell className="font-mono font-medium">{c.containerNumber}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">{c.supplierName || "—"}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {c.arrivalDate ? formatDisplayDate(c.arrivalDate) : "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{c.status}</Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono font-medium text-green-600 dark:text-green-400">
                            {formatNumber(parseFloat(c.commissionAmount || "0"))}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground text-sm">
                            {c.commissionCurrencyCode || "USD"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="mt-3 flex justify-end">
                  <div className="text-sm font-medium">
                    Total Commission Earned:{" "}
                    <span
                      className="font-mono text-green-600 dark:text-green-400"
                      data-testid="text-broker-commission-total"
                    >
                      {formatNumber(parseFloat(statement.summary?.totalBrokerCommission || "0"))}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  This is commission earned by acting as broker on another supplier's container. It is a separate
                  receivable and does not affect the goods payable shown above. The two sections never overlap.
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {!statement && !statementLoading && supplierId && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Failed to load statement.</p>
          </CardContent>
        </Card>
      )}

      {!supplierId && (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center py-8">
              <FileText className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground mt-3">Select a supplier to view their statement.</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
