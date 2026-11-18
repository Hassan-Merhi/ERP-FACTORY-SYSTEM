// Extracted from ./DaybookTable.tsx: mobile card items for the detailed Daybook view.
import { Package, Eye, ExternalLink, Lock, Pencil, Trash2 } from "lucide-react";
import { parseISO } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getVoucherTypeBadge } from "@/lib/voucherTypeBadge";
import { cn } from "@/lib/utils";
import { isVoucherMutationBlocked, voucherLockLabel } from "@/lib/migratedVoucherGuard";
import { Voucher } from "./types";
import type { useBoundedTableRows } from "@/hooks/useBoundedTableRows";
import type { DaybookTableProps } from "./daybookTableProps";

export function buildDaybookMobileItems({
  daybookMobileWindow,
  mobileRows,
  offloadAlphabetical,
  visibleRows,
  formatDisplayDate,
  hideAmounts,
  formatAmount,
  navigate,
  hiddenRowIds,
  accountNameCache,
  showHidden,
  handleView,
  handleEdit,
  canEdit,
  canDelete,
  linkedVoucherIds,
  handleDelete,
}: {
  daybookMobileWindow: ReturnType<typeof useBoundedTableRows>;
  mobileRows: DaybookTableProps["displayedRows"];
  offloadAlphabetical: Exclude<DaybookTableProps["offloadAlphabetical"], undefined>;
  visibleRows: DaybookTableProps["visibleRows"];
  formatDisplayDate: DaybookTableProps["formatDisplayDate"];
  hideAmounts: DaybookTableProps["hideAmounts"];
  formatAmount: DaybookTableProps["formatAmount"];
  navigate: DaybookTableProps["navigate"];
  hiddenRowIds: DaybookTableProps["hiddenRowIds"];
  accountNameCache: DaybookTableProps["accountNameCache"];
  showHidden: DaybookTableProps["showHidden"];
  handleView: DaybookTableProps["handleView"];
  handleEdit: DaybookTableProps["handleEdit"];
  canEdit: (v: Voucher) => boolean;
  canDelete: () => boolean;
  linkedVoucherIds: DaybookTableProps["linkedVoucherIds"];
  handleDelete: DaybookTableProps["handleDelete"];
}) {
  // ── Build mobile card items ───────────────────────────────────────────────
  const mobileItems: React.JSX.Element[] = [];
  if (daybookMobileWindow.topSpacerHeight > 0) {
    mobileItems.push(
      <div
        key="daybook-mobile-spacer-top"
        aria-hidden="true"
        data-testid="daybook-mobile-spacer-top"
        style={{ height: daybookMobileWindow.topSpacerHeight }}
      />
    );
  }
  let mobileLastDate = "";
  for (const row of mobileRows) {
    const rowDate = row._type === "voucher" ? row.data.voucherDate : row.data.offloadedAt.slice(0, 10);

    if (!offloadAlphabetical && rowDate !== mobileLastDate) {
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
      mobileItems.push(
        <div
          key={`m-date-${rowDate}`}
          className="sticky top-0 z-10 bg-muted/60 backdrop-blur-xs px-3 py-1.5 flex items-center justify-between border-b"
        >
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {formatDisplayDate(parseISO(rowDate))}
            <span className="ml-1.5 font-normal normal-case opacity-70">
              · {dayRows.length} {dayRows.length === 1 ? "entry" : "entries"}
            </span>
          </span>
          {!hideAmounts && (
            <span className="text-xs font-mono font-medium text-muted-foreground">{formatAmount(dayTotal)}</span>
          )}
        </div>
      );
      mobileLastDate = rowDate;
    }

    if (row._type === "offload") {
      const o = row.data;
      const rid = `offload-${o.id}`;
      mobileItems.push(
        <div
          key={`m-${rid}`}
          data-testid={`row-offload-mobile-${o.id}`}
          className="flex items-center gap-3 px-3 py-2.5 border-b active:bg-muted/30"
        >
          <div className="flex-1 min-w-0">
            <Badge className="bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/30 mb-1">
              <Package className="w-3 h-3 mr-1" />
              Offload
            </Badge>
            <p className="text-sm text-muted-foreground truncate">
              {o.containerNumber}
              {o.locationName ? ` — ${o.locationName}` : ""}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            {!hideAmounts && (
              <span className="font-mono text-sm font-medium">{formatAmount(Number(o.itemsTotal))}</span>
            )}
            <div className="flex gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => navigate(`/offloads/${o.id}`)}
                data-testid={`button-view-offload-mobile-${o.id}`}
              >
                <Eye className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => navigate(`/containers/${o.containerId}`)}
                data-testid={`button-goto-container-mobile-${o.id}`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </div>
      );
    } else {
      const voucher = row.data as Voucher;
      const isDvPendingSync = voucher.id < 0;
      const dvid = `voucher-${voucher.id}`;
      const isDvHidden = hiddenRowIds.has(dvid);
      const isLockedType = voucher.voucherType === "Sales" || voucher.voucherType === "Purchase";
      const voucherLocked = isVoucherMutationBlocked(voucher);
      const lockLabel = voucherLockLabel(voucher);
      const vDesc =
        voucher.description ||
        (["Payment", "Receipt", "Journal"].includes(voucher.voucherType) && accountNameCache[voucher.id]
          ? accountNameCache[voucher.id]
          : null);

      mobileItems.push(
        <div
          key={`m-${dvid}`}
          data-testid={`row-voucher-mobile-${voucher.id}`}
          className={cn(
            "flex items-center gap-3 px-3 py-2.5 border-b",
            isDvHidden && showHidden && "opacity-50",
            isDvPendingSync && "opacity-75"
          )}
        >
          {/* Left: badge + description */}
          <div
            className="flex-1 min-w-0 cursor-pointer"
            onClick={() => {
              if (!isDvPendingSync) handleView(voucher);
            }}
          >
            <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
              <Badge {...getVoucherTypeBadge(voucher.voucherType)}>{voucher.voucherType}</Badge>
              {isDvPendingSync && (
                <Badge variant="outline" className="text-xs text-amber-600 dark:text-amber-400 border-amber-400">
                  Pending
                </Badge>
              )}
              {voucher.optional && (
                <Badge variant="outline" className="text-xs">
                  Optional
                </Badge>
              )}
              {isDvHidden && (
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  Hidden
                </Badge>
              )}
              {voucherLocked && (
                <Badge variant="outline" className="text-xs gap-1">
                  <Lock className="w-3 h-3" /> {lockLabel}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground truncate">{vDesc || voucher.voucherNumber}</p>
          </div>

          {/* Right: amount + actions */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            {!hideAmounts && <span className="font-mono text-sm font-medium">{formatAmount(voucher.totalAmount)}</span>}
            {!isDvPendingSync && (
              <div className="flex gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => handleView(voucher)}
                  data-testid={`button-view-mobile-${voucher.id}`}
                >
                  <Eye className="w-3.5 h-3.5" />
                </Button>
                {voucherLocked ? (
                  <Button variant="ghost" size="icon" className="h-7 w-7" disabled title={lockLabel ?? undefined}>
                    <Lock className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                ) : isLockedType ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => handleEdit(voucher)}
                    data-testid={`button-edit-mobile-${voucher.id}`}
                  >
                    <Lock className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                ) : canEdit(voucher) ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => handleEdit(voucher)}
                    data-testid={`button-edit-mobile-${voucher.id}`}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                ) : null}
                {canDelete() && (!voucherLocked || linkedVoucherIds.has(voucher.id)) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => handleDelete(voucher)}
                    data-testid={`button-delete-mobile-${voucher.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }
  }

  if (daybookMobileWindow.bottomSpacerHeight > 0) {
    mobileItems.push(
      <div
        key="daybook-mobile-spacer-bottom"
        aria-hidden="true"
        data-testid="daybook-mobile-spacer-bottom"
        style={{ height: daybookMobileWindow.bottomSpacerHeight }}
      />
    );
  }

  return { mobileItems };
}
