/**
 * A single expanded daybook entry inside a condensed group row.
 *
 * One table row in the shared Daybook table. Carries the per-entry action
 * affordances unchanged: view details, the
 * container "pencil" jump, the source-record edit link, voucher void and the
 * admin hard-delete — including their exact visibility rules. When amounts are
 * hidden by ERP cost permissions only view/pencil remain, as before.
 */
import { Eye, ExternalLink, Trash2, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/formatNumber";
import { cn } from "@/lib/utils";
import { TableCell, TableRow } from "@/components/ui/table";
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

export function FactoryDaybookEntryRow({ entry, model }: { entry: DisplayEntry; model: FactoryDaybookModel }) {
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
      className="h-6 w-6"
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
      className="h-6 w-6"
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
    <TableRow
      data-testid={`row-expanded-${entry.id}`}
      onClick={isBaleTransfer ? (e) => model.handleEntryClick(entry, e) : undefined}
      className={cn("bg-muted/20", isBaleTransfer && "cursor-pointer")}
    >
      <TableCell className="sticky left-0 z-10 w-full max-w-0 overflow-hidden bg-inherit pl-16">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm" title={formatDaybookDescription(entry)}>
            {formatDaybookDescription(entry)}
          </span>
          {entry.optional && (
            <Badge
              variant="outline"
              className="shrink-0 text-xs text-muted-foreground"
              data-testid={`badge-optional-${entry.id}`}
            >
              Optional
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell />
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {showAmounts && (
            <span className="whitespace-nowrap font-mono text-sm tabular-nums">
              {currencySymbol(entry.currencyCode)}
              {formatNumber(parseFloat(entry.amountCurrency))}
            </span>
          )}
          {viewButton}
          {pencilButton}
          {showAmounts && canEdit && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
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
          {showAmounts && isAdminOrOwner && isVoucherBacked && VOIDABLE_TX_TYPES.includes(entry.txType) && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="Delete voucher and reverse accounting"
              aria-label="Delete voucher and reverse accounting"
              onClick={(e) => {
                e.stopPropagation();
                model.setVoidEntry(entry);
              }}
              data-testid={`button-void-voucher-${entry.id}`}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
          {/* Source-backed bonus rows use the reversal transaction, never hard delete.
          All other non-voucher rows retain their existing admin delete flow. */}
          {showAmounts &&
            isAdminOrOwner &&
            entry.id > 0 &&
            entry.txType !== "SUPPLIER_FX_TRANSFER" &&
            entry.txType !== "PRODUCTION_TARGET_BONUS_REVERSAL" &&
            entry.txType !== "PRODUCTION_TARGET_WEEKLY_BONUS_REVERSAL" &&
            !(isVoucherBacked && VOIDABLE_TX_TYPES.includes(entry.txType)) && (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                title={
                  entry.txType.startsWith("PRODUCTION_TARGET_")
                    ? "Remove bonus payment and reverse accounting"
                    : "Delete entry"
                }
                aria-label={
                  entry.txType.startsWith("PRODUCTION_TARGET_")
                    ? "Remove bonus payment and reverse accounting"
                    : "Delete entry"
                }
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
      </TableCell>
    </TableRow>
  );
}
