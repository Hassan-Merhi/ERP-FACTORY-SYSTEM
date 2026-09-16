import type { ClientErrorLike } from "@/lib/clientError";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLocation } from "wouter";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Eye, Trash2 } from "lucide-react";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface Customer {
  id: number;
  legalName: string;
  balance: number;
  balanceSide: string;
}

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
  totalWeightKg: string | null;
  customerName: string;
}

export default function CustomerInvoices() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [customerFilter, setCustomerFilter] = useState<string>("all");

  const { data: customers = [], isLoading: customersLoading } = useQuery<Customer[]>({
    queryKey: ["/api/factory/customers"],
  });

  const queryParams = new URLSearchParams();
  if (customerFilter !== "all") queryParams.set("customerId", customerFilter);
  if (statusFilter !== "all") queryParams.set("status", statusFilter);
  const queryString = queryParams.toString();

  const { data: orders = [], isLoading: ordersLoading } = useQuery<CustomerOrder[]>({
    queryKey: [`/api/factory/customer-orders?${queryString}`, statusFilter, customerFilter],
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
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "DRAFT":
        return (
          <Badge variant="secondary" data-testid={`badge-status-draft`}>
            Draft
          </Badge>
        );
      case "LOADING":
        return (
          <Badge
            variant="outline"
            className="border-blue-300 text-blue-700 dark:border-blue-600 dark:text-blue-400"
            data-testid={`badge-status-loading`}
          >
            Loading
          </Badge>
        );
      case "PENDING_VERIFICATION":
        return (
          <Badge
            variant="outline"
            className="border-yellow-300 text-yellow-700 dark:border-yellow-600 dark:text-yellow-400"
            data-testid={`badge-status-pending`}
          >
            Pending Verification
          </Badge>
        );
      case "VERIFIED":
        return (
          <Badge
            variant="outline"
            className="border-green-300 text-green-700 dark:border-green-600 dark:text-green-400"
            data-testid={`badge-status-verified`}
          >
            Verified
          </Badge>
        );
      case "FINALIZED":
        return (
          <Badge variant="default" data-testid={`badge-status-finalized`}>
            Finalized
          </Badge>
        );
      case "CANCELLED":
        return (
          <Badge variant="destructive" data-testid={`badge-status-cancelled`}>
            Cancelled
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const isLoading = ordersLoading || customersLoading;

  return (
    <div className="flex flex-col h-full p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <PageHeader title="Customer Invoices" subtitle="View and manage customer orders and invoices" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="w-48">
          <label className="text-sm font-medium mb-1 block">Status</label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger data-testid="select-status-filter">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="LOADING">Loading</SelectItem>
              <SelectItem value="PENDING_VERIFICATION">Pending Verification</SelectItem>
              <SelectItem value="VERIFIED">Verified</SelectItem>
              <SelectItem value="FINALIZED">Finalized</SelectItem>
              <SelectItem value="CANCELLED">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="w-56">
          <label className="text-sm font-medium mb-1 block">Customer</label>
          <Select value={customerFilter} onValueChange={setCustomerFilter}>
            <SelectTrigger data-testid="select-customer-filter">
              <SelectValue placeholder="All customers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Customers</SelectItem>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id.toString()} data-testid={`select-customer-option-${c.id}`}>
                  {c.legalName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

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
                <TableHead>Invoice #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total Bales</TableHead>
                <TableHead className="text-right">Total Weight (kg)</TableHead>
                <TableHead className="text-right">Grand Total</TableHead>
                <TableHead className="w-[100px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="text-center text-muted-foreground py-8"
                    data-testid="text-no-orders"
                  >
                    No invoices found
                  </TableCell>
                </TableRow>
              ) : (
                orders.map((order) => (
                  <TableRow
                    key={order.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/factory/sales/invoices/${order.id}`)}
                    data-testid={`row-order-${order.id}`}
                  >
                    <TableCell className="font-mono" data-testid={`text-invoice-number-${order.id}`}>
                      {order.invoiceNumber || `Draft #${order.id}`}
                    </TableCell>
                    <TableCell data-testid={`text-customer-name-${order.id}`}>{order.customerName}</TableCell>
                    <TableCell className="font-mono text-sm" data-testid={`text-order-date-${order.id}`}>
                      {order.orderDate ? formatDisplayDate(order.orderDate) : "-"}
                    </TableCell>
                    <TableCell>{getStatusBadge(order.status)}</TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-total-bales-${order.id}`}>
                      {order.totalQtyBales ?? "-"}
                    </TableCell>
                    <TableCell className="text-right font-mono" data-testid={`text-total-weight-${order.id}`}>
                      {parseFloat(order.totalWeightKg || "0") > 0
                        ? parseFloat(order.totalWeightKg!).toLocaleString(undefined, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })
                        : "-"}
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
                    <TableCell>
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => navigate(`/factory/sales/invoices/${order.id}`)}
                          data-testid={`button-view-order-${order.id}`}
                          data-remote-control-safe="true"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {order.status !== "FINALIZED" && (
                          <ConfirmDialog
                            trigger={
                              <Button variant="ghost" size="icon" data-testid={`button-delete-order-${order.id}`}>
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            }
                            title="Delete Invoice"
                            description={`This will permanently delete invoice ${order.invoiceNumber || `#${order.id}`} for ${order.customerName}. Any bales assigned to this order will be returned to stock. This cannot be undone.`}
                            tone="destructive"
                            confirmText="Delete"
                            onConfirm={() => deleteMutation.mutate(order.id)}
                            data-testid={`dialog-delete-order-${order.id}`}
                          />
                        )}
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
