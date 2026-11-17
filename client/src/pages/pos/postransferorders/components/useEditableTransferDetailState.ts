// Extracted from ./EditableTransferDetail.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ExtraItem, InventoryItem, PosUser, TransferDetail } from "../types";
import { fmtQty } from "../utils";

export function useEditableTransferDetailState({
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
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
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
  const locationInventory = rawInventory.flatMap((item) => {
    const stockItemId = item.stockItemId ?? item.id;
    if (stockItemId === undefined) return [];
    return [
      {
        stockItemId,
        name: item.stockItemName ?? item.name ?? "",
        quantity: String(item.quantity ?? "0"),
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
  return {
    addExtraItem,
    deltaRefs,
    deltas,
    detail,
    extraItems,
    focusRelative,
    getDeltaNum,
    handleSave,
    hasChanges,
    myItems,
    normalizeDelta,
    note,
    onBack,
    openPanel,
    panelActiveIdx,
    panelMatches,
    panelOpen,
    panelSearch,
    removeExtra,
    revisionMutation,
    searchBarRef,
    setDeltaVal,
    setNote,
    setPanelActiveIdx,
    setPanelOpen,
    setPanelSearch,
    totalItems,
    updateExtraQty,
  };
}
