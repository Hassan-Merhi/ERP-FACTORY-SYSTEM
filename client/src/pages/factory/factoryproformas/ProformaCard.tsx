/**
 * One proforma card in the Factory Proformas list: the expandable header
 * (stats chips + actions) and the expanded toolbar, price-lines section, and
 * footer.
 *
 * Extracted from FactoryProformas.tsx during the P1 god-file split. Purely
 * presentational — the page model owns all queries, mutations, and dialog
 * state; this card only renders and forwards user intent.
 */

import {
  ArrowRightLeft,
  BookmarkCheck,
  ChevronDown,
  ChevronRight,
  Download,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Star,
  Trash2,
  Truck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { effectivePricePerBale } from "./utils";
import type { Proforma, ProformaLine } from "./types";
import { ProformaLinesTable } from "./ProformaLinesTable";

interface ProformaMutationLike<TArgs> {
  isPending: boolean;
  mutate: (args: TArgs) => void;
}

interface ProformaCardProps {
  proforma: Proforma;
  isExpanded: boolean;
  onToggleExpand: () => void;
  /** Lazy detail for the expanded card (lines), if already fetched. */
  detailProforma: { lines: ProformaLine[] } | undefined;
  detailLoading: boolean;
  detailError: boolean;
  onDetailRefetch: () => void;
  /** The customer currently selected in the header (as in the original page). */
  customerId: string | number | null;
  hideProformaPrice: boolean;
  canEdit: boolean;
  formatAmount: (amount: number | string | null | undefined) => string;
  formatProformaDate: (createdAt: string | null, updatedAt: string | null) => { label: string; value: string };
  navigate: (path: string) => void;
  toggleActiveMutation: ProformaMutationLike<{ id: number; isActive: boolean }>;
  deleteProformaMutation: ProformaMutationLike<number>;
  renameProforma: (proforma: Proforma, currentName: string) => void;
  transferProforma: (proforma: Proforma) => void;
  setPendingDelete: (action: (() => void) | null) => void;
  // "Add Item" wiring (dialog state lives in the page model)
  onAddLine: () => void;
  saveAgreedPricesMutation: ProformaMutationLike<number>;
  applyProductionPricesMutation: ProformaMutationLike<number>;
  applyCatalogPricesMutation: ProformaMutationLike<number>;
  // Inline quantity editing
  inlineQtyLineId: number | null;
  inlineQtyValue: string;
  onInlineQtyValueChange: (value: string) => void;
  onInlineQtyEdit: (lineId: number, currentQuantity: number) => void;
  onInlineQtyCancel: () => void;
  commitInlineQty: (lineId: number) => void;
  // Line editing / deletion
  onEditLine: (line: ProformaLine) => void;
  deleteLineMutation: ProformaMutationLike<number>;
}

export function ProformaCard(props: ProformaCardProps) {
  const {
    proforma,
    isExpanded,
    onToggleExpand,
    detailProforma,
    detailLoading,
    detailError,
    onDetailRefetch,
    customerId,
    hideProformaPrice,
    canEdit,
    formatAmount,
    formatProformaDate,
    navigate,
    toggleActiveMutation,
    deleteProformaMutation,
    renameProforma,
    transferProforma,
    setPendingDelete,
    onAddLine,
    saveAgreedPricesMutation,
    applyProductionPricesMutation,
    applyCatalogPricesMutation,
    inlineQtyLineId,
    inlineQtyValue,
    onInlineQtyValueChange,
    onInlineQtyEdit,
    onInlineQtyCancel,
    commitInlineQty,
    onEditLine,
    deleteLineMutation,
  } = props;

  const displayLines = detailProforma?.lines ?? [];
  const totalQty = detailProforma ? displayLines.reduce((s, l) => s + l.quantity, 0) : Number(proforma.totalQty || 0);
  const totalWeight = detailProforma
    ? displayLines.reduce((s, l) => s + l.quantity * parseFloat(l.weightPerBaleKg || "0"), 0)
    : Number(proforma.totalWeightKg || 0);
  const totalAmount = detailProforma
    ? displayLines.reduce((s, l) => s + l.quantity * effectivePricePerBale(l), 0)
    : Number(proforma.totalAmount || 0);
  const lineCount = detailProforma ? displayLines.length : Number(proforma.lineCount || 0);
  const d = formatProformaDate(proforma.createdAt, proforma.updatedAt);

  return (
    <div
      data-testid={`card-proforma-${proforma.id}`}
      className={`rounded-lg border bg-card transition-shadow ${isExpanded ? "shadow-sm" : ""} ${!proforma.isActive ? "opacity-60" : ""}`}
    >
      {/* Card header row */}
      <div className="flex items-center gap-2 px-4 py-3">
        {/* Expand toggle */}
        <button
          className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
          onClick={onToggleExpand}
          data-testid={`button-expand-proforma-${proforma.id}`}
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
          <span className="font-semibold truncate">{proforma.name}</span>
          {proforma.isActive && (
            <Badge
              className="bg-green-600 text-white shrink-0 no-default-hover-elevate no-default-active-elevate"
              data-testid={`badge-active-${proforma.id}`}
            >
              Active
            </Badge>
          )}
        </button>

        {/* Stats chips (hidden on tiny screens) */}
        <div className="hidden sm:flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          <span data-testid={`badge-lines-count-${proforma.id}`} className="flex items-center gap-1">
            <Package className="h-3 w-3" />
            {lineCount} lines
          </span>
          {totalQty > 0 && (
            <span data-testid={`text-total-qty-${proforma.id}`} className="font-mono">
              {totalQty.toLocaleString()} bales
            </span>
          )}
          {totalWeight > 0 && (
            <span data-testid={`text-total-weight-${proforma.id}`} className="font-mono">
              {totalWeight.toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              })}{" "}
              kg
            </span>
          )}
          {!hideProformaPrice && totalAmount > 0 && (
            <span data-testid={`text-total-amount-${proforma.id}`} className="font-mono font-medium text-foreground">
              {formatAmount(totalAmount)}
            </span>
          )}
          {d.value && (
            <span data-testid={`text-proforma-date-${proforma.id}`} className="text-muted-foreground/70">
              {d.label} {d.value}
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 shrink-0 ml-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => toggleActiveMutation.mutate({ id: proforma.id, isActive: !proforma.isActive })}
            disabled={toggleActiveMutation.isPending}
            data-testid={`button-toggle-active-proforma-${proforma.id}`}
            title={proforma.isActive ? "Deactivate" : "Set active"}
          >
            <Star
              className={
                proforma.isActive ? "h-4 w-4 fill-yellow-400 text-yellow-500" : "h-4 w-4 text-muted-foreground"
              }
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() =>
              navigate(`/factory/dispatch-batches?customerId=${customerId}&proformaId=${proforma.id}&openCreate=1`)
            }
            data-testid={`button-create-dispatch-batch-${proforma.id}`}
            title="Create dispatch batch"
          >
            <Truck className="h-4 w-4 text-muted-foreground" />
          </Button>
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" data-testid={`button-proforma-menu-${proforma.id}`}>
                  <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => renameProforma(proforma, proforma.name)}
                  data-testid={`button-rename-proforma-${proforma.id}`}
                >
                  <Pencil className="h-3.5 w-3.5 mr-2" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => transferProforma(proforma)}
                  data-testid={`button-transfer-proforma-${proforma.id}`}
                >
                  <ArrowRightLeft className="h-3.5 w-3.5 mr-2" />
                  Transfer customer
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setPendingDelete(() => () => deleteProformaMutation.mutate(proforma.id))}
                  data-testid={`button-delete-proforma-${proforma.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t">
          {/* Toolbar */}
          <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/30 flex-wrap">
            {canEdit && (
              <Button size="sm" onClick={onAddLine} data-testid={`button-add-line-${proforma.id}`}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add Item
              </Button>
            )}
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate(`/factory/stock-allocation-v5?proformaId=${proforma.id}&openEdit=true`)}
                data-testid={`button-edit-in-allocation-${proforma.id}`}
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit in Stock Allocation
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => saveAgreedPricesMutation.mutate(proforma.id)}
              disabled={saveAgreedPricesMutation.isPending}
              data-testid={`button-save-agreed-prices-${proforma.id}`}
              title="Save these prices as the customer's agreed prices"
            >
              <BookmarkCheck className="mr-1.5 h-3.5 w-3.5" />
              Save as Agreed Prices
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => applyProductionPricesMutation.mutate(proforma.id)}
              disabled={applyProductionPricesMutation.isPending}
              data-testid={`button-apply-production-prices-${proforma.id}`}
              title="Set all line prices to the production (cost) price from the catalogue"
            >
              Apply Production Price
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => applyCatalogPricesMutation.mutate(proforma.id)}
              disabled={applyCatalogPricesMutation.isPending}
              data-testid={`button-apply-selling-prices-${proforma.id}`}
              title="Set all line prices to the selling price from the catalogue"
            >
              Apply Selling Price
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(`/api/factory/customer-proformas/${proforma.id}/export/excel`, "_blank")}
              data-testid={`button-export-excel-${proforma.id}`}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Excel
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!navigator.onLine) {
                  window.print();
                  return;
                }
                window.open(`/api/factory/customer-proformas/${proforma.id}/export/pdf`, "_blank");
              }}
              data-testid={`button-export-pdf-${proforma.id}`}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              PDF
            </Button>
          </div>

          {/* Price lines table — lazy detail only after expansion */}
          <ProformaLinesTable
            proformaId={proforma.id}
            lines={displayLines}
            detailLoading={detailLoading}
            detailError={detailError}
            onDetailRefetch={onDetailRefetch}
            canEdit={canEdit}
            hideProformaPrice={hideProformaPrice}
            formatAmount={formatAmount}
            inlineQtyLineId={inlineQtyLineId}
            inlineQtyValue={inlineQtyValue}
            onInlineQtyValueChange={onInlineQtyValueChange}
            onInlineQtyEdit={onInlineQtyEdit}
            onInlineQtyCancel={onInlineQtyCancel}
            onCommitInlineQty={commitInlineQty}
            onEditLine={onEditLine}
            onDeleteLine={(line) => setPendingDelete(() => () => deleteLineMutation.mutate(line.id))}
            deleteLinePending={deleteLineMutation.isPending}
            totalQty={totalQty}
            totalWeight={totalWeight}
            totalAmount={totalAmount}
            onAddFirstLine={onAddLine}
          />
        </div>
      )}
    </div>
  );
}
