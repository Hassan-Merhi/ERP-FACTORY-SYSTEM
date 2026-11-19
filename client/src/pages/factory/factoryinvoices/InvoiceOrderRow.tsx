/**
 * One invoice (customer order) row in the Factory Invoices table.
 *
 * Extracted from FactoryInvoices.tsx during the P1 god-file split. Owns the
 * per-row cells, the drag-handle affordance, the download menu, and the
 * revert/delete confirmations. All data access and mutations stay in the
 * page and are injected through context props.
 */

import { GripVertical } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { getLoadedBalesColorClass } from "./invoiceCalculations";
import { EditableShippingCell } from "./EditableShippingCell";
import { fmtKg, type InvoiceOrderRowProps } from "./InvoiceOrderRowParts";
import { useInvoiceOrderRowState } from "./useInvoiceOrderRowState";
import { InvoiceOrderRowTableCell } from "./InvoiceOrderRowTableCell";
export {
  fmtKg,
  type EditableShippingField,
  type InvoiceColumnKey,
  type InvoiceOrderRowContext,
} from "./InvoiceOrderRowParts";

export function InvoiceOrderRow({
  order,
  indented,
  isDropTarget,
  isDragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isColumnVisible,
  formatDisplayDate,
  getStatusBadge,
  onRowClick,
  onToggleHideOrder,
  onDownload,
  isAdmin,
  unfinalizePending,
  onRevertOrder,
  onDeleteOrder,
  onChangeCustomer,
  onSaveShippingField,
}: InvoiceOrderRowProps) {
  const { recordChanges, recordChangeReason, remaining, expected, overloaded, displayDate } = useInvoiceOrderRowState({
    order,
    formatDisplayDate,
  });

  return (
    <TableRow
      key={order.id}
      className={`cursor-pointer transition-colors hover:bg-blue-500/[0.04] dark:hover:bg-blue-400/[0.06] ${order.isHidden ? "opacity-50" : ""} ${
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
      {isColumnVisible("loading") && (
        <TableCell className="font-mono text-sm text-muted-foreground" data-testid={`text-loading-number-${order.id}`}>
          #{order.id}
        </TableCell>
      )}
      {isColumnVisible("proforma") && (
        <TableCell className="text-sm text-muted-foreground" data-testid={`text-proforma-${order.id}`}>
          {order.proformaName || <span className="text-muted-foreground/50">—</span>}
        </TableCell>
      )}
      {isColumnVisible("container") && (
        <TableCell className="font-mono text-sm" data-testid={`text-container-${order.id}`}>
          <EditableShippingCell
            orderId={order.id}
            field="containerNumber"
            value={order.containerNumber}
            maxLength={100}
            onSave={onSaveShippingField}
          />
        </TableCell>
      )}
      {isColumnVisible("bookingInfo") && (
        <TableCell className="text-sm max-w-[180px]" data-testid={`text-booking-info-${order.id}`}>
          <EditableShippingCell
            orderId={order.id}
            field="bookingInfo"
            value={order.bookingInfo}
            maxLength={2000}
            onSave={onSaveShippingField}
          />
        </TableCell>
      )}
      {isColumnVisible("destination") && (
        <TableCell className="text-sm" data-testid={`text-destination-${order.id}`}>
          <EditableShippingCell
            orderId={order.id}
            field="destination"
            value={order.destination}
            maxLength={500}
            onSave={onSaveShippingField}
          />
        </TableCell>
      )}
      {isColumnVisible("notes") && (
        <TableCell className="text-sm max-w-[200px]" data-testid={`text-notes-${order.id}`}>
          <EditableShippingCell
            orderId={order.id}
            field="containerNotes"
            value={order.containerNotes}
            maxLength={10000}
            multiline
            onSave={onSaveShippingField}
          />
        </TableCell>
      )}
      {isColumnVisible("date") && (
        <TableCell className="font-mono text-sm" data-testid={`text-order-date-${order.id}`}>
          {displayDate}
        </TableCell>
      )}
      {isColumnVisible("status") && <TableCell>{getStatusBadge(order.status)}</TableCell>}
      {isColumnVisible("bales") && (
        <TableCell
          className="text-right font-mono text-sm font-semibold tabular-nums"
          data-testid={`text-total-bales-${order.id}`}
        >
          <span className={getLoadedBalesColorClass(order.totalQtyBales ?? 0)}>{order.totalQtyBales ?? "-"}</span>
        </TableCell>
      )}
      {isColumnVisible("weight") && (
        <TableCell className="text-right font-mono text-sm" data-testid={`text-weight-${order.id}`}>
          {fmtKg(order.totalWeightKg)}
        </TableCell>
      )}
      {isColumnVisible("remaining") && (
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
      )}
      {isColumnVisible("extras") && (
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
      )}
      {isColumnVisible("total") && (
        <TableCell className="text-right font-mono font-semibold" data-testid={`text-grand-total-${order.id}`}>
          $
          {parseFloat(order.grandTotal || "0").toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
          })}
        </TableCell>
      )}
      <InvoiceOrderRowTableCell
        isAdmin={isAdmin}
        onChangeCustomer={onChangeCustomer}
        onDeleteOrder={onDeleteOrder}
        onDownload={onDownload}
        onRevertOrder={onRevertOrder}
        onRowClick={onRowClick}
        onToggleHideOrder={onToggleHideOrder}
        order={order}
        recordChangeReason={recordChangeReason}
        recordChanges={recordChanges}
        unfinalizePending={unfinalizePending}
      />
    </TableRow>
  );
}
