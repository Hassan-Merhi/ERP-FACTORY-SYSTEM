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
import { invoicingProformaEditPath } from "@/lib/factoryProformaEditRoutes";
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
  /** False for View Only and Create Only. */
  canChangeExistingRecords: boolean;
  changeDisabledReason: string | null;
  canCreateDispatchBatch: boolean;
  formatAmount: (amount: number | string | null | undefined) => string;
  formatProformaDate: (createdAt: string | null, updatedAt: string | null) => { label: string; value: string };
  navigate: (path: string) => void;
  toggleActiveMutation: ProformaMutationLike<{ id: number; isActive: boolean }>;
  deleteProformaMutation: ProformaMutationLike<number>;
  renameProforma: (proforma: Proforma, currentName: string) => void;
  transferProforma: (proforma: Proforma) => void;
  onAssignDestination: (proforma: Proforma) => void;
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
    canChangeExistingRecords,
    changeDisabledReason,
    canCreateDispatchBatch,
    formatAmount,
    formatProformaDate,
    navigate,
    toggleActiveMutation,
    deleteProformaMutation,
    renameProforma,
    transferProforma,
    onAssignDestination,
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
      className={`overflow-hidden rounded-2xl border border-violet-500/15 bg-card shadow-sm transition-shadow dark:border-violet-400/20 ${isExpanded ? "shadow-md shadow-violet-500/5" : "hover:shadow-md"} ${!proforma.isActive ? "opacity-60" : ""}`}
    >
      {/* Card header row */}
      <div className="flex flex-wrap items-center gap-2 border-b border-violet-500/10 bg-gradient-to-r from-violet-500/[0.10] via-indigo-500/[0.04] to-transparent px-4 py-3.5 dark:from-violet-600/25 dark:via-indigo-500/10 sm:px-5">
        {/* Expand toggle */}
        <button
          className="flex min-w-[170px] flex-1 items-center gap-2.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          onClick={onToggleExpand}
          data-testid={`button-expand-proforma-${proforma.id}`}
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
          <span className="truncate text-base font-bold tracking-tight sm:text-lg">{proforma.name}</span>
          <Badge
            variant="outline"
            className="shrink-0 text-xs"
            data-testid={`badge-proforma-destination-${proforma.id}`}
          >
            {proforma.destination ? `Destination: ${proforma.destination}` : "Destination not linked"}
          </Badge>
          {proforma.isActive && (
            <Badge
              className="shrink-0 rounded-full border border-emerald-400/20 bg-emerald-600 px-2.5 text-white no-default-hover-elevate no-default-active-elevate dark:bg-emerald-600/80"
              data-testid={`badge-active-${proforma.id}`}
            >
              Active
            </Badge>
          )}
        </button>

        {/* Stats chips (hidden on tiny screens) */}
        <div className="order-3 hidden w-full flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground sm:flex lg:order-none lg:w-auto lg:shrink-0">
          <span data-testid={`badge-lines-count-${proforma.id}`} className="flex items-center gap-1 font-medium">
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
            <span data-testid={`text-total-amount-${proforma.id}`} className="font-mono font-bold text-foreground">
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
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg hover:bg-amber-500/10"
            onClick={() => toggleActiveMutation.mutate({ id: proforma.id, isActive: !proforma.isActive })}
            disabled={!canChangeExistingRecords || toggleActiveMutation.isPending}
            data-testid={`button-toggle-active-proforma-${proforma.id}`}
            title={changeDisabledReason ?? (proforma.isActive ? "Deactivate" : "Set active")}
          >
            <Star
              className={
                proforma.isActive ? "h-4 w-4 fill-yellow-400 text-yellow-500" : "h-4 w-4 text-muted-foreground"
              }
            />
          </Button>
          {canCreateDispatchBatch && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg hover:bg-violet-500/10"
              onClick={() =>
                navigate(`/factory/dispatch-batches?customerId=${customerId}&proformaId=${proforma.id}&openCreate=1`)
              }
              data-testid={`button-create-dispatch-batch-${proforma.id}`}
              title="Create dispatch batch"
            >
              <Truck className="h-4 w-4 text-muted-foreground" />
            </Button>
          )}
          {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-lg hover:bg-violet-500/10"
                  data-testid={`button-proforma-menu-${proforma.id}`}
                >
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
        <div>
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-gradient-to-r from-violet-500/[0.06] via-card to-card px-4 py-3 dark:from-violet-500/10 sm:px-5">
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAssignDestination(proforma)}
                className="h-9 rounded-xl border-border/70 bg-background/70 px-3 shadow-sm"
                data-testid={`button-link-proforma-destination-${proforma.id}`}
              >
                {proforma.destination ? "Change Destination" : "Assign Destination"}
              </Button>
            )}
            {canEdit && (
              <Button
                size="sm"
                className="h-9 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 px-4 font-semibold text-white shadow-sm shadow-violet-500/20 hover:from-violet-500 hover:to-indigo-500"
                onClick={onAddLine}
                data-testid={`button-add-line-${proforma.id}`}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add Item
              </Button>
            )}
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate(invoicingProformaEditPath(proforma.id, customerId))}
                className="h-9 rounded-xl border-border/70 bg-background/70 px-3 shadow-sm"
                data-testid={`button-edit-in-allocation-${proforma.id}`}
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit in Stock Allocation
              </Button>
            )}
            {canChangeExistingRecords && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => saveAgreedPricesMutation.mutate(proforma.id)}
                  disabled={saveAgreedPricesMutation.isPending || !proforma.destination}
                  className="h-9 rounded-xl border-border/70 bg-background/70 px-3 shadow-sm"
                  data-testid={`button-save-agreed-prices-${proforma.id}`}
                  title={
                    proforma.destination
                      ? `Save these as agreed prices for ${proforma.destination}`
                      : "Assign a destination first"
                  }
                >
                  <BookmarkCheck className="mr-1.5 h-3.5 w-3.5" />
                  Save as Agreed Prices
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => applyProductionPricesMutation.mutate(proforma.id)}
                  disabled={applyProductionPricesMutation.isPending}
                  className="h-9 rounded-xl border-border/70 bg-background/70 px-3 shadow-sm"
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
                  className="h-9 rounded-xl border-border/70 bg-background/70 px-3 shadow-sm"
                  data-testid={`button-apply-selling-prices-${proforma.id}`}
                  title="Set all line prices to the selling price from the catalogue"
                >
                  Apply Selling Price
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => window.open(`/api/factory/customer-proformas/${proforma.id}/export/excel`, "_blank")}
              className="h-9 rounded-xl border-border/70 bg-background/70 px-3 shadow-sm"
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
              className="h-9 rounded-xl border-border/70 bg-background/70 px-3 shadow-sm"
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
