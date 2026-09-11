/**
 * LOADING_CREATED detail view: the container loading manifest.
 *
 * Extracted from ViewEntryModal, where it was an early-return branch. The
 * branch declared no hooks, so this is a straight move behind a props
 * boundary rather than a behavioural change.
 */
import { DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/formatNumber";
import type { BadgeVariant, DaybookEntry, DisplayDate, LoadingBale, LoadingLine, LoadingOrder, Navigate } from "./types";
import { apiNumber } from "./types";

export function LoadingCreatedView({
  entry,
  onClose,
  formatDisplayDate,
  loadingOrder,
  badgeVariant,
  badgeClass,
  onNavigate,
}: {
  entry: DaybookEntry;
  onClose: () => void;
  formatDisplayDate: DisplayDate;
  loadingOrder: LoadingOrder | null | undefined;
  badgeVariant: BadgeVariant;
  badgeClass: string | undefined;
  onNavigate: Navigate;
}) {
  const lo = loadingOrder;
  const lines: LoadingLine[] = lo?.lines ?? [];
  const balesList: LoadingBale[] = lo?.bales ?? [];
  const n = apiNumber;

  const expectedBalesTotal = lines.reduce((s: number, l) => s + (apiNumber(l.quantity)), 0);
  const scannedBales = balesList.length;
  const totalWeightKg = balesList.reduce((s: number, b) => s + n(b.weight), 0);
  const grandTotal = lo ? n(lo.grandTotal) : 0;
  const subtotalBales = lo ? n(lo.subtotalBales) : 0;
  const freightAmount = lo ? n(lo.freightAmount) : 0;

  return (
    <>
      <DialogHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <DialogTitle>Loading Started</DialogTitle>
          <Badge variant={badgeVariant} className={badgeClass}>
            Loading Started
          </Badge>
        </div>
        <DialogDescription>{formatDisplayDate(entry.txDate + "T00:00:00")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {!lo ? (
          <p className="text-sm text-muted-foreground">Loading order details…</p>
        ) : (
          <>
            {/* Customer + status card */}
            <div className="rounded-md border p-4 space-y-2">
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-semibold text-base">{lo.customerName || `Customer #${lo.customerId}`}</p>
                  {lo.customerCode && <p className="text-xs text-muted-foreground font-mono">{lo.customerCode}</p>}
                  {lo.destination && (
                    <p className="text-xs text-muted-foreground mt-0.5">Destination: {lo.destination}</p>
                  )}
                  {lo.containerNotes && (
                    <p className="text-xs text-muted-foreground mt-0.5 italic">{lo.containerNotes}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="secondary" className="text-xs">
                    {lo.status}
                  </Badge>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => {
                      onClose();
                      onNavigate(`/factory/customer-orders`);
                    }}
                    data-testid="button-open-loading-order"
                  >
                    Open
                  </Button>
                </div>
              </div>
              {lo.proformaName && (
                <p className="text-xs text-muted-foreground">
                  Proforma: <span className="font-medium text-foreground">{lo.proformaName}</span>
                </p>
              )}
              {lo.loadingStartedAt && (
                <p className="text-xs text-muted-foreground">
                  Loading started: {formatDisplayDate(lo.loadingStartedAt)}
                </p>
              )}
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-md bg-muted/40 px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">Expected Bales</p>
                <p className="font-semibold font-mono text-lg">{expectedBalesTotal > 0 ? expectedBalesTotal : "—"}</p>
              </div>
              <div className="rounded-md bg-muted/40 px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">Scanned Bales</p>
                <p className="font-semibold font-mono text-lg">{scannedBales}</p>
              </div>
              <div className="rounded-md bg-muted/40 px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">Total Weight</p>
                <p className="font-semibold font-mono text-lg">
                  {totalWeightKg > 0 ? `${formatNumber(totalWeightKg)} kg` : "—"}
                </p>
              </div>
            </div>

            {/* Order lines (proforma lines / article breakdown) */}
            {lines.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
                  Order Lines ({lines.length})
                </p>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/40 border-b">
                        <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Article
                        </th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Qty (bales)
                        </th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Price / bale
                        </th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l, i: number) => {
                        const qty = apiNumber(l.quantity);
                        const price = n(l.pricePerBale || l.unitPrice || "0");
                        const total = n(l.totalAmount || l.lineTotal || String(qty * price));
                        return (
                          <tr key={l.id ?? i} className="border-b last:border-0">
                            <td className="px-3 py-2">
                              <p className="font-medium font-mono text-xs">{l.articleCode || "—"}</p>
                              {l.productName && <p className="text-xs text-muted-foreground">{l.productName}</p>}
                            </td>
                            <td className="px-3 py-2 text-right font-mono">{qty}</td>
                            <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                              {price > 0 ? `$${formatNumber(price)}` : "—"}
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-medium">
                              {total > 0 ? `$${formatNumber(total)}` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {lines.length > 1 && expectedBalesTotal > 0 && (
                      <tfoot>
                        <tr className="bg-muted/50 border-t font-semibold">
                          <td className="px-3 py-2 text-xs">Total</td>
                          <td className="px-3 py-2 text-right font-mono">{expectedBalesTotal}</td>
                          <td />
                          <td className="px-3 py-2 text-right font-mono">
                            {subtotalBales > 0 ? `$${formatNumber(subtotalBales)}` : "—"}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            )}

            {/* When no proforma lines exist, show scanned bales grouped by product */}
            {lines.length === 0 && balesList.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
                  Scanned Bales by Item ({balesList.length} total)
                </p>
                <div className="rounded-md border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/40 border-b">
                        <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Item
                        </th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Bales
                        </th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Weight (kg)
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(
                        balesList.reduce((acc: Record<string, { count: number; weight: number }>, b) => {
                          const key = b.productName || b.baleName || b.articleCode || "Unknown";
                          if (!acc[key]) acc[key] = { count: 0, weight: 0 };
                          acc[key].count += 1;
                          acc[key].weight += apiNumber(b.weight ?? b.weightKg);
                          return acc;
                        }, {})
                      )
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([name, stats]) => (
                          <tr key={name} className="border-b last:border-0">
                            <td className="px-3 py-2 font-medium">{name}</td>
                            <td className="px-3 py-2 text-right font-mono">{stats.count}</td>
                            <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                              {formatNumber(stats.weight)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-muted/50 border-t font-semibold">
                        <td className="px-3 py-2 text-xs">Total</td>
                        <td className="px-3 py-2 text-right font-mono">{balesList.length}</td>
                        <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                          {formatNumber(
                            balesList.reduce(
                              (sum: number, b) => sum + apiNumber(b.weight ?? b.weightKg),
                              0
                            )
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* Financial summary */}
            {(grandTotal > 0 || freightAmount > 0) && (
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {subtotalBales > 0 && (
                      <tr className="border-b">
                        <td className="px-3 py-2 text-muted-foreground">Subtotal (bales)</td>
                        <td className="px-3 py-2 text-right font-mono font-medium">${formatNumber(subtotalBales)}</td>
                      </tr>
                    )}
                    {freightAmount > 0 && (
                      <tr className="border-b">
                        <td className="px-3 py-2 text-muted-foreground">Freight</td>
                        <td className="px-3 py-2 text-right font-mono font-medium">${formatNumber(freightAmount)}</td>
                      </tr>
                    )}
                    {grandTotal > 0 && (
                      <tr className="bg-muted/50 font-bold">
                        <td className="px-3 py-2">Grand Total</td>
                        <td className="px-3 py-2 text-right font-mono">${formatNumber(grandTotal)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
