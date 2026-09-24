import { useLocation, useRoute } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useQuery } from "@tanstack/react-query";
import { formatNumber } from "@/lib/formatNumber";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { FileText, Calendar, Hash, User, Building, Package, DollarSign, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";

interface VoucherItem {
  id: number;
  stockItemId: number | null;
  stockItemName: string;
  stockItemCode: string;
  quantity: number;
  unit: string;
  rate: number;
  amount: number;
}

interface VoucherEntry {
  id: number;
  ledgerAccountId: number;
  ledgerAccountName: string;
  debitAmount: number;
  creditAmount: number;
  narration: string | null;
}

interface VoucherDetailData {
  id: number;
  voucherNumber: string;
  voucherType: string;
  date: string;
  partyName: string | null;
  purchaseLedger: string | null;
  locationName: string | null;
  narration: string | null;
  supplierInvoiceNo: string | null;

  items: VoucherItem[];
  entries: VoucherEntry[];

  totals: {
    quantity: number;
    amount: number;
    debit: number;
    credit: number;
  };
}

interface ICStatus {
  id: number;
  status: string;
  destCompanyName: string;
  amount: string;
  approvedByUsername: string | null;
  approvedAt: string | null;
  destVoucherId: number | null;
  dismissNote: string | null;
}

function IntercompanyStatusPanel({ voucherId }: { voucherId: number }) {
  const { data: statuses = [] } = useQuery<ICStatus[]>({
    queryKey: ["/api/vouchers", voucherId, "intercompany-status"],
    queryFn: async () => {
      const r = await fetch(`/api/vouchers/${voucherId}/intercompany-status`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!voucherId,
  });

  if (statuses.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ArrowRight className="h-4 w-4" />
          Intercompany Notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {statuses.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">{s.destCompanyName}</span>
            {s.status === "approved" && (
              <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 text-xs">Approved</Badge>
            )}
            {s.status === "dismissed" && (
              <Badge className="bg-rose-500/10 text-rose-600 border-rose-500/30 text-xs">Dismissed</Badge>
            )}
            {s.status === "pending" && (
              <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/30 text-xs">Pending approval</Badge>
            )}
            {s.approvedByUsername && <span className="text-muted-foreground text-xs">by {s.approvedByUsername}</span>}
            {s.destVoucherId && (
              <span className="text-xs text-muted-foreground">· Mirror voucher #{s.destVoucherId}</span>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

const voucherTypeColors: Record<string, string> = {
  Payment: "bg-red-500",
  Receipt: "bg-green-500",
  Journal: "bg-blue-500",
  "Stock Transfer": "bg-purple-500",
  Production: "bg-orange-500",
  Consumption: "bg-yellow-500",
  "Purchase Import": "bg-indigo-500",
};

export default function VoucherDetail() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/voucher-detail/:voucherId");
  const { formatAmount } = useCurrencyContext();
  const { formatShortDate } = useDateFormat();
  const appMode = useAppMode();
  const _modeApiRequest = getApiRequest(appMode);

  const voucherId = params?.voucherId ? parseInt(params.voucherId) : null;
  const fromDaybook = new URLSearchParams(window.location.search).get("from") === "daybook";

  const modePrefix = appMode === "factory" ? "/factory" : appMode === "properties" ? "/properties" : "";
  const backTarget = fromDaybook ? `${modePrefix}/daybook` : `${modePrefix}/vouchers`;
  const handleBack = useBackToParent(backTarget);
  useEscapeBack(() => navigate(backTarget));

  const { data, isLoading, isError } = useQuery<VoucherDetailData>({
    queryKey: ["/api/voucher-detail", voucherId],
    queryFn: async () => {
      const response = await fetch(`/api/voucher-detail/${voucherId}`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch voucher detail");
      return response.json();
    },
    enabled: !!voucherId,
  });

  if (!voucherId) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Invalid voucher ID</p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6 flex flex-col items-center gap-4 text-center">
        <p className="text-muted-foreground">Failed to load voucher details.</p>
        <Button variant="outline" onClick={handleBack} data-testid="button-back-error">
          Go Back
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sm:px-4 sm:pt-4">
        <PageHeader
          title={`No. ${data?.voucherNumber || ""}`}
          subtitle="Accounting Voucher Alteration (Secondary)"
          onBack={handleBack}
          meta={
            <>
              <Badge
                className={`${voucherTypeColors[data?.voucherType || ""] || "bg-primary"} border-transparent text-white`}
                data-testid="badge-voucher-type"
              >
                {data?.voucherType || "Voucher"}
              </Badge>
              {data?.date && <span className="font-medium text-foreground">{formatShortDate(data.date)}</span>}
            </>
          }
        />
      </div>

      <div className="space-y-6 sm:p-4">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-[300px] w-full" />
          </div>
        ) : data ? (
          <>
            {/* Voucher Info */}
            <Card>
              <CardContent className="p-3 sm:p-4 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {data.supplierInvoiceNo && (
                    <div className="flex items-center gap-2">
                      <Hash className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">Supplier Invoice No.:</span>
                      <span className="font-medium">{data.supplierInvoiceNo}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Date:</span>
                    <span className="font-medium">{formatShortDate(data.date)}</span>
                  </div>
                </div>

                {data.partyName && (
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Party A/c name:</span>
                    <span className="font-medium text-primary">{data.partyName}</span>
                  </div>
                )}

                {data.purchaseLedger && (
                  <div className="flex items-center gap-2">
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Purchase ledger:</span>
                    <span className="font-medium">{data.purchaseLedger}</span>
                  </div>
                )}

                {data.locationName && (
                  <div className="flex items-center gap-2">
                    <Building className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Repl existing Godown with:</span>
                    <span className="font-medium text-blue-600">{data.locationName}</span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Intercompany Notification Status */}
            <IntercompanyStatusPanel voucherId={data.id} />

            {/* Items Table (for Purchase/Sales vouchers) */}
            {Array.isArray(data.items) && data.items.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Package className="h-4 w-4" />
                    Name of Item
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="border rounded-lg overflow-x-auto">
                    <Table>
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow className="bg-muted/50">
                          <TableHead>Name of Item</TableHead>
                          <TableHead className="text-right w-24">Quantity</TableHead>
                          <TableHead className="text-right w-24">Rate</TableHead>
                          <TableHead className="text-center w-16">per</TableHead>
                          <TableHead className="text-right w-28">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.items.map((item, index) => (
                          <TableRow key={item.id || index} data-testid={`row-item-${index}`}>
                            <TableCell className="font-medium">{item.stockItemName}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatNumber(item.quantity, 0)} {item.unit}
                            </TableCell>
                            <TableCell className="text-right font-mono">{formatAmount(item.rate)}</TableCell>
                            <TableCell className="text-center text-sm text-muted-foreground">{item.unit}</TableCell>
                            <TableCell className="text-right font-mono">{formatAmount(item.amount)}</TableCell>
                          </TableRow>
                        ))}

                        {/* Totals */}
                        <TableRow className="bg-primary/10 font-bold border-t-2">
                          <TableCell></TableCell>
                          <TableCell className="text-right font-mono">
                            {formatNumber(data.totals.quantity)} {data.items[0]?.unit || ""}
                          </TableCell>
                          <TableCell></TableCell>
                          <TableCell></TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(data.totals.amount)}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Ledger Entries Table (for Journal/Payment/Receipt vouchers) */}
            {data.entries.length > 0 && data.items.length === 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Ledger Entries
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="border rounded-lg overflow-x-auto">
                    <Table>
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow className="bg-muted/50">
                          <TableHead>Account Name</TableHead>
                          <TableHead className="text-right w-32">Debit</TableHead>
                          <TableHead className="text-right w-32">Credit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(Array.isArray(data.entries) ? data.entries : []).map((entry, index) => (
                          <TableRow key={entry.id || index}>
                            <TableCell>
                              <div className="font-medium">{entry.ledgerAccountName}</div>
                              {entry.narration && (
                                <div className="text-xs text-muted-foreground/80 mt-0.5 italic">{entry.narration}</div>
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {entry.debitAmount > 0 ? formatAmount(entry.debitAmount) : ""}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {entry.creditAmount > 0 ? formatAmount(entry.creditAmount) : ""}
                            </TableCell>
                          </TableRow>
                        ))}

                        {/* Totals */}
                        <TableRow className="bg-primary/10 font-bold border-t-2">
                          <TableCell>Total</TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(data.totals.debit)}</TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(data.totals.credit)}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Narration */}
            {data.narration && (
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground mb-1">Narration:</p>
                  <p className="text-sm">{data.narration}</p>
                </CardContent>
              </Card>
            )}
          </>
        ) : (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-muted-foreground">No data available</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
