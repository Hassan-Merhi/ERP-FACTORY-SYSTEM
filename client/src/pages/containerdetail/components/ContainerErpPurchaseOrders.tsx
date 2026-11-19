// Extracted from ./ContainerDetailErpView.tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Trash2, Edit } from "lucide-react";
import type { ContainerDetailErpViewModel, ContainerErpView } from "./ContainerDetailErpViewModel";

export function ContainerErpPurchaseOrders({ m, v }: { m: ContainerDetailErpViewModel; v: ContainerErpView }) {
  return (
    <>
      {v.pos.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No purchase orders found
        </div>
      ) : (
        <div className="space-y-4">
          {v.alphabetizedPos.map((po) => (
            <div key={po.id} className="rounded-lg border bg-card overflow-hidden">
              {/* PO header bar */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3 bg-muted/40 border-b">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-sm" data-testid={`text-po-${po.poNumber}`}>
                    {po.poNumber}
                  </span>
                  <span className="text-xs text-muted-foreground">{po.currency}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold tabular-nums">{m.formatAmount(po.itemsTotal)}</span>
                  {!m.isPropertiesContainer && m.canChangeExistingRecords && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          m.setLocation(
                            `${m.backUrl.startsWith("/properties") ? "/properties" : ""}/purchase-orders/${po.id}/edit`
                          )
                        }
                        data-testid={`button-edit-po-${po.id}`}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => m.handleDeletePO(po.id, po.poNumber)}
                        disabled={m.deletePOMutation.isPending}
                        data-testid={`button-delete-po-${po.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Items table — desktop */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Item Name
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Qty
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Rate
                      </TableHead>
                      <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Total
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {po.items.map((item) => (
                      <TableRow key={item.id} data-testid={`row-item-${item.id}`} className="text-sm">
                        <TableCell className="font-medium py-2">{item.itemName}</TableCell>
                        <TableCell className="text-right tabular-nums py-2 text-muted-foreground">
                          {v.fmtQty(item.quantity)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums py-2 text-muted-foreground">
                          {m.formatAmount(item.rate)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums py-2 font-semibold">
                          {m.formatAmount(item.lineTotal)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Items — mobile */}
              <div className="md:hidden divide-y">
                {po.items.map((item) => (
                  <div key={item.id} className="px-4 py-3 text-sm" data-testid={`row-item-${item.id}`}>
                    <p className="font-medium mb-1.5">{item.itemName}</p>
                    <div className="grid grid-cols-3 gap-2 text-muted-foreground text-xs">
                      <div>
                        <span className="block">Qty</span>
                        <span className="font-mono font-medium text-foreground">{v.fmtQty(item.quantity)}</span>
                      </div>
                      <div>
                        <span className="block">Rate</span>
                        <span className="font-mono font-medium text-foreground">{m.formatAmount(item.rate)}</span>
                      </div>
                      <div>
                        <span className="block">Total</span>
                        <span className="font-mono font-semibold text-foreground">
                          {m.formatAmount(item.lineTotal)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
