/**
 * Expanded price-lines section of a proforma card: the sortable lines table
 * with inline quantity editing, the per-line edit/delete actions, and the
 * totals footer (plus loading / error / empty states).
 *
 * Extracted from FactoryProformas.tsx during the P1 god-file split. Purely
 * presentational — queries and mutations are owned by the page model.
 */

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pencil, Plus, Trash2, Package } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { effectivePricePerBale } from "./utils";
import type { ProformaLine } from "./types";

interface ProformaLinesTableProps {
  proformaId: number;
  lines: ProformaLine[];
  detailLoading: boolean;
  detailError: boolean;
  onDetailRefetch: () => void;
  canEdit: boolean;
  hideProformaPrice: boolean;
  formatAmount: (amount: number | string | null | undefined) => string;
  inlineQtyLineId: number | null;
  inlineQtyValue: string;
  onInlineQtyValueChange: (value: string) => void;
  onInlineQtyEdit: (lineId: number, currentQuantity: number) => void;
  onInlineQtyCancel: () => void;
  onCommitInlineQty: (lineId: number) => void;
  onEditLine: (line: ProformaLine) => void;
  onDeleteLine: (line: ProformaLine) => void;
  deleteLinePending: boolean;
  totalQty: number;
  totalWeight: number;
  totalAmount: number;
  onAddFirstLine: () => void;
}

export function ProformaLinesTable({
  proformaId,
  lines,
  detailLoading,
  detailError,
  onDetailRefetch,
  canEdit,
  hideProformaPrice,
  formatAmount,
  inlineQtyLineId,
  inlineQtyValue,
  onInlineQtyValueChange,
  onInlineQtyEdit,
  onInlineQtyCancel,
  onCommitInlineQty,
  onEditLine,
  onDeleteLine,
  deleteLinePending,
  totalQty,
  totalWeight,
  totalAmount,
  onAddFirstLine,
}: ProformaLinesTableProps) {
  if (detailLoading) {
    return (
      <div className="space-y-2 px-4 py-5" data-testid={`loading-proforma-lines-${proformaId}`}>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
      </div>
    );
  }

  if (detailError) {
    return (
      <div className="flex flex-col items-center py-8 text-center" data-testid={`error-proforma-lines-${proformaId}`}>
        <p className="text-sm text-destructive">Could not load proforma items.</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={onDetailRefetch}>
          Retry
        </Button>
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="flex flex-col items-center py-10 text-center" data-testid={`text-no-lines-${proformaId}`}>
        <Package className="h-8 w-8 text-muted-foreground/40 mb-2" />
        <p className="text-sm text-muted-foreground">No price lines yet</p>
        {canEdit && (
          <Button size="sm" variant="outline" className="mt-3" onClick={onAddFirstLine}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add first item
          </Button>
        )}
      </div>
    );
  }

  return (
    <div>
      <Table wrapperClassName="max-h-[400px] overflow-auto">
        <TableHeader className="sticky top-0 z-30 bg-background">
          <TableRow>
            <TableHead className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Article Code
            </TableHead>
            <TableHead className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Product Name
            </TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Qty
            </TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Kg/Bale
            </TableHead>
            <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
              Total Kg
            </TableHead>
            {!hideProformaPrice && (
              <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground font-medium">
                Price/Bale
              </TableHead>
            )}
            {canEdit && <TableHead className="w-[72px]"></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...lines]
            .sort((a, b) => (a.productName || a.articleCode || "").localeCompare(b.productName || b.articleCode || ""))
            .map((line) => {
              const lineWt = parseFloat(line.weightPerBaleKg || "0");
              const lineTotal = line.quantity * lineWt;
              const isEditingQty = inlineQtyLineId === line.id;
              return (
                <TableRow key={line.id} className="hover:bg-muted/40" data-testid={`row-line-${line.id}`}>
                  <TableCell
                    className="font-mono text-xs text-muted-foreground py-2.5"
                    data-testid={`text-article-code-${line.id}`}
                  >
                    {line.articleCode}
                  </TableCell>
                  <TableCell className="text-sm font-medium py-2.5" data-testid={`text-product-name-${line.id}`}>
                    {line.productName}
                  </TableCell>
                  <TableCell className="text-right font-mono py-2.5" data-testid={`text-quantity-${line.id}`}>
                    {canEdit && isEditingQty ? (
                      <Input
                        type="number"
                        min="1"
                        className="w-20 h-7 text-right font-mono text-sm ml-auto"
                        value={inlineQtyValue}
                        onChange={(e) => onInlineQtyValueChange(e.target.value)}
                        onBlur={() => onCommitInlineQty(line.id)}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
                          if (e.key === "Enter") onCommitInlineQty(line.id);
                          if (e.key === "Escape") onInlineQtyCancel();
                        }}
                        autoFocus
                        data-testid={`input-inline-qty-${line.id}`}
                      />
                    ) : canEdit ? (
                      <button
                        className="font-mono hover:underline hover:text-primary cursor-pointer w-full text-right"
                        title="Click to edit quantity"
                        onClick={() => onInlineQtyEdit(line.id, line.quantity)}
                        data-testid={`button-inline-qty-${line.id}`}
                      >
                        {line.quantity}
                      </button>
                    ) : (
                      <span className="font-mono">{line.quantity}</span>
                    )}
                  </TableCell>
                  <TableCell
                    className="text-right font-mono text-sm text-muted-foreground py-2.5"
                    data-testid={`text-kg-bale-${line.id}`}
                  >
                    {lineWt % 1 === 0 ? lineWt.toLocaleString() : lineWt.toFixed(2)}
                  </TableCell>
                  <TableCell
                    className="text-right font-mono text-sm text-muted-foreground py-2.5"
                    data-testid={`text-total-kg-${line.id}`}
                  >
                    {lineTotal > 0 ? (lineTotal % 1 === 0 ? lineTotal.toLocaleString() : lineTotal.toFixed(1)) : "—"}
                  </TableCell>
                  {!hideProformaPrice && (
                    <TableCell
                      className="text-right font-mono font-medium py-2.5"
                      data-testid={`text-price-${line.id}`}
                    >
                      {formatAmount(effectivePricePerBale(line))}
                      {line.pricingMode === "per_kg" && line.pricePerKg && (
                        <div className="text-[10px] text-muted-foreground font-normal">
                          ${parseFloat(line.pricePerKg).toFixed(2)}/kg
                        </div>
                      )}
                    </TableCell>
                  )}
                  {canEdit && (
                    <TableCell className="py-2.5">
                      <div className="flex items-center gap-0.5 justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => onEditLine(line)}
                          data-testid={`button-edit-line-${line.id}`}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => onDeleteLine(line)}
                          disabled={deleteLinePending}
                          data-testid={`button-delete-line-${line.id}`}
                        >
                          <Trash2 className="h-3 w-3 text-destructive/70" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
        </TableBody>
      </Table>

      {/* Summary footer */}
      <div className="flex items-center gap-6 px-4 py-3 bg-muted/20 border-t text-sm flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Bales</span>
          <span className="font-semibold font-mono" data-testid={`text-total-qty-${proformaId}`}>
            {totalQty.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Weight</span>
          <span className="font-semibold font-mono" data-testid={`text-total-weight-${proformaId}`}>
            {totalWeight.toLocaleString(undefined, {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            })}{" "}
            kg
          </span>
        </div>
        {!hideProformaPrice && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Total</span>
            <span className="font-semibold font-mono" data-testid={`text-total-amount-${proformaId}`}>
              {formatAmount(totalAmount)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
