// Extracted from ./InvoiceOrderRow.tsx
import {
  Container,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  RotateCcw,
  UserRoundCog,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell } from "@/components/ui/table";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type InvoiceOrderRowProps } from "./InvoiceOrderRowParts";
import { useInvoiceOrderRowState } from "./useInvoiceOrderRowState";

export function InvoiceOrderRowTableCell({
  isAdmin,
  onChangeCustomer,
  onDeleteOrder,
  onDownload,
  onRevertOrder,
  onRowClick,
  onToggleHideOrder,
  order,
  recordChangeReason,
  recordChanges,
  unfinalizePending,
}: Pick<
  InvoiceOrderRowProps,
  | "isAdmin"
  | "onChangeCustomer"
  | "onDeleteOrder"
  | "onDownload"
  | "onRevertOrder"
  | "onRowClick"
  | "onToggleHideOrder"
  | "order"
  | "unfinalizePending"
> &
  Pick<ReturnType<typeof useInvoiceOrderRowState>, "recordChangeReason" | "recordChanges">) {
  return (
    <TableCell>
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <Button
          variant="ghost"
          size="icon"
          title={recordChanges.reason ?? (order.isHidden ? "Unhide loading" : "Hide loading")}
          disabled={!recordChanges.allowed}
          data-testid={`button-hide-order-${order.id}`}
          onClick={() => onToggleHideOrder(order)}
        >
          {order.isHidden ? (
            <Eye className="h-4 w-4 text-muted-foreground" />
          ) : (
            <EyeOff className="h-4 w-4 text-muted-foreground" />
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" data-testid={`button-download-${order.id}`} title="Download Invoice">
              <Download className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => onDownload(`/api/factory/customer-orders/${order.id}/export/excel`, "invoice.xlsx")}
              data-testid={`button-download-excel-${order.id}`}
            >
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              Excel
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                onDownload(
                  `/api/factory/customer-orders/${order.id}/export-excel?noCharges=1`,
                  "invoice-no-charges.xlsx"
                )
              }
              data-testid={`button-download-excel-no-charges-${order.id}`}
            >
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              Excel (No Charges)
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onDownload(`/api/factory/customer-orders/${order.id}/export-pdf`, "invoice.pdf")}
              data-testid={`button-download-pdf-${order.id}`}
            >
              <FileText className="h-4 w-4 mr-2" />
              PDF
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                onDownload(`/api/factory/customer-orders/${order.id}/export-pdf?noCharges=1`, "invoice-no-charges.pdf")
              }
              data-testid={`button-download-pdf-no-charges-${order.id}`}
            >
              <FileText className="h-4 w-4 mr-2" />
              PDF (No Charges)
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem
                onClick={() =>
                  onDownload(`/api/factory/customer-orders/${order.id}/loading-status-export`, "loading-status.xlsx")
                }
                data-testid={`button-download-loading-status-${order.id}`}
              >
                <Container className="h-4 w-4 mr-2" />
                Loading Status + Bale Refs
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onRowClick(order)}
          data-testid={`button-view-order-${order.id}`}
        >
          <Eye className="h-4 w-4" />
        </Button>
        {isAdmin && recordChanges.allowed && order.status === "LOADING" && (
          <Button
            variant="ghost"
            size="icon"
            title="Change loading customer"
            data-testid={`button-change-loading-customer-${order.id}`}
            onClick={() => onChangeCustomer(order.id)}
          >
            <UserRoundCog className="h-4 w-4" />
          </Button>
        )}
        {order.status === "FINALIZED" && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={unfinalizePending || !recordChanges.allowed}
                title={recordChangeReason}
                aria-label={recordChanges.reason ?? "Revert to Verified"}
                data-testid={`button-revert-order-${order.id}`}
              >
                <RotateCcw className="h-4 w-4 text-muted-foreground" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revert to Verified</AlertDialogTitle>
                <AlertDialogDescription>
                  This will revert invoice {order.invoiceNumber} for {order.customerName} back to Verified status. The
                  invoice number will be voided, all bales will return to stock, and the customer balance entry will be
                  removed. This cannot be done if any payment has been recorded against this invoice.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid={`button-cancel-revert-${order.id}`}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onRevertOrder(order.id)}
                  data-testid={`button-confirm-revert-${order.id}`}
                >
                  Revert to Verified
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        {order.status !== "FINALIZED" && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                disabled={!recordChanges.allowed}
                title={recordChangeReason}
                aria-label={recordChanges.reason ?? "Delete loading"}
                data-testid={`button-delete-order-${order.id}`}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Loading</AlertDialogTitle>
                <AlertDialogDescription>
                  Delete loading {order.invoiceNumber || `#${order.id}`} for {order.customerName}? Its eligible bales
                  will become available in stock again. The loading is moved to Settings → Deleted Items for recovery;
                  finalized invoices cannot be deleted here.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid={`button-cancel-delete-${order.id}`}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDeleteOrder(order.id)}
                  data-testid={`button-confirm-delete-${order.id}`}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </TableCell>
  );
}
