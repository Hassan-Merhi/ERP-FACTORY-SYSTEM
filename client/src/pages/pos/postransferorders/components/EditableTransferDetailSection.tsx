// Extracted from ./EditableTransferDetail.tsx to keep that module under the source-size cap.
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtQty } from "../utils";
import { useEditableTransferDetailState } from "./useEditableTransferDetailState";

// ─── Detail shell ─────────────────────────────────────────────────────────────

export function EditableTransferDetailSection({
  addExtraItem,
  deltaRefs,
  deltas,
  extraItems,
  focusRelative,
  getDeltaNum,
  hasChanges,
  myItems,
  normalizeDelta,
  openPanel,
  panelActiveIdx,
  panelMatches,
  panelOpen,
  panelSearch,
  removeExtra,
  searchBarRef,
  setDeltaVal,
  setPanelActiveIdx,
  setPanelOpen,
  setPanelSearch,
  totalItems,
  updateExtraQty,
}: Pick<
  ReturnType<typeof useEditableTransferDetailState>,
  | "addExtraItem"
  | "deltaRefs"
  | "deltas"
  | "extraItems"
  | "focusRelative"
  | "getDeltaNum"
  | "hasChanges"
  | "myItems"
  | "normalizeDelta"
  | "openPanel"
  | "panelActiveIdx"
  | "panelMatches"
  | "panelOpen"
  | "panelSearch"
  | "removeExtra"
  | "searchBarRef"
  | "setDeltaVal"
  | "setPanelActiveIdx"
  | "setPanelOpen"
  | "setPanelSearch"
  | "totalItems"
  | "updateExtraQty"
>) {
  return (
    <div className="border rounded-md overflow-hidden">
      {/* Column header */}
      <div className="grid grid-cols-[2rem_1fr_5rem_5rem] sm:grid-cols-[2rem_1fr_5.5rem_6.5rem_6rem_2rem] bg-muted/60 border-b px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider gap-2">
        <span>#</span>
        <span>Item</span>
        <span className="hidden sm:block text-right">Original</span>
        <span className="text-center">Adj</span>
        <span className="text-right">New Qty</span>
        <span className="hidden sm:block" />
      </div>

      {/* Existing items */}
      {myItems.map((item, idx) => {
        const deltaNum = getDeltaNum(item.id);
        const original = parseFloat(item.quantity) || 0;
        const newQty = original + deltaNum;
        const changed = deltaNum !== 0;
        return (
          <div
            key={item.id}
            className={cn(
              "grid grid-cols-[2rem_1fr_5rem_5rem] sm:grid-cols-[2rem_1fr_5.5rem_6.5rem_6rem_2rem] items-center px-3 py-2.5 gap-2 border-b last:border-b-0",
              changed ? "bg-primary/5 border-l-2 border-l-primary" : "border-l-2 border-l-transparent"
            )}
            data-testid={`row-item-${item.id}`}
          >
            <span className="text-xs text-muted-foreground tabular-nums font-mono">{idx + 1}</span>

            <button
              type="button"
              onClick={() => openPanel()}
              className="text-sm font-medium text-left truncate hover:text-primary transition-colors"
              title={item.stockItemName}
              data-testid={`button-item-name-${item.id}`}
            >
              {item.stockItemName}
            </button>

            <span className="hidden sm:block text-sm font-mono text-right tabular-nums text-muted-foreground">
              {fmtQty(original)}
            </span>

            <div className="flex justify-center">
              <input
                ref={(el) => {
                  deltaRefs.current[`base-${item.id}`] = el;
                }}
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={deltas[item.id] ?? ""}
                onChange={(e) => setDeltaVal(item.id, e.target.value)}
                onBlur={() => normalizeDelta(item.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey) || e.key === "ArrowDown") {
                    e.preventDefault();
                    normalizeDelta(item.id);
                    focusRelative(`base-${item.id}`, 1);
                  } else if ((e.key === "Tab" && e.shiftKey) || e.key === "ArrowUp") {
                    e.preventDefault();
                    normalizeDelta(item.id);
                    focusRelative(`base-${item.id}`, -1);
                  }
                }}
                className={cn(
                  "w-full text-center text-sm border rounded-md bg-background px-1 py-1.5 font-mono outline-hidden focus:ring-2 focus:ring-primary/40 transition-shadow",
                  changed && "border-primary/40 bg-primary/5"
                )}
                data-testid={`input-delta-${item.id}`}
              />
            </div>

            <span
              className={cn(
                "font-mono font-bold text-right tabular-nums",
                changed
                  ? deltaNum > 0
                    ? "text-base text-green-600 dark:text-green-400"
                    : "text-base text-destructive"
                  : "text-sm"
              )}
            >
              {fmtQty(newQty)}
            </span>

            <div className="hidden sm:block" />
          </div>
        );
      })}

      {/* Extra (newly added) items */}
      {extraItems.map((item, idx) => {
        const qty = parseFloat(item.qtyDraft) || 0;
        return (
          <div
            key={`extra-${item.stockItemId}`}
            className="grid grid-cols-[2rem_1fr_5rem_5rem] sm:grid-cols-[2rem_1fr_5.5rem_6.5rem_6rem_2rem] items-center px-3 py-2.5 gap-2 border-b last:border-b-0 bg-primary/5 border-l-2 border-l-primary"
            data-testid={`row-extra-${item.stockItemId}`}
          >
            <span className="text-xs text-muted-foreground tabular-nums font-mono">{myItems.length + idx + 1}</span>

            <div className="flex items-center gap-1 min-w-0">
              <span className="text-sm font-medium truncate flex-1" title={item.stockItemName}>
                {item.stockItemName}
              </span>
              <button
                type="button"
                onClick={() => removeExtra(idx)}
                className="sm:hidden shrink-0 h-5 w-5 flex items-center justify-center rounded-sm text-muted-foreground hover:text-destructive transition-colors"
                data-testid={`button-remove-extra-mobile-${item.stockItemId}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>

            <span className="hidden sm:block text-sm font-mono text-right text-muted-foreground">—</span>

            <div className="flex justify-center">
              <input
                ref={(el) => {
                  deltaRefs.current[`extra-${item.stockItemId}`] = el;
                }}
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={item.qtyDraft}
                onChange={(e) => updateExtraQty(idx, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey) || e.key === "ArrowDown") {
                    e.preventDefault();
                    focusRelative(`extra-${item.stockItemId}`, 1);
                  } else if ((e.key === "Tab" && e.shiftKey) || e.key === "ArrowUp") {
                    e.preventDefault();
                    focusRelative(`extra-${item.stockItemId}`, -1);
                  }
                }}
                className="w-full text-center text-sm border border-primary/40 rounded-md bg-primary/5 px-1 py-1.5 font-mono outline-hidden focus:ring-2 focus:ring-primary/40 transition-shadow"
                data-testid={`input-extra-qty-${item.stockItemId}`}
              />
            </div>

            <span
              className={cn(
                "font-mono font-bold text-right tabular-nums",
                qty > 0 ? "text-base text-green-600 dark:text-green-400" : "text-sm text-muted-foreground"
              )}
            >
              {qty > 0 ? fmtQty(qty) : "—"}
            </span>

            <button
              type="button"
              onClick={() => removeExtra(idx)}
              className="hidden sm:flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:text-destructive transition-colors"
              data-testid={`button-remove-extra-${item.stockItemId}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      {/* Search-to-add bar */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-t bg-muted/20">
        <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={searchBarRef}
          type="text"
          placeholder="Add item by searching…"
          value={panelSearch}
          onChange={(e) => {
            setPanelSearch(e.target.value);
            if (!panelOpen) setPanelOpen(true);
          }}
          onFocus={() => {
            if (!panelOpen) setPanelOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setPanelActiveIdx((i) => Math.min(i + 1, panelMatches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setPanelActiveIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (panelMatches[panelActiveIdx]) addExtraItem(panelMatches[panelActiveIdx]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setPanelOpen(false);
              setPanelSearch("");
            } else if (e.key === "Tab") {
              setPanelOpen(false);
              setPanelSearch("");
            }
          }}
          className="flex-1 text-sm bg-transparent outline-hidden text-foreground placeholder:text-muted-foreground"
          data-testid="input-search-bar"
          autoComplete="off"
        />
        {panelSearch && (
          <button
            type="button"
            onClick={() => {
              setPanelSearch("");
              searchBarRef.current?.focus();
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Footer */}
      <div className="border-t px-3 py-2 bg-muted/30 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {totalItems} {totalItems === 1 ? "item" : "items"} total
        </span>
        {hasChanges && <span className="text-primary font-medium">Unsaved changes</span>}
      </div>
    </div>
  );
}
