import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronRight } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";

interface PosAnalyticsSale {
  id: number;
  saleNumber: string;
  txDate: string;
  customerId?: number | null;
  customerName?: string | null;
  paymentType?: string | null;
  totalAmount: string;
  depositAmount?: string | null;
  currencyCode?: string | null;
  status: string;
}

interface PosAnalyticsSaleItem {
  id: number;
  productName: string;
  articleCode?: string | null;
  quantity: number;
  unitPrice: string;
  totalAmount: string;
  currencyCode?: string | null;
}

interface PosAnalyticsSaleDetail extends PosAnalyticsSale {
  items: PosAnalyticsSaleItem[];
  notes?: string | null;
}

export interface PosAnalyticsCustomer {
  customerId: number | null;
  customerName: string;
}

/**
 * Factory POS analytics drill-down: one customer's POS sales in the selected
 * date range, each expandable to its sale items.
 */
export function PosCustomerSalesDialog({
  customer,
  onClose,
  startDate,
  endDate,
  formatAmount,
  formatDisplayDate,
}: {
  customer: PosAnalyticsCustomer | null;
  onClose: () => void;
  startDate: string;
  endDate: string;
  formatAmount: (value: number) => string;
  formatDisplayDate: (value: string) => string;
}) {
  const [expandedPosSaleId, setExpandedPosSaleId] = useState<number | null>(null);

  const { data: posSales = [], isLoading: loadingPosSales } = useQuery<PosAnalyticsSale[]>({
    queryKey: ["/api/factory/pos/sales", "analytics-customer-detail"],
    queryFn: async () => {
      const res = await fetch("/api/factory/pos/sales", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load POS sales");
      return res.json();
    },
    enabled: !!customer,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const { data: expandedPosSale, isLoading: loadingExpandedPosSale } = useQuery<PosAnalyticsSaleDetail>({
    queryKey: ["/api/factory/pos/sales", expandedPosSaleId, "analytics-detail"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/pos/sales/${expandedPosSaleId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load POS sale details");
      return res.json();
    },
    enabled: !!expandedPosSaleId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const selectedPosSales = customer
    ? posSales.filter((sale) => {
        if (sale.status === "VOID") return false;
        if (startDate && sale.txDate < startDate) return false;
        if (endDate && sale.txDate > endDate) return false;

        if (customer.customerId !== null) {
          return sale.customerId === customer.customerId;
        }

        if (sale.customerId != null) return false;
        const saleName = (sale.customerName || "Walk-in / Cash").trim().toLowerCase();
        return saleName === customer.customerName.trim().toLowerCase();
      })
    : [];

  return (
    <Dialog
      open={customer !== null}
      onOpenChange={(open) => {
        if (!open) {
          setExpandedPosSaleId(null);
          onClose();
        }
      }}
    >
      <DialogContent className="w-[95vw] max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{customer?.customerName || "POS Customer"} — Sales Details</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loadingPosSales ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : selectedPosSales.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No POS sales found for this customer in the selected date range.
            </p>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Sale</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Payment</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedPosSales.map((sale) => {
                  const expanded = expandedPosSaleId === sale.id;
                  return (
                    <Fragment key={sale.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setExpandedPosSaleId(expanded ? null : sale.id)}
                        data-testid={`row-pos-sale-${sale.id}`}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <ChevronRight className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""}`} />
                            <span className="font-mono font-semibold">{sale.saleNumber}</span>
                          </div>
                        </TableCell>
                        <TableCell>{formatDisplayDate(sale.txDate)}</TableCell>
                        <TableCell>{sale.paymentType || "CASH"}</TableCell>
                        <TableCell className="text-right font-mono font-semibold">
                          {formatAmount(parseFloat(sale.totalAmount || "0"))}
                        </TableCell>
                      </TableRow>

                      {expanded && (
                        <TableRow>
                          <TableCell colSpan={4} className="bg-muted/20 p-0">
                            <div className="p-4">
                              {loadingExpandedPosSale ? (
                                <div className="space-y-2">
                                  <Skeleton className="h-10 w-full" />
                                  <Skeleton className="h-10 w-full" />
                                </div>
                              ) : expandedPosSale?.id !== sale.id ? (
                                <p className="text-sm text-muted-foreground">Loading sale details…</p>
                              ) : expandedPosSale.items?.length ? (
                                <div className="overflow-x-auto">
                                  <Table>
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead>Item</TableHead>
                                        <TableHead>Article</TableHead>
                                        <TableHead className="text-right">Qty</TableHead>
                                        <TableHead className="text-right">Unit Price</TableHead>
                                        <TableHead className="text-right">Total</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {expandedPosSale.items.map((item) => (
                                        <TableRow key={item.id}>
                                          <TableCell className="font-medium">{item.productName}</TableCell>
                                          <TableCell className="font-mono text-sm">{item.articleCode || "—"}</TableCell>
                                          <TableCell className="text-right font-mono">
                                            {formatNumber(Number(item.quantity || 0))}
                                          </TableCell>
                                          <TableCell className="text-right font-mono">
                                            {formatAmount(parseFloat(item.unitPrice || "0"))}
                                          </TableCell>
                                          <TableCell className="text-right font-mono font-semibold">
                                            {formatAmount(parseFloat(item.totalAmount || "0"))}
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </Table>
                                </div>
                              ) : (
                                <p className="text-sm text-muted-foreground">No sale items found.</p>
                              )}

                              {expandedPosSale?.id === sale.id && expandedPosSale.notes && (
                                <div className="mt-3 text-sm">
                                  <span className="text-muted-foreground">Notes: </span>
                                  {expandedPosSale.notes}
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
