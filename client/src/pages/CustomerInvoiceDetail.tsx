import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLocation, useRoute } from "wouter";
import { FileDown, FileSpreadsheet, ArrowLeft, Trash2, TrendingUp, AlertTriangle } from "lucide-react";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface OrderLine {
  articleCode: string;
  baleName: string;
  qty: number;
  weightPerBale: number;
  totalWeight: number;
  pricePerBale: number;
  totalPrice: number;
}

interface OrderBale {
  baleReference: string;
  locationId: number;
  weight: number;
  articleCode: string;
  baleName: string;
  priceUsed: number;
}

interface OrderCharge {
  name: string;
  amount: number;
  chargeType: string;
}

interface OrderDetail {
  id: number;
  companyId: number;
  customerId: number;
  orderDate: string;
  status: string;
  invoiceNumber?: string;
  subtotalBales: string;
  freightAmount: string;
  otherChargesTotal: string;
  grandTotal: string;
  totalQtyBales: number;
  customerName: string;
  customerCode: string;
  containerNumber?: string | null;
  shippingCompany?: string | null;
  lines: OrderLine[];
  bales: OrderBale[];
  charges: OrderCharge[];
}

interface ProfitLine {
  articleCode: string;
  baleName: string;
  qty: number;
  pricePerBale: number;
  selling: number;
  costPerBale: number;
  cost: number;
  profit: number | null;
  profitPctOnCost: number | null;
  marginPct: number | null;
  missingCost: boolean;
}

interface ProfitabilityData {
  orderId: number;
  invoiceNumber: string | null;
  customerName: string | null;
  lines: ProfitLine[];
  totalSelling: number;
  totalCost: number | null;
  totalProfit: number | null;
  totalProfitPctOnCost: number | null;
  totalMarginPct: number | null;
  partialCostData: boolean;
}

