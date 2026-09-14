/**
 * Customer group row for the Factory Invoices table: the bold summary row
 * for a customer with multiple loadings plus the indented child rows when
 * expanded.
 *
 * Extracted from FactoryInvoices.tsx during the P1 god-file split. Group
 * totals come from invoiceCalculations; child rows are InvoiceOrderRow with
 * the same shared context.
 */

import type { DragEvent } from "react";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { computeGroupTotals, type CustomerOrderGroup } from "./invoiceCalculations";
import { fmtKg, InvoiceOrderRow, type InvoiceOrderRowContext } from "./InvoiceOrderRow";

interface InvoiceGroupRowProps extends InvoiceOrderRowContext {
  group: CustomerOrderGroup;
  isExpanded: boolean;
  isDropTarget: boolean;
  isDragging: boolean;
  onToggleExpand: (customerId: number) => void;
  onDragStart: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}

export function InvoiceGroupRow({
  group,
  isExpanded,
  isDropTarget,
  isDragging,
  onToggleExpand,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  ...orderRowContext
}: InvoiceGroupRowProps) {
  const totals = computeGroupTotals(group.orders);

  return (
    <>
      {/* Group summary row */}
      <TableRow
        key={`group-${group.customerId}`}
        className={`cursor-pointer bg-muted/40 font-medium ${
          isDropTarget ? "border-t-2 border-primary" : ""
        } ${isDragging ? "opacity-40" : ""}`}
        draggable
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        onClick={() => onToggleExpand(group.customerId)}
        data-testid={`row-group-${group.customerId}`}
      >
        {/* Drag handle */}
        <TableCell className="w-7 px-1" onClick={(e) => e.stopPropagation()}>
          <GripVertical className="h-4 w-4 text-muted-foreground/30 hover:text-muted-foreground cursor-grab active:cursor-grabbing" />
        </TableCell>
        <TableCell data-testid={`text-group-customer-${group.customerId}`}>
          <div className="flex items-center gap-2">
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span>{group.customerName}</span>
            <Badge variant="outline" className="text-xs font-normal">
              {group.orders.length} loadings
            </Badge>
          </div>
        </TableCell>
        <TableCell className="text-muted-foreground text-sm">—</TableCell>
        {!orderRowContext.hideProformaCol && <TableCell />}
        <TableCell />
        <TableCell />
        <TableCell />
        <TableCell />
        <TableCell />
        <TableCell className="text-right font-mono">{totals.totalBales}</TableCell>
        <TableCell className="text-right font-mono text-sm">{fmtKg(totals.totalWeightKg)}</TableCell>
        <TableCell className="text-right font-mono">
          {totals.totalRemaining > 0 ? (
            <span className="text-red-600 dark:text-red-400">{totals.totalRemaining}</span>
          ) : totals.totalOverloaded > 0 ? (
            <span className="text-amber-600 dark:text-amber-400">+{totals.totalOverloaded}</span>
          ) : (
            <span className="text-green-600 dark:text-green-400">Done</span>
          )}
        </TableCell>
        <TableCell />
        {!orderRowContext.hideTotalsUsd && (
          <TableCell className="text-right font-mono">
            $
            {totals.totalAmount.toLocaleString(undefined, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 2,
            })}
          </TableCell>
        )}
        <TableCell />
      </TableRow>
      {/* Expanded individual rows */}
      {isExpanded &&
        group.orders.map((order) => (
          <InvoiceOrderRow
            key={order.id}
            order={order}
            indented
            isDropTarget={false}
            isDragging={false}
            onDragStart={() => undefined}
            onDragOver={() => undefined}
            onDrop={() => undefined}
            onDragEnd={() => undefined}
            {...orderRowContext}
          />
        ))}
    </>
  );
}
