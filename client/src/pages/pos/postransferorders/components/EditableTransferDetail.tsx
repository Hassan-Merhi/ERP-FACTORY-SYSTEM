import type { ClientErrorLike } from "@/lib/clientError";
/**
 * EditableTransferDetail — extracted sub-component.
 *
 * Extracted from PosTransferOrders.tsx during the Phase 4 god-file split.
 */
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Save, CheckCircle2, X, ArrowRight, Clock, Lock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

import type { ExtraItem, InventoryItem, PosUser, TransferDetail } from "../types";
import { fmtQty, formatDate, formatDateTime } from "../utils";
import { ItemSearchPanel } from "./ItemSearchPanel";

export // ─── Editable detail view ─────────────────────────────────────────────────────
function EditableTransferDetail({
  detail,
  posUser,
  voucherId,
  onBack,
}: {
  detail: TransferDetail;
  posUser: PosUser;
  voucherId: number;
  onBack: () => void;
}) {
  const { toast } = useToast();

  // Pre-populate from any existing pending revision (so user sees their prior adjustments)
  const [deltas, setDeltas] = useState<Record<number, string>>(() => {
    const pending = detail.revisions.find((r) => r.optional);
    if (!pending) return {};
    const stockItemToId = new Map(detail.items.map((i) => [i.stockItemId, i.id]));
    const init: Record<number, string> = {};
    for (const ri of pending.items) {
      const transferItemId = stockItemToId.get(ri.stockItemId);
      if (transferItemId !== undefined && parseFloat(ri.originalQuantity) > 0) {
        const d = parseFloat(ri.delta);
        if (d !== 0) init[transferItemId] = String(d);
      }
    }
    return init;
  });

  const [extraItems, setExtraItems] = useState<ExtraItem[]>(() => {
    const pending = detail.revisions.find((r) => r.optional);
    if (!pending) return [];
    const baseIds = new Set(detail.items.map((i) => i.stockItemId));
    return pending.items
      .filter((ri) => !baseIds.has(ri.stockItemId) || parseFloat(ri.originalQuantity) === 0)
      .filter((ri) => parseFloat(ri.newQuantity) > 0)
      .map((ri) => ({
        stockItemId: ri.stockItemId,
        stockItemName: ri.stockItemName,
        qtyDraft: fmtQty(ri.newQuantity),
      }));
  });

  const [note, setNote] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelSearch, setPanelSearch] = useState("");
  const [panelActiveIdx, setPanelActiveIdx] = useState(0);
  const searchBarRef = useRef<HTMLInputElement>(null);
  const deltaRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Use the transfer's source location for inventory lookup so multi-location users
  // only see items from the location this transfer is sending FROM.
  const inventoryLocationId = detail.sourceLocationId ?? posUser.assignedLocationId;
  const { data: rawInventory = [] } = useQuery<InventoryItem[]>({
    queryKey: ["/api/inventory", inventoryLocationId],
    queryFn: async () => {
      if (!inventoryLocationId) return [];
      const res = await fetch(`/api/locations/${inventoryLocationId}/inventory`, { credentials: "include" });
      return res.ok ? res.json() : [];
    },
    enabled: !!inventoryLocationId,
  });

  const revisionMutation = useMutation({
    mutationFn: async (payload: { transferId: number; note: string; items: Record<string, unknown>[] }) => {
      return apiRequest("POST", `/api/stock-transfers/${payload.transferId}/revisions`, {
        note: payload.note,
        items: payload.items,
        optional: true,
      });
    },
    onSuccess: () => {
      toast({ title: "Revision saved", description: "Adjustments submitted for admin review." });
      queryClient.invalidateQueries({ queryKey: ["/api/pos-transfer-detail", voucherId] });
      setNote("");
      onBack();
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const getDeltaNum = (id: number) => {
    const v = (deltas[id] ?? "").trim();
    if (!v || v === "-" || v === "+") return 0;
    return parseFloat(v) || 0;
  };
  const setDeltaVal = (id: number, v: string) => setDeltas((p) => ({ ...p, [id]: v }));
  const normalizeDelta = (id: number) => {
    const v = (deltas[id] ?? "").trim();
    if (!v || v === "-" || v === "+") {
      setDeltaVal(id, "");
      return;
    }
    const n = parseFloat(v) || 0;
    setDeltaVal(id, n === 0 ? "" : String(n));
  };

  const myItems = detail.items;
  const locationInventory = rawInventory.flatMap((i) => {
    const stockItemId = i.stockItemId ?? i.id;
    if (stockItemId == null) return [];
    return [
      {
        stockItemId,
        name: i.stockItemName ?? i.name ?? "",
        quantity: String(i.quantity ?? "0"),
      },
    ];
  });

  const alreadyAddedIds = useMemo(
    () => new Set([...extraItems.map((e) => e.stockItemId), ...myItems.map((i) => i.stockItemId)]),
    [extraItems, myItems]
  );

  const panelMatches = useMemo(
    () =>
      locationInventory.filter(
        (i) => !alreadyAddedIds.has(i.stockItemId) && i.name.toLowerCase().includes(panelSearch.toLowerCase())
      ),
    [locationInventory, alreadyAddedIds, panelSearch]
  );

  useEffect(() => {
    setPanelActiveIdx(0);
  }, [panelSearch]);

  const addExtraItem = (inv: { stockItemId: number; name: string }) => {
    setExtraItems((p) => [...p, { stockItemId: inv.stockItemId, stockItemName: inv.name, qtyDraft: "" }]);
    setPanelSearch("");
    // focus the new extra item's adjustment input after render
    setTimeout(() => {
      deltaRefs.current[`extra-${inv.stockItemId}`]?.focus();
    }, 50);
  };

  const openPanel = () => {
    setPanelOpen(true);
    setTimeout(() => searchBarRef.current?.focus(), 30);
  };

  const updateExtraQty = (idx: number, val: string) =>
    setExtraItems((p) => p.map((it, i) => (i === idx ? { ...it, qtyDraft: val } : it)));
  const removeExtra = (idx: number) => setExtraItems((p) => p.filter((_, i) => i !== idx));

  // Ordered list of all delta input keys for keyboard navigation
  const getAllInputKeys = useCallback(
    () => [...myItems.map((i) => `base-${i.id}`), ...extraItems.map((e) => `extra-${e.stockItemId}`)],
    [myItems, extraItems]
  );

  const focusRelative = useCallback(
    (currentKey: string, direction: 1 | -1) => {
      const keys = getAllInputKeys();
      const idx = keys.indexOf(currentKey);
      if (idx === -1) return;
      const next = idx + direction;
      if (next >= 0 && next < keys.length) {
        const el = deltaRefs.current[keys[next]];
        el?.focus();
        el?.select();
      } else if (direction === 1) {
        searchBarRef.current?.focus();
      }
    },
    [getAllInputKeys]
  );

  const handleSave = () => {
    // Only send items whose delta is non-zero (supports both + and - adjustments)
    const changedBaseItems = myItems
      .map((item) => {
        const delta = getDeltaNum(item.id);
        const original = parseFloat(item.quantity) || 0;
        return {
          stockItemId: item.stockItemId,
          stockItemName: item.stockItemName,
          sourceLocationId: item.sourceLocationId ?? detail.sourceLocationId,
          sourceLocationName: item.sourceLocationName ?? detail.sourceLocationName,
          originalQuantity: item.quantity,
          delta: String(delta),
          newQuantity: String(original + delta),
        };
      })
      .filter((item) => parseFloat(item.delta) !== 0);

    const myLocationName = myItems[0]?.sourceLocationName ?? detail.sourceLocationName;
    const newItems = extraItems
      .map((e) => ({ ...e, qty: parseFloat(e.qtyDraft) || 0 }))
      .filter((e) => e.qty !== 0)
      .map((e) => ({
        stockItemId: e.stockItemId,
        stockItemName: e.stockItemName,
        sourceLocationId: posUser.assignedLocationId,
        sourceLocationName: myLocationName,
        originalQuantity: "0",
        delta: String(e.qty),
        newQuantity: String(e.qty),
      }));

    const allItems = [...changedBaseItems, ...newItems];
    if (allItems.length === 0) {
      toast({ title: "No changes", description: "Adjust at least one item quantity.", variant: "destructive" });
      return;
    }
    revisionMutation.mutate({ transferId: detail.transferId, note, items: allItems });
  };

  const hasChanges =
    myItems.some((i) => getDeltaNum(i.id) !== 0) || extraItems.some((e) => (parseFloat(e.qtyDraft) || 0) !== 0);

  const totalItems = myItems.length + extraItems.length;

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-to-list">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">{formatDate(detail.voucherDate)}</span>
            {detail.inventoryApplied && (
              <Badge
                variant="secondary"
                className="text-xs gap-1 text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30"
              >
                <Lock className="h-3 w-3" />
                Applied
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-sm text-muted-foreground">{detail.sourceLocationName}</span>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
            <span className="text-sm font-semibold">{detail.destinationLocationName}</span>
          </div>
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: scrollable content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Table */}
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
                        "w-full text-center text-sm border rounded-md bg-background px-1 py-1.5 font-mono outline-none focus:ring-2 focus:ring-primary/40 transition-shadow",
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
                  <span className="text-xs text-muted-foreground tabular-nums font-mono">
                    {myItems.length + idx + 1}
                  </span>

                  <div className="flex items-center gap-1 min-w-0">
                    <span className="text-sm font-medium truncate flex-1" title={item.stockItemName}>
                      {item.stockItemName}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeExtra(idx)}
                      className="sm:hidden shrink-0 h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-destructive transition-colors"
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
                      className="w-full text-center text-sm border border-primary/40 rounded-md bg-primary/5 px-1 py-1.5 font-mono outline-none focus:ring-2 focus:ring-primary/40 transition-shadow"
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
                    className="hidden sm:flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-destructive transition-colors"
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
                className="flex-1 text-sm bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
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

          {/* Notes + Save */}
          <div className="flex flex-col sm:flex-row gap-3 items-start">
            <Textarea
              placeholder="Notes (optional)..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="resize-none text-sm flex-1"
              data-testid="textarea-revision-note"
            />
            <Button
              type="button"
              onClick={handleSave}
              disabled={!hasChanges || revisionMutation.isPending}
              className="w-full sm:w-auto shrink-0"
              data-testid="button-save-revision"
            >
              {revisionMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-1.5" />
                  Save Revision
                </>
              )}
            </Button>
          </div>

          {/* Revision history */}
          {(detail.revisions?.length ?? 0) > 0 && (
            <div className="space-y-2 pb-4">
              <div className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Revision History
                </span>
              </div>
              {detail.revisions.map((rev) => {
                const revLocName = rev.items[0]?.sourceLocationName ?? null;
                return (
                  <Card key={rev.id} data-testid={`card-revision-${rev.id}`}>
                    <CardContent className="pt-3 pb-3 space-y-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold">Revision #{rev.revisionNumber}</span>
                          {revLocName && (
                            <span className="text-xs text-muted-foreground">
                              · From: <span className="font-medium text-foreground">{revLocName}</span>
                            </span>
                          )}
                          <span className="text-xs text-muted-foreground">{formatDateTime(rev.createdAt)}</span>
                        </div>
                        {rev.optional ? (
                          <Badge variant="outline" className="text-xs" data-testid={`badge-pending-${rev.id}`}>
                            Pending Admin Review
                          </Badge>
                        ) : (
                          <Badge variant="default" className="text-xs" data-testid={`badge-approved-${rev.id}`}>
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Approved
                          </Badge>
                        )}
                      </div>
                      {rev.note && <p className="text-xs text-muted-foreground italic">{rev.note}</p>}
                      <div className="rounded-md border overflow-hidden">
                        <div className="grid grid-cols-[1fr_auto_auto_auto] bg-muted/30 border-b px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide gap-x-4">
                          <span>Item</span>
                          <span className="text-right">Was</span>
                          <span className="text-right">Now</span>
                          <span className="text-right">Change</span>
                        </div>
                        {rev.items
                          .filter((ri) => parseFloat(ri.delta) !== 0)
                          .map((ri, i) => {
                            const delta = parseFloat(ri.delta);
                            return (
                              <div
                                key={i}
                                className="grid grid-cols-[1fr_auto_auto_auto] items-center px-3 py-2 text-xs gap-x-4 bg-card border-b last:border-b-0"
                                data-testid={`text-rev-item-${rev.id}-${i}`}
                              >
                                <span className="font-medium">{ri.stockItemName}</span>
                                <span className="font-mono text-right text-muted-foreground">
                                  {fmtQty(ri.originalQuantity)}
                                </span>
                                <span className="font-mono font-semibold text-right">{fmtQty(ri.newQuantity)}</span>
                                <span
                                  className={cn(
                                    "font-mono font-semibold text-right",
                                    delta > 0 ? "text-green-600 dark:text-green-400" : "text-destructive"
                                  )}
                                >
                                  {delta > 0 ? "+" : ""}
                                  {fmtQty(ri.delta)}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Spacer: reserves room for the fixed panel on desktop so content doesn't slide under it */}
        {panelOpen && <div className="hidden sm:block w-64 shrink-0" />}
      </div>

      {/* Fixed item-search panel — right panel on sm+, bottom sheet on mobile */}
      {panelOpen && (
        <>
          {/* Desktop: fixed right panel */}
          <div className="hidden sm:flex fixed right-0 top-12 bottom-0 w-64 z-30 bg-card border-l flex-col shadow-md overflow-hidden">
            <ItemSearchPanel
              matches={panelMatches}
              activeIdx={panelActiveIdx}
              locationName={detail.sourceLocationName}
              onActiveChange={setPanelActiveIdx}
              onPick={addExtraItem}
              onClose={() => {
                setPanelOpen(false);
                setPanelSearch("");
              }}
            />
          </div>
          {/* Mobile: bottom sheet */}
          <div
            className="sm:hidden fixed inset-x-0 bottom-0 z-40 bg-card border-t flex flex-col shadow-lg"
            style={{ height: "55vh" }}
          >
            <ItemSearchPanel
              matches={panelMatches}
              activeIdx={panelActiveIdx}
              locationName={detail.sourceLocationName}
              onActiveChange={setPanelActiveIdx}
              onPick={addExtraItem}
              onClose={() => {
                setPanelOpen(false);
                setPanelSearch("");
              }}
            />
          </div>
          {/* Mobile backdrop */}
          <div
            className="sm:hidden fixed inset-0 z-30 bg-black/30"
            onClick={() => {
              setPanelOpen(false);
              setPanelSearch("");
            }}
          />
        </>
      )}
    </div>
  );
}

// ─── Detail shell ─────────────────────────────────────────────────────────────
