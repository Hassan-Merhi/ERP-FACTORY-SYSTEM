import type { ClientErrorLike } from "@/lib/clientError";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useLocation } from "wouter";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { ClipboardCheck, Eye, Package, Trash2, FileText, FileSpreadsheet, Container } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
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
import { InvoiceSummaryBar } from "@/components/InvoiceSummaryBar";
import type { FactoryMyAccess } from "@shared/apiTypes";

interface CustomerOrder {
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
  totalWeightKg: string;
  customerName: string;
  containerNumber?: string | null;
  proformaName?: string | null;
  containerNotes?: string | null;
}

export default function FactoryPendingInvoices() {
  const [, navigate] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [statusFilter, setStatusFilter] = useState<string>("PENDING_VERIFIED");
  const { toast } = useToast();

  const { data: myAccess } = useQuery<FactoryMyAccess>({ queryKey: ["/api/factory/my-access"], staleTime: 5 * 60000 });
  const isAdmin = myAccess?.fullAccess === true;

  const { data: pendingOrders = [], isLoading: pendingLoading } = useQuery<CustomerOrder[]>({
    queryKey: ["/api/factory/customer-orders?status=PENDING_VERIFICATION&profile=summary&pageSize=250"],
  });

  const { data: verifiedOrders = [], isLoading: verifiedLoading } = useQuery<CustomerOrder[]>({
    queryKey: ["/api/factory/customer-orders?status=VERIFIED&profile=summary&pageSize=250"],
  });

  const { data: finalizedOrders = [], isLoading: finalizedLoading } = useQuery<CustomerOrder[]>({
    queryKey: ["/api/factory/customer-orders?status=FINALIZED&profile=summary&pageSize=250"],
  });

  const deleteMutation = useMutation({
    mutationFn: async (orderId: number) => {
      const res = await modeApiRequest("DELETE", `/api/factory/customer-orders/${orderId}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Invoice deleted successfully." });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const allOrders = [...pendingOrders, ...verifiedOrders, ...finalizedOrders];
  const isLoading = pendingLoading || verifiedLoading || finalizedLoading;

  const filteredOrders =
    statusFilter === "ALL"
      ? allOrders
      : statusFilter === "PENDING_VERIFIED"
        ? allOrders.filter((o) => o.status === "PENDING_VERIFICATION" || o.status === "VERIFIED")
        : allOrders.filter((o) => o.status === statusFilter);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "PENDING_VERIFICATION":
        return (
          <Badge
            variant="outline"
            className="bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800"
          >
            Pending
          </Badge>
        );
      case "VERIFIED":
        return (
          <Badge
            variant="outline"
            className="bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800"
          >
            Verified
          </Badge>
        );
      case "FINALIZED":
        return (
          <Badge
            variant="outline"
            className="bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800"
          >
            Finalized
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const filters: { key: string; label: string; count: number }[] = [
    { key: "PENDING_VERIFIED", label: "Pending + Verified", count: pendingOrders.length + verifiedOrders.length },
    { key: "FINALIZED", label: "Finalized", count: finalizedOrders.length },
    { key: "ALL", label: "All", count: allOrders.length },
  ];

  return (
    <div className="flex flex-col h-full p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <PageHeader
            title="Pending &amp; Finalized Invoices"
            subtitle="Orders awaiting or completed verification"
            icon={<ClipboardCheck className="h-5 w-5" />}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2" data-testid="filter-tabs">
          {filters.map((f) => (
            <Button
              key={f.key}
              variant={statusFilter === f.key ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter(f.key)}
              data-testid={`button-filter-${f.key.toLowerCase()}`}
            >
              {f.label} ({f.count})
            </Button>
          ))}
        </div>
      </div>

      {!isLoading && allOrders.length > 0 && <InvoiceSummaryBar orders={allOrders} />}

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (
        <Card className="table-responsive">
          <Table>
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow>
                <TableHead>Order #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Proforma</TableHead>
                <TableHead>Container</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Bales</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[100px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredOrders.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={10}
                    className="text-center text-muted-foreground py-8"
                    data-testid="text-no-orders"
                  >
                    <div className="flex flex-col items-center gap-2">
                      <Package className="h-10 w-10 opacity-40" />
                      <p>No invoices found</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filteredOrders.map((order) => (
                  <TableRow
                    key={order.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/factory/sales/pending-invoices/${order.id}/verify`)}
                    data-testid={`row-order-${order.id}`}
                  >
                    <TableCell className="font-mono" data-testid={`text-order-number-${order.id}`}>
                      {order.invoiceNumber || `#${order.id}`}
                    </TableCell>
                    <TableCell data-testid={`text-customer-name-${order.id}`}>{order.customerName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground" data-testid={`text-proforma-${order.id}`}>
                      {order.proformaName || <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell className="font-mono text-sm" data-testid={`text-container-${order.id}`}>
                      {order.containerNumber || <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell
                      className="text-sm max-w-[200px] truncate"
                      data-testid={`text-notes-${order.id}`}
                      title={order.containerNotes ?? undefined}
                    >
                      {order.containerNotes || <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell className="font-mono text-sm" data-testid={`text-order-date-${order.id}`}>
                      {order.orderDate ? formatDisplayDate(order.orderDate) : "-"}
                    </TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-total-bales-${order.id}`}>
                      {order.totalQtyBales ?? "-"}
                    </TableCell>
                    <TableCell
                      className="text-right font-mono font-semibold"
                      data-testid={`text-grand-total-${order.id}`}
                    >
                      {parseFloat(order.grandTotal || "0").toLocaleString(undefined, {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 2,
                      })}
                    </TableCell>
                    <TableCell data-testid={`text-status-${order.id}`}>{getStatusBadge(order.status)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => navigate(`/factory/sales/pending-invoices/${order.id}/verify`)}
                          data-testid={`button-review-order-${order.id}`}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Download Invoice PDF"
                          onClick={() => window.open(`/api/factory/customer-orders/${order.id}/export-pdf`, "_blank")}
                          data-testid={`button-download-pdf-${order.id}`}
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Export to Excel"
                          onClick={() => {
                            const a = document.createElement("a");
                            a.href = `/api/factory/customer-orders/${order.id}/export/excel`;
                            a.download = "";
                            a.click();
                          }}
                          data-testid={`button-export-order-${order.id}`}
                        >
                          <FileSpreadsheet className="h-4 w-4" />
                        </Button>
                        {isAdmin && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Loading Status + Bale Refs (Excel)"
                            onClick={() => {
                              const a = document.createElement("a");
                              a.href = `/api/factory/customer-orders/${order.id}/loading-status-export`;
                              a.download = "";
                              a.click();
                            }}
                            data-testid={`button-loading-status-${order.id}`}
                          >
                            <Container className="h-4 w-4" />
                          </Button>
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" data-testid={`button-delete-order-${order.id}`}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete Invoice</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will permanently delete invoice {order.invoiceNumber || `#${order.id}`} for{" "}
                                {order.customerName}. Any bales assigned to this order will be returned to stock. This
                                cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel data-testid={`button-cancel-delete-${order.id}`}>
                                Cancel
                              </AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => deleteMutation.mutate(order.id)}
                                data-testid={`button-confirm-delete-${order.id}`}
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
