import type { HTMLAttributes, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface PosCartColumn {
  key: string;
  label: ReactNode;
  /** Width classes shared by the header cell and the row cells of this column. */
  width: string;
  /** Extra header-cell classes, e.g. text alignment. */
  headerClassName?: string;
}

interface PosCartGridProps {
  columns: PosCartColumn[];
  children: ReactNode;
  /** Shown under the header when the cart has no lines. */
  emptyMessage?: ReactNode;
  /** Summary bar under the last line, normally {@link PosCartSummary}. */
  summary: ReactNode;
  /** Minimum width before the grid scrolls sideways inside its card. */
  minWidthClassName: string;
  /** Lets the lines scroll inside the grid (ERP canvas) instead of growing the page (Retail). */
  bodyMaxHeight?: string;
  id?: string;
  className?: string;
}

/**
 * The cart list shared by both sale screens: header row, line rows, an empty line and the totals
 * summary. Lines are rendered by each screen with {@link PosCartRow} and {@link PosCartCell}, so
 * the ERP editable grid and the Retail variant lines keep their own inputs and handlers.
 */
export function PosCartGrid({
  columns,
  children,
  emptyMessage,
  summary,
  minWidthClassName,
  bodyMaxHeight,
  id,
  className,
}: PosCartGridProps) {
  return (
    <Card data-pos-sale-grid="true" id={id} className={cn("overflow-hidden min-w-0", className)}>
      <div className="table-responsive">
        <div className={minWidthClassName}>
          <div className="flex bg-foreground/6 dark:bg-muted/40 border-b border-border sticky top-0 z-30">
            <div className="w-8 sm:w-12 shrink-0 flex items-center justify-center border-r border-border/50 h-9 text-[11px] font-semibold text-muted-foreground">
              #
            </div>
            {columns.map((column) => (
              <div
                key={column.key}
                className={cn(
                  column.width,
                  "flex items-center px-1.5 sm:px-3 border-r border-border/50 h-9 text-[11px] font-semibold text-muted-foreground",
                  column.headerClassName
                )}
              >
                {column.label}
              </div>
            ))}
          </div>
          <div
            className={bodyMaxHeight ? "overflow-y-auto" : undefined}
            style={bodyMaxHeight ? { maxHeight: bodyMaxHeight } : undefined}
          >
            {children}
          </div>
          {emptyMessage ? (
            <div className="flex min-h-14 items-center border-b text-sm text-muted-foreground">
              <span className="w-8 sm:w-12 shrink-0 text-center text-xs">1</span>
              <span className="px-3">{emptyMessage}</span>
            </div>
          ) : null}
          {summary}
        </div>
      </div>
    </Card>
  );
}

interface PosCartRowProps extends HTMLAttributes<HTMLDivElement> {
  index: number;
}

/** One cart line: the row number, then the screen's own cells. */
export function PosCartRow({ index, className, children, ...rowProps }: PosCartRowProps) {
  return (
    <div className={cn("group flex border-b border-muted/50 hover-elevate", className)} {...rowProps}>
      <div className="w-8 sm:w-12 shrink-0 self-stretch flex items-center justify-center border-r border-muted/50 min-h-9 text-xs text-muted-foreground">
        {index + 1}
      </div>
      {children}
    </div>
  );
}

interface PosCartCellProps extends HTMLAttributes<HTMLDivElement> {
  /** The column's width classes (the same value given to the header). */
  width: string;
}

/** One cell of a cart line, sized like its header column. */
export function PosCartCell({ width, className, children, ...cellProps }: PosCartCellProps) {
  return (
    <div className={cn(width, "border-r", className)} {...cellProps}>
      {children}
    </div>
  );
}

interface PosCartSummaryProps {
  /** Lines counted by the screen (ERP counts priced lines, Retail counts cart lines). */
  itemCount: number;
  quantity: number;
  /** The grand total, already formatted by the screen. */
  total: ReactNode;
}

/** Totals bar under the cart: line count, quantity and the grand total. */
export function PosCartSummary({ itemCount, quantity, total }: PosCartSummaryProps) {
  return (
    <div
      data-pos-sale-summary="true"
      className="flex flex-wrap items-center gap-3 px-2 py-2 border-t border-border bg-muted/20"
    >
      <span className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground" data-testid="pos-cart-item-count">
          {itemCount}
        </span>{" "}
        items&nbsp;&nbsp;Qty{" "}
        <span className="font-semibold text-foreground font-mono" data-testid="pos-cart-quantity">
          {quantity.toFixed(2)}
        </span>
      </span>
      <span className="text-sm ml-auto flex items-baseline gap-1">
        <span className="text-muted-foreground">Total</span>
        <span data-pos-grand-total="true" className="font-mono font-bold text-2xl" data-no-translate>
          {total}
        </span>
      </span>
    </div>
  );
}