function fmt(n: number | null | undefined) {
  if (n == null || isNaN(n)) return "0";
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function pct(n: number | null) {
  if (n === null) return null;
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function ProfitValue({ value, className }: { value: number | null; className?: string }) {
  if (value === null) return <span className="text-muted-foreground text-xs">—</span>;
  const color =
    value > 0
      ? "text-green-600 dark:text-green-400"
      : value < 0
        ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground";
  return <span className={`font-mono font-semibold ${color} ${className ?? ""}`}>{fmt(value)}</span>;
}

function ProfitPct({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground text-xs">—</span>;
  const color =
    value > 0
      ? "text-green-600 dark:text-green-400"
      : value < 0
        ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground";
  return <span className={`text-xs font-mono ${color}`}>{pct(value)}</span>;
}

export default function CustomerInvoiceDetail() {
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const { selectedCompany: _selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [, params] = useRoute("/factory/sales/invoices/:id");
  const [showProfitability, setShowProfitability] = useState(false);

  const orderId = params?.id ? parseInt(params.id) : null;

  const { data: order, isLoading } = useQuery<OrderDetail>({
    queryKey: ["/api/factory/customer-orders", orderId],
    enabled: !!orderId,
  });

  const { data: profitability, isLoading: profitLoading } = useQuery<ProfitabilityData>({
    queryKey: ["/api/factory/customer-orders", orderId, "profitability"],
    queryFn: async () => {
      const res = await modeApiRequest("GET", `/api/factory/customer-orders/${orderId}/profitability`);
      if (!res.ok) throw new Error("Failed to load profitability");
      return res.json();
    },
    enabled: !!orderId && showProfitability,
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "DRAFT":
        return <Badge variant="secondary">Draft</Badge>;
      case "FINALIZED":
        return <Badge variant="default">Finalized</Badge>;
      case "CANCELLED":
        return <Badge variant="destructive">Cancelled</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await modeApiRequest("DELETE", `/api/factory/customer-orders/${id}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Invoice deleted successfully." });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      navigate("/factory/invoicing?tab=invoices");
    },
    onError: (error: ClientErrorLike) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleExportExcel = () => {
    if (!orderId) return;
    window.open(`/api/factory/customer-orders/${orderId}/export-excel`, "_blank");
  };

  const handleExportPdf = () => {
    if (!orderId) return;
    if (!navigator.onLine) {
      window.print();
      return;
    }
    window.open(`/api/factory/customer-orders/${orderId}/export-pdf`, "_blank");
  };

  if (isLoading) {
    return (
      <div className="flex flex-col h-full p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6">
        <p className="text-muted-foreground" data-testid="text-not-found">
          Invoice not found
        </p>
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => navigate("/factory/invoicing?tab=invoices")}
          data-testid="button-back-to-list"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Invoices
        </Button>
      </div>
    );
  }

  const sortedLines = [...(order.lines || [])].sort((a, b) => (a.baleName || "").localeCompare(b.baleName || ""));

  const freightCharges = (order.charges || []).filter((c) => c.chargeType === "FREIGHT");
  const otherCharges = (order.charges || []).filter((c) => c.chargeType !== "FREIGHT");

  const subtotal = parseFloat(order.subtotalBales || "0");
  const totalCharges = parseFloat(order.freightAmount || "0") + parseFloat(order.otherChargesTotal || "0");
  const grandTotal = parseFloat(order.grandTotal || "0");
  const totalBalesQty = sortedLines.reduce((sum, line) => sum + (line.qty || 0), 0);
  const totalWeightKg = sortedLines.reduce((sum, line) => sum + Number(line.totalWeight || 0), 0);

  return (
    <div className="flex flex-col h-full p-6 overflow-y-auto">
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/factory/invoicing?tab=invoices")}
          data-testid="button-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl sm:text-3xl font-bold" data-testid="text-invoice-number">
              {order.invoiceNumber || `Draft #${order.id}`}
            </h1>
            {getStatusBadge(order.status)}
          </div>
          <p className="text-muted-foreground text-sm mt-1" data-testid="text-order-date">
            {order.orderDate ? formatDisplayDate(order.orderDate) : "-"}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="text-sm text-muted-foreground">Customer</p>
            <p className="font-semibold text-lg" data-testid="text-customer-name">
              {order.customerName || "-"}
            </p>
          </div>
          {order.containerNumber && (
            <div>
              <p className="text-sm text-muted-foreground">Container No.</p>
              <p className="font-semibold font-mono" data-testid="text-container-number">
                {order.containerNumber}
              </p>
            </div>
          )}
          {order.shippingCompany && (
            <div>
              <p className="text-sm text-muted-foreground">Shipping</p>
              <p className="font-semibold" data-testid="text-shipping-company">
                {order.shippingCompany}
              </p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {order.status === "DRAFT" && (
            <Button
              variant="outline"
              onClick={() => navigate(`/factory/sales/new?orderId=${order.id}`)}
              data-testid="button-continue-editing"
            >
              Continue Editing
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => setShowProfitability(true)}
            data-testid="button-view-profitability"
            data-remote-control-safe="true"
            data-remote-control-action="view-profitability"
          >
            <TrendingUp className="mr-2 h-4 w-4" />
            Profitability
          </Button>
          <Button variant="outline" onClick={handleExportExcel} data-testid="button-export-excel">
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Download Excel
          </Button>
          <Button variant="outline" onClick={handleExportPdf} data-testid="button-export-pdf">
            <FileDown className="mr-2 h-4 w-4" />
            Download PDF
          </Button>
          {order.status !== "FINALIZED" && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="text-destructive" data-testid="button-delete-invoice">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Invoice</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete invoice {order.invoiceNumber || `#${order.id}`} for{" "}
                    {order.customerName}. Any bales assigned to this order will be returned to stock. This cannot be
                    undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => deleteMutation.mutate(order.id)}
                    data-testid="button-confirm-delete"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <Card className="overflow-x-auto mb-6">
        <Table mobileLayout="cards">
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead className="w-[50px]">#</TableHead>
              <TableHead>Article Code</TableHead>
              <TableHead>Bale Name</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Weight/Bale</TableHead>
              <TableHead className="text-right">Total Weight</TableHead>
              <TableHead className="text-right">Price/Bale</TableHead>
              <TableHead className="text-right">Total Price</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedLines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-6" data-testid="text-no-lines">
                  No order lines
                </TableCell>
              </TableRow>
            ) : (
              sortedLines.map((line, idx) => (
                <TableRow key={idx} data-testid={`row-line-${idx}`}>
                  <TableCell className="text-muted-foreground">{idx + 1}</TableCell>
                  <TableCell className="font-mono text-sm" data-testid={`text-article-code-${idx}`}>
                    {line.articleCode}
                  </TableCell>
                  <TableCell data-testid={`text-bale-name-${idx}`}>{line.baleName}</TableCell>
                  <TableCell className="text-right font-mono" data-testid={`text-qty-${idx}`}>
                    {line.qty}
                  </TableCell>
                  <TableCell className="text-right font-mono" data-testid={`text-weight-per-bale-${idx}`}>
                    {Number(line.weightPerBale || 0).toLocaleString(undefined, {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 2,
                    })}
                  </TableCell>
                  <TableCell className="text-right font-mono" data-testid={`text-total-weight-${idx}`}>
                    {Number(line.totalWeight || 0).toLocaleString(undefined, {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 2,
                    })}
                  </TableCell>
                  <TableCell className="text-right font-mono" data-testid={`text-price-per-bale-${idx}`}>
                    {Number(line.pricePerBale || 0).toLocaleString(undefined, {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 2,
                    })}
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold" data-testid={`text-total-price-${idx}`}>
                    {Number(line.totalPrice || 0).toLocaleString(undefined, {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 2,
                    })}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {(freightCharges.length > 0 || otherCharges.length > 0) && (
        <Card className="p-4 mb-6">
          <h3 className="font-semibold mb-3" data-testid="text-charges-header">
            Charges
          </h3>
          <div className="space-y-2">
            {freightCharges.map((charge, idx) => (
              <div
                key={`freight-${idx}`}
                className="flex items-center justify-between gap-2"
                data-testid={`row-freight-charge-${idx}`}
              >
                <span className="text-sm">{charge.name}</span>
                <span className="font-mono text-sm" data-testid={`text-freight-amount-${idx}`}>
                  {Number(charge.amount || 0).toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            ))}
            {otherCharges.map((charge, idx) => (
              <div
                key={`other-${idx}`}
                className="flex items-center justify-between gap-2"
                data-testid={`row-other-charge-${idx}`}
              >
                <span className="text-sm">{charge.name}</span>
                <span className="font-mono text-sm" data-testid={`text-other-amount-${idx}`}>
                  {Number(charge.amount || 0).toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>Subtotal (Bales)</span>
            <span className="font-mono" data-testid="text-subtotal">
              {subtotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span>Total Charges</span>
            <span className="font-mono" data-testid="text-total-charges">
              {totalCharges.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="border-t pt-2 flex items-center justify-between gap-2">
            <span className="font-semibold">Grand Total</span>
            <span className="font-mono font-bold text-lg" data-testid="text-grand-total">
              {grandTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>Total Bales Qty</span>
            <span data-testid="text-total-bales-qty">{totalBalesQty}</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>Total Weight</span>
            <span className="font-mono" data-testid="text-total-weight-kg">
              {totalWeightKg.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} kg
            </span>
          </div>
        </div>
      </Card>

      <Dialog open={showProfitability} onOpenChange={setShowProfitability}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Profitability — {order.invoiceNumber || `Draft #${order.id}`}
            </DialogTitle>
          </DialogHeader>

          {profitLoading ? (
            <div className="space-y-3 py-4">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !profitability ? (
            <div className="py-8 text-center text-muted-foreground" data-testid="text-profit-error">
              Could not load profitability data.
            </div>
          ) : (
            <div className="space-y-4">
              {profitability.partialCostData && (
                <div
                  className="flex items-start gap-2 rounded-md border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-950/30 p-3 text-sm text-yellow-800 dark:text-yellow-300"
                  data-testid="text-partial-cost-warning"
                >
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>Some lines are missing production cost data. Totals may be incomplete.</span>
                </div>
              )}

              <Card className="table-responsive">
                <Table mobileLayout="cards">
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Bale</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Sell/Bale</TableHead>
                      <TableHead className="text-right">Total Selling</TableHead>
                      <TableHead className="text-right">Cost/Bale</TableHead>
                      <TableHead className="text-right">Total Cost</TableHead>
                      <TableHead className="text-right">Profit</TableHead>
                      <TableHead className="text-right">Margin</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {profitability.lines.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                          No lines found
                        </TableCell>
                      </TableRow>
                    ) : (
                      profitability.lines.map((line, idx) => (
                        <TableRow key={idx} data-testid={`row-profit-line-${idx}`}>
                          <TableCell>
                            <div className="font-medium text-sm">{line.baleName || line.articleCode}</div>
                            {line.baleName && line.articleCode && (
                              <div className="text-xs text-muted-foreground font-mono">{line.articleCode}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono" data-testid={`text-profit-qty-${idx}`}>
                            {line.qty}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm" data-testid={`text-sell-per-bale-${idx}`}>
                            {fmt(line.pricePerBale)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm" data-testid={`text-total-selling-${idx}`}>
                            {fmt(line.selling)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm" data-testid={`text-cost-per-bale-${idx}`}>
                            {line.missingCost ? (
                              <span className="text-yellow-600 dark:text-yellow-400 text-xs flex items-center justify-end gap-1">
                                <AlertTriangle className="h-3 w-3" /> No cost
                              </span>
                            ) : (
                              fmt(line.costPerBale)
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm" data-testid={`text-total-cost-${idx}`}>
                            {line.missingCost ? (
                              <span className="text-muted-foreground text-xs">—</span>
                            ) : (
                              fmt(line.cost)
                            )}
                          </TableCell>
                          <TableCell className="text-right" data-testid={`text-line-profit-${idx}`}>
                            <ProfitValue value={line.profit} />
                          </TableCell>
                          <TableCell className="text-right" data-testid={`text-line-margin-${idx}`}>
                            <div className="flex flex-col items-end gap-0.5">
                              <ProfitPct value={line.marginPct} />
                              {line.profitPctOnCost !== null && (
                                <span className="text-xs text-muted-foreground font-mono">
                                  {pct(line.profitPctOnCost)} on cost
                                </span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </Card>

              <Card className="p-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-muted-foreground">Total Selling</span>
                    <span className="font-mono font-semibold" data-testid="text-total-selling-sum">
                      {fmt(profitability.totalSelling)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-muted-foreground">Total Cost</span>
                    <span className="font-mono font-semibold" data-testid="text-total-cost-sum">
                      {profitability.totalCost !== null ? (
                        fmt(profitability.totalCost)
                      ) : (
                        <span className="text-muted-foreground text-xs">Incomplete</span>
                      )}
                    </span>
                  </div>
                  <div className="border-t pt-2 flex items-center justify-between gap-4">
                    <span className="font-semibold">Total Profit</span>
                    <div className="flex flex-col items-end gap-0.5">
                      <ProfitValue value={profitability.totalProfit} className="text-base" />
                      {profitability.totalMarginPct !== null && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            Margin: <ProfitPct value={profitability.totalMarginPct} />
                          </span>
                          <span className="text-xs text-muted-foreground">
                            On cost: <ProfitPct value={profitability.totalProfitPctOnCost} />
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
