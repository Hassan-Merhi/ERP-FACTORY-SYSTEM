// Extracted from ./FactorySheetsAndSacks.tsx to keep that module under the source-size cap.
import { downloadBlob } from "@/lib/downloadBlob";
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import type { SheetsAndSacksItem } from "./factorysheetsandsacks/types";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

// Presentation preferences only. The data model, financial calculations, and stock APIs are unchanged.
export const OPTIONAL_COLUMNS = [
  { key: "type", label: "Type" },
  { key: "size", label: "Size / Weight" },
  { key: "packs", label: "Qty (packs)" },
  { key: "perPack", label: "# / Pack" },
  { key: "pieces", label: "Total Pcs" },
  { key: "price", label: "Price / Pc" },
  { key: "value", label: "Total Value" },
  { key: "notes", label: "Notes" },
] as const;

type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number]["key"];

const COLUMN_STORAGE_KEY = "factory:sheets-sacks:visible-columns:v1";

function csvCell(value: string | number | null | undefined) {
  const text = String(value ?? "");
  // Do not let user-controlled names or notes become spreadsheet formulas.
  const safe = /^[=+@\t\r]/.test(text) || /^-\D/.test(text) ? "'" + text : text;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function useFactorySheetsAndSacksState() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"stock" | "movements">("stock");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editItem, setEditItem] = useState<SheetsAndSacksItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<SheetsAndSacksItem | null>(null);
  const [deductItem, setDeductItem] = useState<SheetsAndSacksItem | null>(null);
  const [restockItem, setRestockItem] = useState<SheetsAndSacksItem | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [hiddenColumns, setHiddenColumns] = useState<OptionalColumn[]>(() => {
    try {
      const raw = window.localStorage.getItem(COLUMN_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? OPTIONAL_COLUMNS.filter((col) => parsed.includes(col.key)).map((col) => col.key)
        : [];
    } catch {
      return [];
    }
  });
  const columnVisible = (key: OptionalColumn) => !hiddenColumns.includes(key);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(hiddenColumns));
    } catch {
      // Storage can be unavailable in private browsing; the current view still works.
    }
  }, [hiddenColumns]);

  const { data: items = [], isLoading } = useQuery<SheetsAndSacksItem[]>({
    queryKey: companyQueryKey("/api/factory/sheets-sacks", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 30000,
  });

  const accessReady = myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true;
  const recordChanges = useExistingRecordChangeAccess();
  // View Only and Create Only never add, edit, deduct, restock or delete stock items:
  // new items are not a verified Create Only signature. The server refuses them too.
  const canEdit = Boolean(
    recordChanges.allowed &&
    accessReady &&
    (myAccess?.fullAccess || myAccess?.pageKeys.includes("factory/sheets-sacks"))
  );
  const hiddenTabs =
    accessReady && myAccess ? myAccess.hiddenCostFields : ["hide_tab_sheets_stock", "hide_tab_sheets_movements"];
  const showStock = !hiddenTabs.includes("hide_tab_sheets_stock");
  const showMovements = !hiddenTabs.includes("hide_tab_sheets_movements");
  const effectiveTab =
    activeTab === "stock" && showStock
      ? "stock"
      : activeTab === "movements" && showMovements
        ? "movements"
        : showStock
          ? "stock"
          : showMovements
            ? "movements"
            : null;

  useEffect(() => {
    if (effectiveTab && activeTab !== effectiveTab) setActiveTab(effectiveTab);
  }, [activeTab, effectiveTab]);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/factory/sheets-sacks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/sheets-sacks"] });
      toast({ title: "Item deleted" });
      setDeleteItem(null);
    },
    onError: (e: ClientErrorLike) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const filtered = useMemo(() => {
    let result = items;
    if (typeFilter !== "all") result = result.filter((i) => i.type === typeFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.size || "").toLowerCase().includes(q) ||
          (i.notes || "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [items, typeFilter, search]);

  const stats = useMemo(() => {
    const sheets = items.filter((i) => i.type === "Sheet");
    const sacks = items.filter((i) => i.type === "Sack");
    const totalValue = items.reduce((s, i) => s + parseFloat(i.quantity || "0") * parseFloat(i.unitPrice || "0"), 0);
    const sheetValue = sheets.reduce((s, i) => s + parseFloat(i.quantity || "0") * parseFloat(i.unitPrice || "0"), 0);
    const sackValue = sacks.reduce((s, i) => s + parseFloat(i.quantity || "0") * parseFloat(i.unitPrice || "0"), 0);
    return { sheets: sheets.length, sacks: sacks.length, totalValue, sheetValue, sackValue };
  }, [items]);

  // Column totals for the filtered view
  const colTotals = useMemo(() => {
    let packQty = 0,
      pcs = 0,
      value = 0;
    for (const i of filtered) {
      if (i.packQty != null) packQty += i.packQty;
      pcs += parseFloat(i.quantity || "0");
      value += parseFloat(i.quantity || "0") * parseFloat(i.unitPrice || "0");
    }
    return { packQty, pcs, value };
  }, [filtered]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((i) => selectedIds.includes(i.id));
  const someVisibleSelected = filtered.some((i) => selectedIds.includes(i.id));
  const selectedVisibleCount = filtered.filter((i) => selectedIds.includes(i.id)).length;

  const toggleVisibleSelection = (checked: boolean) => {
    const visibleIds = new Set(filtered.map((i) => i.id));
    setSelectedIds((ids) =>
      checked ? [...new Set([...ids, ...visibleIds])] : ids.filter((id) => !visibleIds.has(id))
    );
  };

  const exportStock = () => {
    const selected = filtered.filter((item) => selectedIds.includes(item.id));
    const rows = selected.length ? selected : filtered;
    const columns: Array<{ key: string; label: string; value: (item: SheetsAndSacksItem) => string | number | null }> =
      [
        { key: "name", label: "Name", value: (item) => item.name },
        { key: "type", label: "Type", value: (item) => item.type },
        { key: "size", label: "Size / Weight", value: (item) => item.size },
        { key: "packs", label: "Qty (packs)", value: (item) => item.packQty },
        { key: "perPack", label: "# / Pack", value: (item) => item.pcsPerPack },
        { key: "pieces", label: "Total Pcs", value: (item) => item.quantity },
        { key: "price", label: "Price / Pc", value: (item) => item.unitPrice },
        {
          key: "value",
          label: "Total Value",
          value: (item) => Number(item.quantity || 0) * Number(item.unitPrice || 0),
        },
        { key: "notes", label: "Notes", value: (item) => item.notes },
      ];
    const shown = columns.filter((column) => column.key === "name" || columnVisible(column.key as OptionalColumn));
    const csv = [
      shown.map((column) => csvCell(column.label)).join(","),
      ...rows.map((item) => shown.map((column) => csvCell(column.value(item))).join(",")),
    ].join("\r\n");
    downloadBlob(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }), "sheets-sacks-stock.csv");
  };

  const typeBadge = (type: string) => (
    <Badge
      variant="secondary"
      className={
        type === "Sheet"
          ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
          : type === "Sack"
            ? "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
            : "bg-muted text-muted-foreground"
      }
    >
      {type}
    </Badge>
  );
  return {
    allVisibleSelected,
    canEdit,
    colTotals,
    columnVisible,
    deductItem,
    deleteItem,
    deleteMutation,
    editItem,
    effectiveTab,
    exportStock,
    filtered,
    isLoading,
    items,
    restockItem,
    search,
    selectedIds,
    selectedVisibleCount,
    setActiveTab,
    setDeductItem,
    setDeleteItem,
    setEditItem,
    setHiddenColumns,
    setRestockItem,
    setSearch,
    setSelectedIds,
    setShowAddDialog,
    setTypeFilter,
    showAddDialog,
    showMovements,
    showStock,
    someVisibleSelected,
    stats,
    toggleVisibleSelection,
    typeBadge,
    typeFilter,
  };
}
