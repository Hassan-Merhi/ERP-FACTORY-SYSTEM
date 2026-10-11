/**
 * Mobile cart for the Factory POS page: one card per line, the "tap to add"
 * row and the running summary.
 *
 * Split out of FactoryPOS.tsx unchanged; the summary still shows the struck
 * gross total alongside the net when deductions exist.
 */
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNum } from "./utils";
import type { FactoryPosModel } from "./useFactoryPosModel";

export function FactoryPosMobileCart({ model }: { model: FactoryPosModel }) {
  const { ccPrefix, validRows, totalQty, totalWeight, total, netTotal, totalExpenseAmount } = model;
  return (
    <div className="md:hidden space-y-1 pb-36">
      {model.rows.map((row, idx) => {
        if (!row.productId) return null;
        return (
          <div
            key={row.id}
            className="rounded-md border bg-card px-3 py-2.5 flex items-center gap-2 hover-elevate active-elevate-2 cursor-pointer"
            onClick={() => model.openMobileRowEdit(idx)}
            data-testid={`mobile-row-card-${idx}`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground shrink-0">{idx + 1}.</span>
                <span className="text-sm font-medium truncate">{row.productName}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                Qty: {row.quantity} · Price: {ccPrefix}
                {formatNum(row.unitPrice)}
              </div>
            </div>
            <div className="shrink-0 flex items-center gap-1.5">
              <span className="text-sm font-semibold font-mono">
                {ccPrefix}
                {formatNum(row.quantity * row.unitPrice)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => {
                  e.stopPropagation();
                  model.deleteRow(idx);
                }}
                data-testid={`mobile-delete-row-${idx}`}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
          </div>
        );
      })}

      {/* Tap to add item */}
      <div
        className="rounded-md border border-dashed border-muted-foreground/30 px-3 py-3 flex items-center gap-2 text-muted-foreground cursor-pointer hover-elevate active-elevate-2"
        onClick={model.openMobileBrowse}
        data-testid="mobile-add-item-card"
      >
        <Plus className="h-4 w-4" />
        <span className="text-sm">Tap to add item</span>
      </div>

      {/* Mobile summary */}
      <div className="rounded-md border bg-muted/30 px-3 py-2 flex items-center justify-between gap-2 mt-2">
        <span className="text-xs text-muted-foreground">
          {validRows.length} items · Qty {totalQty}
          {totalWeight > 0 && ` · ${formatNum(totalWeight)} kg`}
        </span>
        <div className="text-right">
          {totalExpenseAmount > 0 ? (
            <>
              <div className="text-xs text-muted-foreground line-through font-mono">
                {ccPrefix}
                {formatNum(total)}
              </div>
              <div className="text-base font-semibold font-mono" data-testid="text-grand-total-mobile">
                {ccPrefix}
                {formatNum(netTotal)}
              </div>
            </>
          ) : (
            <span className="text-base font-semibold font-mono" data-testid="text-grand-total-mobile">
              {ccPrefix}
              {formatNum(total)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
