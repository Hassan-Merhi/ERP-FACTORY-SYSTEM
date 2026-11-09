import { downloadBlob } from "@/lib/downloadBlob";
import { TabsList, PillTabButton } from "@/components/ui/tabs";
import type { ClientErrorLike } from "@/lib/clientError";
import { Suspense, useState, useMemo, useEffect } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Layers,
  Plus,
  Pencil,
  Trash2,
  Search,
  Loader2,
  Package,
  ShoppingBag,
  MinusCircle,
  PlusCircle,
  History,
  Columns3,
  Download,
  Printer,
  RefreshCw,
  Warehouse,
  Wallet,
  Check,
} from "lucide-react";

import type { SheetsAndSacksItem } from "./factorysheetsandsacks/types";
import { TYPES, fmt, fmtInt } from "./factorysheetsandsacks/utils";
// Optional workflows should not extend the initial stock tab's JavaScript load.
const ItemFormDialog = lazy(() =>
  import("./factorysheetsandsacks/components/ItemFormDialog").then((module) => ({ default: module.ItemFormDialog }))
);
const DeductDialog = lazy(() =>
  import("./factorysheetsandsacks/components/DeductDialog").then((module) => ({ default: module.DeductDialog }))
);
const RestockDialog = lazy(() =>
  import("./factorysheetsandsacks/components/RestockDialog").then((module) => ({ default: module.RestockDialog }))
);
const MovementLog = lazy(() =>
  import("./factorysheetsandsacks/components/MovementLog").then((module) => ({ default: module.MovementLog }))
);
// Presentation preferences only. The data model, financial calculations, and stock APIs are unchanged.
const OPTIONAL_COLUMNS = [
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

export default function FactorySheetsAndSacks() {
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

  const accessReady = myAccess?.companyId === selectedCompany?.id && myAccess.hasFactoryAccess;
  const canEdit = Boolean(accessReady && (myAccess.fullAccess || myAccess.pageKeys.includes("factory/sheets-sacks")));
  const hiddenTabs = accessReady ? myAccess.hiddenCostFields : ["hide_tab_sheets_stock", "hide_tab_sheets_movements"];
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
    const columns: Array<{ key: string; label: string; value: (item: SheetsAndSacksItem) => string | number | null }> = [
      { key: "name", label: "Name", value: (item) => item.name },
      { key: "type", label: "Type", value: (item) => item.type },
      { key: "size", label: "Size / Weight", value: (item) => item.size },
      { key: "packs", label: "Qty (packs)", value: (item) => item.packQty },
      { key: "perPack", label: "# / Pack", value: (item) => item.pcsPerPack },
      { key: "pieces", label: "Total Pcs", value: (item) => item.quantity },
      { key: "price", label: "Price / Pc", value: (item) => item.unitPrice },
      { key: "value", label: "Total Value", value: (item) => Number(item.quantity || 0) * Number(item.unitPrice || 0) },
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

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Visual refresh: existing stock KPIs, permissions and mutations stay unchanged. */}
      <div className="relative isolate overflow-hidden rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100 px-5 py-6 shadow-sm dark:border-indigo-400/20 dark:from-blue-950 dark:via-blue-900 dark:to-blue-800 sm:px-7">
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-blue-400/20 blur-3xl dark:bg-blue-500/20" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-36 right-20 h-64 w-96 rounded-full bg-violet-400/20 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-lg shadow-indigo-600/20">
              <Layers className="h-7 w-7" />
            </div>
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.17em] text-indigo-600 dark:text-indigo-300">
                <Warehouse className="h-3.5 w-3.5" /> Packaging inventory
              </p>
              <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white sm:text-3xl">Sheets &amp; Sacks</h1>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Track packaging materials inventory</p>
            </div>
          </div>
          {canEdit && showStock && (
            <Button onClick={() => setShowAddDialog(true)} data-testid="button-add-item" className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-5 font-semibold text-white shadow-md shadow-indigo-600/20 hover:from-blue-700 hover:to-indigo-700">
              <Plus className="mr-2 h-4 w-4" /> Add Item
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          { label: "Total Sheets", value: stats.sheets.toLocaleString(), detail: `$${fmt(stats.sheetValue)} value`, icon: Layers, colors: "from-blue-50 to-cyan-50 border-blue-200/80 dark:from-blue-950 dark:to-blue-900 dark:border-blue-500/40", iconColors: "bg-blue-600 text-white" },
          { label: "Total Sacks", value: stats.sacks.toLocaleString(), detail: `$${fmt(stats.sackValue)} value`, icon: ShoppingBag, colors: "from-emerald-50 to-teal-50 border-emerald-200/80 dark:from-[#053c38] dark:to-[#07564a] dark:border-emerald-500/40", iconColors: "bg-emerald-600 text-white" },
          { label: "All Items", value: items.length.toLocaleString(), detail: "Active inventory entries", icon: Package, colors: "from-violet-50 to-purple-50 border-violet-200/80 dark:from-blue-950 dark:to-blue-900 dark:border-violet-500/40", iconColors: "bg-violet-600 text-white" },
          { label: "Total Value", value: `$${fmt(stats.totalValue)}`, detail: "Current inventory value", icon: Wallet, colors: "from-amber-50 to-orange-50 border-amber-200/80 dark:from-[#423016] dark:to-[#563b18] dark:border-amber-500/40", iconColors: "bg-amber-600 text-white" },
        ].map((metric) => (
          <Card key={metric.label} className={`relative overflow-hidden rounded-2xl border bg-gradient-to-br shadow-sm ${metric.colors}`}>
            <CardContent className="relative flex min-h-32 flex-col justify-between p-4 sm:p-5">
              <div aria-hidden="true" className="pointer-events-none absolute -bottom-14 -right-10 h-28 w-36 rounded-full border-[16px] border-white/20 dark:border-white/5" />
              <div className="flex items-center gap-2.5">
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl shadow-sm ${metric.iconColors}`}><metric.icon className="h-4 w-4" /></span>
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 sm:text-sm">{metric.label}</span>
              </div>
              <div className="mt-3">
                <div className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-[28px]">{metric.value}</div>
                <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{metric.detail}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tab switcher */}
      {effectiveTab ? (
        <TabsList aria-label="Sheets and sacks sections" className="w-max max-w-full rounded-2xl border-indigo-200/70 bg-indigo-50/80 p-1.5 dark:border-indigo-400/20 dark:bg-card">
          {showStock && (
            <PillTabButton onClick={() => setActiveTab("stock")} selected={effectiveTab === "stock"} className={effectiveTab === "stock" ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md hover:text-white" : "hover:bg-indigo-100/70 dark:hover:bg-indigo-500/10"}>
              <Layers className="h-4 w-4" />
              Current Stock
            </PillTabButton>
          )}
          {showMovements && (
            <PillTabButton onClick={() => setActiveTab("movements")} selected={effectiveTab === "movements"} className={effectiveTab === "movements" ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md hover:text-white" : "hover:bg-indigo-100/70 dark:hover:bg-indigo-500/10"}>
              <History className="h-4 w-4" />
              Movement Log
            </PillTabButton>
          )}
        </TabsList>
      ) : (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          No Sheets & Sacks tabs are available for this user.
        </div>
      )}

      {/* ─── CURRENT STOCK TAB ───────────────────────────────────────────── */}
      {effectiveTab === "stock" && (
        <>
          <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm dark:border-slate-700/60 dark:bg-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 bg-slate-50/80 px-4 py-3 dark:border-slate-700/60 dark:bg-slate-900/40">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input placeholder="Search by name, size..." aria-label="Search stock" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 w-56 rounded-xl border-slate-200 bg-background pl-9 dark:border-slate-600 sm:w-64" />
                </div>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger aria-label="Filter item type" className="h-9 w-36 rounded-xl border-slate-200 bg-background dark:border-slate-600"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
                {(search || typeFilter !== "all") && (
                  <span className="text-xs text-muted-foreground">Showing {filtered.length} of {items.length}</span>
                )}
                {selectedVisibleCount > 0 && (
                  <span className="rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">{selectedVisibleCount} selected</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-xl" aria-label="Choose visible stock columns"><Columns3 className="h-4 w-4" /> Columns</Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-56 space-y-2 p-3">
                    <p className="text-xs font-semibold text-muted-foreground">Visible columns (saved)</p>
                    <div className="flex items-center gap-2 rounded-md p-1.5 text-sm"><Check className="h-4 w-4 text-emerald-500" /> Name <span className="ml-auto text-[10px] text-muted-foreground">Always shown</span></div>
                    {OPTIONAL_COLUMNS.map((column) => (
                      <label key={column.key} className="flex cursor-pointer items-center gap-2 rounded-md p-1.5 text-sm hover:bg-muted">
                        <Checkbox checked={columnVisible(column.key)} onCheckedChange={(checked) => setHiddenColumns((previous) => checked ? previous.filter((key) => key !== column.key) : [...new Set([...previous, column.key])])} />
                        {column.label}
                      </label>
                    ))}
                    <Button size="sm" variant="ghost" className="w-full" onClick={() => setHiddenColumns([])}>Show all columns</Button>
                  </PopoverContent>
                </Popover>
                <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-xl" onClick={exportStock} disabled={!filtered.length} title={selectedVisibleCount ? "Export selected rows" : "Export filtered rows"}><Download className="h-4 w-4" /> Export</Button>
                <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-xl print:hidden" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button>
                <Button variant="outline" size="icon" className="h-9 w-9 rounded-xl" title="Refresh stock" aria-label="Refresh stock" onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/factory/sheets-sacks"] })}><RefreshCw className="h-4 w-4" /></Button>
              </div>
            </div>

          {/* Table */}
          <Card className="rounded-none border-0 bg-transparent shadow-none">
            <CardContent className="p-0">
              {isLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <Layers className="h-10 w-10 mb-3 opacity-25" />
                  <p className="text-sm font-medium">
                    {items.length === 0 ? "No items yet. Add your first sheet or sack." : "No items match your search."}
                  </p>
                  {items.length === 0 && canEdit && (
                    <Button variant="outline" className="mt-4" onClick={() => setShowAddDialog(true)}>
                      <Plus className="h-4 w-4 mr-1" />
                      Add Item
                    </Button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table mobileLayout="cards" data-testid="factory-sheets-sacks-table" wrapperClassName="rounded-none border-0" className="text-sm">
                    <TableHeader className="bg-slate-100 dark:bg-muted">
                      <TableRow className="border-slate-200 bg-slate-100 hover:bg-slate-100 dark:border-slate-700 dark:bg-muted dark:hover:bg-muted">
                        <TableHead className="w-9 px-3"><Checkbox aria-label="Select all visible stock rows" checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false} onCheckedChange={(checked) => toggleVisibleSelection(checked === true)} /></TableHead>
                        <TableHead className="w-7 px-1" />
                        <TableHead className="min-w-40 text-xs font-bold uppercase tracking-wide">Name</TableHead>
                        {columnVisible("type") && <TableHead className="text-xs font-bold uppercase tracking-wide">Type</TableHead>}
                        {columnVisible("size") && <TableHead className="text-xs font-bold uppercase tracking-wide">Size / Weight</TableHead>}
                        {columnVisible("packs") && <TableHead className="text-right text-xs font-bold uppercase tracking-wide">Qty (packs)</TableHead>}
                        {columnVisible("perPack") && <TableHead className="text-right text-xs font-bold uppercase tracking-wide"># / Pack</TableHead>}
                        {columnVisible("pieces") && <TableHead className="text-right text-xs font-bold uppercase tracking-wide">Total Pcs</TableHead>}
                        {columnVisible("price") && <TableHead className="text-right text-xs font-bold uppercase tracking-wide">Price / Pc</TableHead>}
                        {columnVisible("value") && <TableHead className="text-right text-xs font-bold uppercase tracking-wide">Total Value</TableHead>}
                        {columnVisible("notes") && <TableHead className="text-xs font-bold uppercase tracking-wide">Notes</TableHead>}
                        {canEdit && <TableHead className="text-right text-xs font-bold uppercase tracking-wide">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((item) => {
                        const totalPcs = parseFloat(item.quantity || "0");
                        const totalVal = totalPcs * parseFloat(item.unitPrice || "0");
                        const bg = item.rowColor ? `${item.rowColor}18` : undefined;
                        const selected = selectedIds.includes(item.id);
                        return (
                          <TableRow key={item.id} data-state={selected ? "selected" : undefined} className="border-slate-200/70 transition-colors hover:bg-indigo-50/70 dark:border-slate-700/60 dark:hover:bg-indigo-500/10" style={bg ? { backgroundColor: bg } : undefined}>
                            <TableCell className="px-3"><Checkbox aria-label={`Select ${item.name}`} checked={selected} onCheckedChange={(checked) => setSelectedIds((ids) => checked ? [...new Set([...ids, item.id])] : ids.filter((id) => id !== item.id))} /></TableCell>
                            <TableCell className="px-1">
                              <span className="inline-block h-3 w-3 rounded-full border border-black/10 shadow-sm dark:border-white/20" style={{ backgroundColor: item.rowColor || "transparent" }} />
                            </TableCell>
                            <TableCell className="font-semibold text-foreground">{item.name}</TableCell>
                            {columnVisible("type") && <TableCell>{typeBadge(item.type)}</TableCell>}
                            {columnVisible("size") && <TableCell className="text-muted-foreground">{item.size || "—"}</TableCell>}
                            {columnVisible("packs") && <TableCell className="text-right font-mono">{fmtInt(item.packQty)}</TableCell>}
                            {columnVisible("perPack") && <TableCell className="text-right font-mono">{fmtInt(item.pcsPerPack)}</TableCell>}
                            {columnVisible("pieces") && <TableCell className="text-right font-mono font-semibold">{totalPcs > 0 ? totalPcs.toLocaleString("en-US") : "0"}</TableCell>}
                            {columnVisible("price") && <TableCell className="text-right font-mono">${fmt(item.unitPrice)}</TableCell>}
                            {columnVisible("value") && <TableCell className="text-right font-mono font-semibold">${fmt(totalVal)}</TableCell>}
                            {columnVisible("notes") && <TableCell className="max-w-[210px] truncate text-xs text-muted-foreground">{item.notes || "—"}</TableCell>}
                            {canEdit && (
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-0.5">
                                  <Button size="icon" variant="ghost" onClick={() => setRestockItem(item)} title="Add Stock" aria-label={`Add Stock ${item.name}`} className="h-8 w-8 rounded-lg hover:bg-emerald-500/10"><PlusCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" /></Button>
                                  <Button size="icon" variant="ghost" onClick={() => setDeductItem(item)} title="Deduct" aria-label={`Deduct ${item.name}`} className="h-8 w-8 rounded-lg hover:bg-amber-500/10"><MinusCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" /></Button>
                                  <Button size="icon" variant="ghost" onClick={() => setEditItem(item)} title="Edit" aria-label={`Edit ${item.name}`} className="h-8 w-8 rounded-lg hover:bg-blue-500/10"><Pencil className="h-4 w-4 text-blue-600 dark:text-blue-400" /></Button>
                                  <Button size="icon" variant="ghost" onClick={() => setDeleteItem(item)} title="Delete" aria-label={`Delete ${item.name}`} className="h-8 w-8 rounded-lg hover:bg-red-500/10"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                    <tfoot className="border-t-2 border-indigo-200 bg-indigo-50/70 font-semibold dark:border-indigo-400/20 dark:bg-indigo-500/10">
                      <tr>
                        <td className="px-3 py-3" />
                        <td className="px-1 py-3" />
                        <td className="px-4 py-3 text-sm">Totals <span className="font-normal text-muted-foreground">({filtered.length} items)</span></td>
                        {columnVisible("type") && <td className="px-4 py-3" />}
                        {columnVisible("size") && <td className="px-4 py-3" />}
                        {columnVisible("packs") && <td className="px-4 py-3 text-right font-mono text-sm">{colTotals.packQty > 0 ? colTotals.packQty.toLocaleString("en-US") : "—"}</td>}
                        {columnVisible("perPack") && <td className="px-4 py-3" />}
                        {columnVisible("pieces") && <td className="px-4 py-3 text-right font-mono text-sm">{colTotals.pcs.toLocaleString("en-US")}</td>}
                        {columnVisible("price") && <td className="px-4 py-3" />}
                        {columnVisible("value") && <td className="px-4 py-3 text-right font-mono text-sm font-bold">${fmt(colTotals.value)}</td>}
                        {columnVisible("notes") && <td className="px-4 py-3" />}
                        {canEdit && <td className="px-4 py-3" />}
                      </tr>
                    </tfoot>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
          </div>
        </>
      )}

      {/* ─── MOVEMENT LOG TAB ─────────────────────────────────────────────── */}
      {effectiveTab === "movements" && (
        <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading movements...</div>}>
          <MovementLog items={items} />
        </Suspense>
      )}

      {/* Dialogs */}
      <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading editor...</div>}>
      {(showAddDialog || editItem) && (
        <ItemFormDialog
          open={showAddDialog || !!editItem}
          onClose={() => {
            setShowAddDialog(false);
            setEditItem(null);
          }}
          existing={editItem}
        />
      )}
      {deductItem && <DeductDialog open={!!deductItem} onClose={() => setDeductItem(null)} item={deductItem} />}
      {restockItem && <RestockDialog open={!!restockItem} onClose={() => setRestockItem(null)} item={restockItem} />}
      </Suspense>

      <AlertDialog open={!!deleteItem} onOpenChange={(v) => !v && setDeleteItem(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Item</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong>{deleteItem?.name}</strong>? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteItem && deleteMutation.mutate(deleteItem.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
