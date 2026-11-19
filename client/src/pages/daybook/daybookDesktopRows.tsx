// Extracted from ./DaybookTable.tsx: desktop table rows for the detailed Daybook view.
import { ChevronRight, Package, Eye, ExternalLink, Lock, Pencil, EyeOff, Trash2 } from "lucide-react";
import { parseISO } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { getVoucherTypeBadge } from "@/lib/voucherTypeBadge";
import { cn } from "@/lib/utils";
import { isVoucherMutationBlocked, voucherLockLabel } from "@/lib/migratedVoucherGuard";
import { Voucher, ViewVoucherEntry } from "./types";
import type { useBoundedTableRows } from "@/hooks/useBoundedTableRows";
import type { DaybookTableProps } from "./daybookTableProps";

export function buildDaybookDesktopRows({
  daybookDesktopWindow,
  hideAmounts,
  desktopRows,
  offloadAlphabetical,
  visibleRows,
  formatDisplayDate,
  formatAmount,
  selectedRowId,
  setSelectedRowId,
  navigate,
  hiddenRowIds,
  expandedVoucherId,
  showHidden,
  setExpandedVoucherId,
  formatDisplayTime,
  accountNameCache,
  handleView,
  handleEdit,
  canEdit,
  setHiddenRowIds,
  canDelete,
  linkedVoucherIds,
  handleDelete,
  expandedLoading,
  expandedEntries,
  formatTransactionAmount,
}: {
  daybookDesktopWindow: ReturnType<typeof useBoundedTableRows>;
  hideAmounts: DaybookTableProps["hideAmounts"];
  desktopRows: DaybookTableProps["displayedRows"];
  offloadAlphabetical: Exclude<DaybookTableProps["offloadAlphabetical"], undefined>;
  visibleRows: DaybookTableProps["visibleRows"];
  formatDisplayDate: DaybookTableProps["formatDisplayDate"];
  formatAmount: DaybookTableProps["formatAmount"];
  selectedRowId: DaybookTableProps["selectedRowId"];
  setSelectedRowId: DaybookTableProps["setSelectedRowId"];
  navigate: DaybookTableProps["navigate"];
  hiddenRowIds: DaybookTableProps["hiddenRowIds"];
  expandedVoucherId: DaybookTableProps["expandedVoucherId"];
  showHidden: DaybookTableProps["showHidden"];
  setExpandedVoucherId: DaybookTableProps["setExpandedVoucherId"];
  formatDisplayTime: DaybookTableProps["formatDisplayTime"];
  accountNameCache: DaybookTableProps["accountNameCache"];
  handleView: DaybookTableProps["handleView"];
  handleEdit: DaybookTableProps["handleEdit"];
  canEdit: (v: Voucher) => boolean;
  setHiddenRowIds: DaybookTableProps["setHiddenRowIds"];
  canDelete: () => boolean;
  linkedVoucherIds: DaybookTableProps["linkedVoucherIds"];
  handleDelete: DaybookTableProps["handleDelete"];
  expandedLoading: DaybookTableProps["expandedLoading"];
  expandedEntries: DaybookTableProps["expandedEntries"];
  formatTransactionAmount: DaybookTableProps["formatTransactionAmount"];
}) {
  /* ── Detailed view ── */

  // ── Build desktop table rows (unchanged) ─────────────────────────────────
  const tableRows: React.JSX.Element[] = [];
  if (daybookDesktopWindow.topSpacerHeight > 0) {
    tableRows.push(
      <TableRow key="daybook-virtual-spacer-top" aria-hidden="true" data-testid="daybook-virtual-spacer-top">
        <TableCell
          colSpan={hideAmounts ? 4 : 5}
          className="p-0 border-0"
          style={{ height: daybookDesktopWindow.topSpacerHeight }}
        />
      </TableRow>
    );
  }
  let lastDate = "";
  for (const row of desktopRows) {
    const rowDate = row._type === "voucher" ? row.data.voucherDate : row.data.offloadedAt.slice(0, 10);
    if (!offloadAlphabetical && rowDate !== lastDate) {
      const dayRows = visibleRows.filter((r) => {
        const d = r._type === "voucher" ? r.data.voucherDate : r.data.offloadedAt.slice(0, 10);
        return d === rowDate;
      });
      const dayTotal = dayRows.reduce((sum, r) => {
        const amt =
          r._type === "voucher"
            ? parseFloat(String(r.data.totalAmount || "0"))
            : parseFloat(String(r.data.itemsTotal || "0"));
        return sum + amt;
      }, 0);
      tableRows.push(
        <TableRow key={`date-sep-${rowDate}`} className="bg-muted/40 pointer-events-none select-none">
          <TableCell colSpan={hideAmounts ? 4 : 5} className="sticky left-0 bg-inherit z-10 py-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {formatDisplayDate(parseISO(rowDate))}
                <span className="ml-2 font-normal normal-case text-muted-foreground/70">
                  ({dayRows.length} {dayRows.length === 1 ? "entry" : "entries"})
                </span>
              </span>
              {!hideAmounts && (
                <span className="text-xs font-mono font-medium text-muted-foreground">{formatAmount(dayTotal)}</span>
              )}
            </div>
          </TableCell>
        </TableRow>
      );
      lastDate = rowDate;
    }

    if (row._type === "offload") {
      const o = row.data;
      const rid = `offload-${o.id}`;
      tableRows.push(
        <TableRow
          key={rid}
          data-row-id={rid}
          data-testid={`row-offload-${o.id}`}
          className={cn("group cursor-pointer", selectedRowId === rid ? "bg-accent/30" : "hover:bg-muted/40")}
          onClick={() => setSelectedRowId(rid)}
        >
          <TableCell className="font-medium sticky left-0 bg-inherit z-10">
            {formatDisplayDate(parseISO(o.offloadedAt.slice(0, 10)))}
          </TableCell>
          <TableCell>
            <Badge className="bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/30">
              <Package className="w-3 h-3 mr-1" />
              Offload
            </Badge>
          </TableCell>
          <TableCell className="max-w-md truncate">
            {o.containerNumber}
            {o.locationName ? ` — ${o.locationName}` : ""}
          </TableCell>
          {!hideAmounts && (
            <TableCell className="text-right font-mono font-medium">{formatAmount(Number(o.itemsTotal))}</TableCell>
          )}
          <TableCell className="text-right">
            <div className="flex items-center justify-end gap-1 opacity-70 hover:opacity-100 group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity duration-150">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate(`/offloads/${o.id}`)}
                data-testid={`button-view-offload-${o.id}`}
              >
                <Eye className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate(`/containers/${o.containerId}`)}
                data-testid={`button-goto-container-${o.id}`}
              >
                <ExternalLink className="w-4 h-4" />
              </Button>
            </div>
          </TableCell>
        </TableRow>
      );
    } else {
      const voucher = row.data as Voucher;
      const isDvPendingSync = voucher.id < 0;
      const dvid = `voucher-${voucher.id}`;
      const isDvHidden = hiddenRowIds.has(dvid);
      const isExpanded = expandedVoucherId === voucher.id;
      const isLockedType = voucher.voucherType === "Sales" || voucher.voucherType === "Purchase";
      const voucherLocked = isVoucherMutationBlocked(voucher);
      const lockLabel = voucherLockLabel(voucher);
      tableRows.push(
        <TableRow
          key={dvid}
          data-row-id={dvid}
          data-testid={`row-voucher-${voucher.id}`}
          className={cn(
            "group",
            !isDvPendingSync && "cursor-pointer",
            isDvPendingSync && "opacity-75",
            selectedRowId === dvid && "bg-accent/30",
            isDvHidden && showHidden && "opacity-50",
            isExpanded && "bg-accent/20",
            !isDvPendingSync && !isExpanded && selectedRowId !== dvid && "hover:bg-muted/40"
          )}
          onClick={() => {
            if (isDvPendingSync) return;
            setSelectedRowId(dvid);
            setExpandedVoucherId(isExpanded ? null : voucher.id);
          }}
        >
          <TableCell className="font-medium sticky left-0 bg-inherit z-10">
            <div className="flex flex-col">
              <span>{formatDisplayDate(parseISO(voucher.voucherDate))}</span>
              <span className="text-xs text-muted-foreground">{formatDisplayTime(voucher.createdAt)}</span>
            </div>
          </TableCell>
          <TableCell>
            <div className="flex items-center gap-2">
              <Badge {...getVoucherTypeBadge(voucher.voucherType)} data-testid={`badge-type-${voucher.id}`}>
                {voucher.voucherType}
              </Badge>
              {isDvPendingSync && (
                <Badge variant="outline" className="text-xs text-amber-600 dark:text-amber-400 border-amber-400">
                  Pending sync
                </Badge>
              )}
              {voucher.optional && (
                <Badge variant="outline" data-testid={`badge-optional-${voucher.id}`} className="text-xs">
                  Optional
                </Badge>
              )}
              {isDvHidden && (
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  Hidden
                </Badge>
              )}
            </div>
          </TableCell>
          <TableCell className="max-w-md">
            <div className="flex items-center gap-1">
              <ChevronRight
                className={cn("w-3 h-3 text-muted-foreground shrink-0 transition-transform", isExpanded && "rotate-90")}
              />
              <span className="truncate">
                {voucher.description ||
                  (voucher.voucherType === "Payment" ||
                  voucher.voucherType === "Receipt" ||
                  voucher.voucherType === "Journal"
                    ? `${voucher.voucherType}${accountNameCache[voucher.id] ? ` (${accountNameCache[voucher.id]})` : ""}`
                    : "-")}
              </span>
            </div>
          </TableCell>
          {!hideAmounts && (
            <TableCell className="text-right font-mono font-medium">{formatAmount(voucher.totalAmount)}</TableCell>
          )}
          <TableCell className="text-right">
            {isDvPendingSync ? (
              <span className="text-xs text-amber-600 dark:text-amber-400 italic">Pending sync</span>
            ) : (
              <div className="flex items-center justify-end gap-1 opacity-70 hover:opacity-100 group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity duration-150">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleView(voucher);
                  }}
                  data-testid={`button-view-${voucher.id}`}
                  title="View detail"
                >
                  <Eye className="w-4 h-4" />
                </Button>
                {voucherLocked ? (
                  <Button variant="ghost" size="icon" disabled title={`${lockLabel} — cannot be edited`}>
                    <Lock className="w-4 h-4 text-muted-foreground" />
                  </Button>
                ) : isLockedType ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEdit(voucher);
                    }}
                    data-testid={`button-edit-${voucher.id}`}
                    title={`Edit in ${voucher.voucherType === "Sales" ? "Sales" : "Containers"}`}
                  >
                    <Lock className="w-4 h-4 text-muted-foreground" />
                  </Button>
                ) : canEdit(voucher) ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEdit(voucher);
                    }}
                    data-testid={`button-edit-${voucher.id}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isDvHidden) {
                      setHiddenRowIds((prev) => {
                        const next = new Set(prev);
                        next.delete(dvid);
                        return next;
                      });
                    } else {
                      setHiddenRowIds((prev) => {
                        const next = new Set(prev);
                        next.add(dvid);
                        return next;
                      });
                      if (selectedRowId === dvid) setSelectedRowId(null);
                    }
                  }}
                  data-testid={isDvHidden ? `button-unhide-${voucher.id}` : `button-hide-${voucher.id}`}
                  title={isDvHidden ? "Unhide row" : "Hide row"}
                >
                  {isDvHidden ? (
                    <Eye className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <EyeOff className="w-4 h-4 text-muted-foreground" />
                  )}
                </Button>
                {canDelete() && (!voucherLocked || linkedVoucherIds.has(voucher.id)) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(voucher);
                    }}
                    data-testid={`button-delete-${voucher.id}`}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                )}
              </div>
            )}
          </TableCell>
        </TableRow>
      );
      if (isExpanded) {
        tableRows.push(
          <TableRow key={`${dvid}-expand`} className="bg-muted/25">
            <TableCell colSpan={hideAmounts ? 4 : 5} className="p-0">
              <div className="px-8 py-3 border-t border-dashed border-border/60 bg-muted/20">
                {expandedLoading ? (
                  <div className="space-y-1.5">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                ) : expandedEntries.filter((e: ViewVoucherEntry) => !e.isStockItem && !e.stockItemId).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No ledger entries found.</p>
                ) : (
                  <div className="space-y-0.5">
                    {expandedEntries
                      .filter((e: ViewVoucherEntry) => !e.isStockItem && !e.stockItemId)
                      .map((e: ViewVoucherEntry, idx: number) => (
                        <div key={idx} className="flex items-center justify-between text-sm py-0.5">
                          <span className="text-foreground/85 truncate max-w-xs">
                            {e.accountName ||
                              (e as unknown as ViewVoucherEntry & { supplierName: React.ReactNode }).supplierName ||
                              (e as unknown as ViewVoucherEntry & { employeeName: React.ReactNode }).employeeName ||
                              (e as unknown as ViewVoucherEntry & { assetName: React.ReactNode }).assetName ||
                              "—"}
                            {e.narration && (
                              <span className="ml-2 text-xs italic text-muted-foreground">{e.narration}</span>
                            )}
                          </span>
                          <div className="flex items-center gap-4 shrink-0 ml-4">
                            {parseFloat(e.debitAmount || "0") > 0 && !hideAmounts && (
                              <span className="font-mono text-xs font-medium text-emerald-700 dark:text-emerald-300">
                                Dr{" "}
                                {formatTransactionAmount && e.transactionCurrency
                                  ? formatTransactionAmount(
                                      e.transactionDebitAmount || e.debitAmount,
                                      e.transactionCurrency
                                    )
                                  : formatAmount(parseFloat(e.debitAmount))}
                              </span>
                            )}
                            {parseFloat(e.creditAmount || "0") > 0 && !hideAmounts && (
                              <span className="font-mono text-xs font-medium text-rose-700 dark:text-rose-300">
                                Cr{" "}
                                {formatTransactionAmount && e.transactionCurrency
                                  ? formatTransactionAmount(
                                      e.transactionCreditAmount || e.creditAmount,
                                      e.transactionCurrency
                                    )
                                  : formatAmount(parseFloat(e.creditAmount))}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </TableCell>
          </TableRow>
        );
      }
    }
  }

  if (daybookDesktopWindow.bottomSpacerHeight > 0) {
    tableRows.push(
      <TableRow key="daybook-virtual-spacer-bottom" aria-hidden="true" data-testid="daybook-virtual-spacer-bottom">
        <TableCell
          colSpan={hideAmounts ? 4 : 5}
          className="p-0 border-0"
          style={{ height: daybookDesktopWindow.bottomSpacerHeight }}
        />
      </TableRow>
    );
  }

  return { tableRows };
}
