// Extracted from ./RetailSalesHistory.tsx
import { money } from "./retailInventoryTypes";
import type { RetailSale } from "@/pages/pos/retailPosTypes";

export function SaleBreakdown({ sale }: { sale: RetailSale }) {
  return (
    <div className="space-y-2">
      {sale.items.map((item) => (
        <div key={item.id} className="flex flex-wrap items-center gap-2 text-sm" data-no-translate>
          <span className="min-w-0 flex-1 truncate">
            {item.name} · {item.color} · {item.size} <span className="text-muted-foreground">× {item.quantity}</span>
          </span>
          {Number(item.lineDiscountAmount ?? 0) > 0 && (
            <span className="text-xs text-destructive">-{money(item.lineDiscountAmount ?? 0)}</span>
          )}
          <span className="font-medium">
            {money(item.lineTotal ?? item.quantity * (item.grossUnitPrice ?? item.unitPrice))}
          </span>
        </div>
      ))}
      <div className="space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{money(sale.listSubtotal ?? sale.totalAmount)}</span>
        </div>
        {Number(sale.discountTotal ?? 0) > 0 && (
          <div className="flex justify-between text-destructive">
            <span>Discount{sale.orderDiscountReason ? ` · ${sale.orderDiscountReason}` : ""}</span>
            <span>-{money(sale.discountTotal ?? 0)}</span>
          </div>
        )}
        {sale.taxEnabled && (
          <div className="flex justify-between">
            <span>{sale.taxLabel || "Tax"}</span>
            <span>{money(sale.taxAmount ?? 0)}</span>
          </div>
        )}
        <div className="flex justify-between text-sm font-semibold text-foreground">
          <span>Total</span>
          <span>{money(sale.totalAmount)}</span>
        </div>
      </div>
    </div>
  );
}
