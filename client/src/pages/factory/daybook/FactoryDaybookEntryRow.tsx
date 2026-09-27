/**
 * A single expanded daybook entry inside a condensed group row.
 *
 * Carries the per-entry action affordances unchanged: view details, the
 * container "pencil" jump, the source-record edit link, voucher void and the
 * admin hard-delete — including their exact visibility rules. When amounts are
 * hidden by ERP cost permissions only view/pencil remain, as before.
 */
import { Eye, ExternalLink, Trash2, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/formatNumber";
import { cn } from "@/lib/utils";
import { currencySymbol, formatDaybookDescription, VOUCHER_TX_TYPES } from "./daybookUtils";
import type { DaybookEntry, DisplayEntry } from "./types";
import type { FactoryDaybookModel } from "./useFactoryDaybookModel";

const VOIDABLE_TX_TYPES = ["PAYMENT", "RECEIPT", "JOURNAL"];

function resolvePencilTarget(entry: DaybookEntry): string | null {
  const inlineMeta = (() => {
    try {
      return JSON.parse(entry.metaJson || "{}");
    } catch {
      return {};
    }
  })();
  if (entry.txType === "CONTAINER_IMPORT" && entry.referenceId) return `/factory/containers?edit=${entry.referenceId}`;
  if (entry.txType === "OFFLOAD_RAW_STOCK" && inlineMeta.containerId)
    return `/factory/containers?edit=${inlineMeta.containerId}`;
  if (entry.txType === "COMMISSION" && inlineMeta.containerId)
    return `/factory/containers?edit=${inlineMeta.containerId}`;
  if (entry.txType === "OTHER_CHARGE" && entry.referenceId) return `/factory/containers?edit=${entry.referenceId}`;
  return null;
}

export function FactoryDaybookEntryRow({
  entry,
  colsClass,
  model,
}: {
  entry: DisplayEntry;
  colsClass: string;
  model: FactoryDaybookModel;
}) {
  const { isAdminOrOwner, showAmounts, navigate } = model;
  const de = entry as DisplayEntry;
  const isBaleTransfer = entry.txType === "BALE_TRANSFER";
  const isVoucherBacked = entry.referenceTable === "vouchers" && !!entry.referenceId;
  const canEdit = !!VOUCHER_TX_TYPES[entry.txType] && !!entry.referenceId && entry.txType !== "BALE_STOCK_ENTRY";
  const pencilTarget = resolvePencilTarget(entry);
  const showPencil = pencilTarget && isAdminOrOwner;

  const viewButton = (
    <Button
      size="icon"
      variant="ghost"
      title="View details"
      aria-label="View details"
      onClick={(e) => {
        e.stopPropagation();
        model.setViewEntry((de._source ?? entry) as DaybookEntry);
      }}
      data-testid={`button-view-${entry.id}`}
    >
      <Eye className="h-3 w-3" />
    </Button>
  );

  const pencilButton = showPencil && (
    <Button
      size="icon"
      variant="ghost"
      title="Go to container"
      aria-label="Go to container"
      onClick={(e) => {
        e.stopPropagation();
        navigate(pencilTarget!);
      }}
      data-testid={`button-pencil-${entry.id}`}
    >
      <Pencil className="h-3 w-3 text-amber-500" />
    </Button>
  );

  return (
    <div
      data-testid={`row-expanded-${entry.id}`}
      onClick={isBaleTransfer ? (e) => model.handleEntryClick(entry, e) : undefined}
      // Phones stack the description above its amount and actions; sm+ keeps the column grid.
      className={cn(
        "flex w-full flex-wrap items-center border-t bg-muted/20 sm:grid",
        colsClass,
        isBaleTransfer && "cursor-pointer"
      )}
    >
      {/* Description — deep indent to align under badge */}
      <div className="min-w-0 basis-full py-2 pl-8 pr-3 sm:basis-auto sm:pl-14 sm:pr-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="min-w-0 break-words text-sm text-foreground sm:truncate"
            title={formatDaybookDescription(entry)}
          >
            {formatDaybookDescription(entry)}
          </span>
          {entry.optional && (
            <Badge
              variant="outline"
              className="text-muted-foreground text-xs shrink-0"
              data-testid={`badge-optional-${entry.id}`}
            >
              Optional
            </Badge>
          )}
        </div>
      </div>
      {/* Empty count cell */}
      <div className="hidden sm:block" />
      {/* Amount + actions */}
      {showAmounts ? (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1 py-1 pl-8 pr-2 sm:ml-0 sm:flex-nowrap sm:py-2 sm:pl-0">
          <span className="text-sm font-mono font-medium">
            {currencySymbol(entry.currencyCode)}
            {formatNumber(parseFloat(entry.amountCurrency))}
          </span>
          {viewButton}
          {pencilButton}
          {canEdit && (
            <Button
              size="icon"
              variant="ghost"
              title="Edit"
              aria-label="Edit"
              onClick={(e) => {
                e.stopPropagation();
                model.editSourceRecord(entry);
              }}
              data-testid={`button-edit-source-${entry.id}`}
            >
              <ExternalLink className="h-3 w-3" />
            </Button>
          )}
          {isAdminOrOwner && isVoucherBacked && VOIDABLE_TX_TYPES.includes(entry.txType) && (
            <Button
              size="icon"
              variant="ghost"
              title="Void"
              aria-label="Void"
              onClick={(e) => {
                e.stopPropagation();
                model.setVoidEntry(entry);
              }}
              data-testid={`button-void-voucher-${entry.id}`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
          {/* Hard-delete button for non-voucher entries (admin/developer only).
          SUPPLIER_FX_TRANSFER must be deleted from the supplier management
          page so the underlying transfer record is also removed. */}
          {isAdminOrOwner &&
            entry.id > 0 &&
            entry.txType !== "SUPPLIER_FX_TRANSFER" &&
            !(isVoucherBacked && VOIDABLE_TX_TYPES.includes(entry.txType)) && (
              <Button
                size="icon"
                variant="ghost"
                title="Delete entry"
                aria-label="Delete entry"
                onClick={(e) => {
                  e.stopPropagation();
                  model.setDeleteEntry(de._source as DaybookEntry);
                }}
                data-testid={`button-delete-${entry.id}`}
              >
                <Trash2 className="h-3 w-3 text-destructive/70" />
              </Button>
            )}
        </div>
      ) : (
        <div className="ml-auto flex items-center justify-end gap-1 py-1 pr-2 sm:ml-0 sm:py-2">
          {viewButton}
          {pencilButton}
        </div>
      )}
    </div>
  );
}
