/**
 * One invoice (customer order) row in the Factory Invoices table.
 *
 * Extracted from FactoryInvoices.tsx during the P1 god-file split. Owns the
 * per-row cells, the drag-handle affordance, the download menu, and the
 * revert/delete confirmations. All data access and mutations stay in the
 * page and are injected through context props.
 */

import type { DragEvent, ReactNode } from "react";
import {
  Container,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  FileText,
  GripVertical,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
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
import { getOverloadedBales, getRemainingBales } from "./invoiceCalculations";
import type { CustomerOrder } from "./types";

/** Weight cell formatting shared by the order row and the customer group row. */
export function fmtKg(val: string | number | null | undefined) {
  const n = parseFloat(String(val ?? "0"));
  if (!n) return <span className="text-muted-foreground/40">—</span>;
  return <>{n.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg</>;
}

/** Page-level callbacks shared by every order row (and the group rows). */
export interface InvoiceOrderRowContext {
  hideProformaCol: boolean;
  hideTotalsUsd: boolean;
  formatDisplayDate: (date: string) => string;
  getStatusBadge: (status: string) => ReactNode;
  onRowClick: (order: CustomerOrder) => void;
  onToggleHideOrder: (order: CustomerOrder) => void;
  onDownload: (url: string, fallbackName: string) => void;
  isAdmin: boolean;
  unfinalizePending: boolean;
  onRevertOrder: (orderId: number) => void;
  onDeleteOrder: (orderId: number) => void;
}

interface InvoiceOrderRowProps extends InvoiceOrderRowContext {
  order: CustomerOrder;
  indented: boolean;
  isDropTarget: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

export function InvoiceOrderRow({
  order,
  indented,
  isDropTarget,
  isDragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  hideProformaCol,
  hideTotalsUsd,
  formatDisplayDate,
  getStatusBadge,
  onRowClick,
  onToggleHideOrder,
  onDownload,
  isAdmin,
  unfinalizePending,
  onRevertOrder,
  onDeleteOrder,
}: InvoiceOrderRowProps) {
  const remaining = getRemainingBales(order);
  const expected = parseFloat(order.proformaExpectedBales || "0");
  const overloaded = getOverloadedBales(order);

  return (
    <TableRow
      key={order.id}
      className={`cursor-pointer ${order.isHidden ? "opacity-50" : ""} ${
        !indented && isDropTarget ? "border-t-2 border-primary" : ""
      } ${!indented && isDragging ? "opacity-40" : ""}`}
      draggable={!indented}
      onDragStart={!indented ? onDragStart : undefined}
      onDragOver={!indented ? onDragOver : undefined}
      onDrop={!indented ? onDrop : undefined}
      onDragEnd={!indented ? onDragEnd : undefined}
      onClick={() => onRowClick(order)}
      data-testid={`row-order-${order.id}`}
    >
      {/* Drag handle — only for top-level (non-indented) rows */}
      <TableCell className="w-7 px-1" onClick={(e) => e.stopPropagation()}>
        {!indented && (
          <GripVertical className="h-4 w-4 text-muted-foreground/30 hover:text-muted-foreground cursor-grab active:cursor-grabbing" />
        )}
      </TableCell>
      <TableCell data-testid={`text-customer-name-${order.id}`}>
        {indented ? <span className="pl-5 text-muted-foreground/50 text-xs">↳</span> : order.customerName}
      </TableCell>
      <TableCell className="font-mono text-sm text-muted-foreground" data-testid={`text-loading-number-${order.id}`}>
        #{order.id}
      </TableCell>
      {!hideProformaCol && (
        <TableCell className="text-sm text-muted-foreground" data-testid={`text-proforma-${order.id}`}>
          {order.proformaName || <span className="text-muted-foreground/50">—</span>}
        </TableCell>
      )}
      <TableCell className="font-mono text-sm" data-testid={`text-container-${order.id}`}>
        {order.containerNumber || <span className="text-muted-foreground/50">—</span>}
      </TableCell>
      <TableCell className="text-sm" data-testid={`text-destination-${order.id}`}>
        {order.destination || <span className="text-muted-foreground/50">—</span>}
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
      <TableCell>{getStatusBadge(order.status)}</TableCell>
      <TableCell className="text-right font-mono" data-testid={`text-total-bales-${order.id}`}>
        {order.totalQtyBales ?? "-"}
      </TableCell>
      <TableCell className="text-right font-mono text-sm" data-testid={`text-weight-${order.id}`}>
        {fmtKg(order.totalWeightKg)}
      </TableCell>
      <TableCell className="text-right font-mono" data-testid={`text-remaining-${order.id}`}>
        {expected <= 0 ? (
          <span className="text-muted-foreground/40">—</span>
        ) : remaining > 0 ? (
          <span className="text-red-600 dark:text-red-400 font-medium">{remaining}</span>
        ) : overloaded > 0 ? (
          <span className="text-amber-600 dark:text-amber-400 font-medium">+{overloaded}</span>
        ) : (
          <span className="text-green-600 dark:text-green-400 font-medium">Done</span>
        )}
      </TableCell>
      <TableCell className="text-right font-mono text-sm" data-testid={`text-extras-${order.id}`}>
        {parseFloat(order.freightAmount || "0") <= 0 && parseFloat(order.otherChargesTotal || "0") <= 0 ? (
          <span className="text-muted-foreground/40">—</span>
        ) : (
          <div className="flex flex-col items-end gap-0.5">
            {parseFloat(order.freightAmount || "0") > 0 && (
              <span className="text-blue-600 dark:text-blue-400">
                $
                {parseFloat(order.freightAmount).toLocaleString(undefined, {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 2,
                })}
                <span className="text-muted-foreground/60 text-xs ml-1">freight</span>
              </span>
            )}
            {parseFloat(order.otherChargesTotal || "0") > 0 && (
              <span className="text-purple-600 dark:text-purple-400">
                $
                {parseFloat(order.otherChargesTotal).toLocaleString(undefined, {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 2,
                })}
                <span className="text-muted-foreground/60 text-xs ml-1">other</span>
              </span>
            )}
          </div>
        )}
      </TableCell>
      {!hideTotalsUsd && (
        <TableCell className="text-right font-mono font-semibold" data-testid={`text-grand-total-${order.id}`}>
          $
          {parseFloat(order.grandTotal || "0").toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
          })}
        </TableCell>
      )}
      <TableCell>
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            title={order.isHidden ? "Unhide loading" : "Hide loading"}
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
                  onDownload(
                    `/api/factory/customer-orders/${order.id}/export-pdf?noCharges=1`,
                    "invoice-no-charges.pdf"
                  )
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
          {order.status === "FINALIZED" && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={unfinalizePending}
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
                    invoice number will be voided, all bales will return to stock, and the customer balance entry will
                    be removed. This cannot be done if any payment has been recorded against this invoice.
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
                <Button variant="ghost" size="icon" data-testid={`button-delete-order-${order.id}`}>
                  <Trash2 className="h-4 w-4 text-destructive" />
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
    </TableRow>
  );
}
