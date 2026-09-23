import type { ClientErrorLike } from "@/lib/clientError";
import {useState, useMemo} from "react";
import {useQuery, useMutation} from "@tanstack/react-query";
import {queryClient, apiRequest} from "@/lib/queryClient";
import {useToast} from "@/hooks/use-toast";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Badge} from "@/components/ui/badge";
import {Card, CardContent} from "@/components/ui/card";
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from "@/components/ui/table";
import {AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle} from "@/components/ui/alert-dialog";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {PageHeader} from "@/components/PageHeader";
import {Layers, Plus, Pencil, Trash2, Search, Loader2, Package, ShoppingBag, MinusCircle, PlusCircle, History} from "lucide-react";

import type {SheetsAndSacksItem} from "./factorysheetsandsacks/types";
import {TYPES, fmt, fmtInt} from "./factorysheetsandsacks/utils";
import {ItemFormDialog} from "./factorysheetsandsacks/components/ItemFormDialog";
import {DeductDialog} from "./factorysheetsandsacks/components/DeductDialog";
import {RestockDialog} from "./factorysheetsandsacks/components/RestockDialog";
import {MovementLog} from "./factorysheetsandsacks/components/MovementLog";
export default function FactorySheetsAndSacks() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"stock" | "movements">("stock");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editItem, setEditItem] = useState<SheetsAndSacksItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<SheetsAndSacksItem | null>(null);
  const [deductItem, setDeductItem] = useState<SheetsAndSacksItem | null>(null);
  const [restockItem, setRestockItem] = useState<SheetsAndSacksItem | null>(null);

  const { data: items = [], isLoading } = useQuery<SheetsAndSacksItem[]>({
    queryKey: ["/api/factory/sheets-sacks"],
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: myAccess } = useQuery<{ fullAccess: boolean; pageKeys: string[]; hiddenCostFields?: string[] }>({
    queryKey: ["/api/factory/my-access"],
    staleTime: 30000,
  });

  const canEdit = !myAccess || myAccess.fullAccess || myAccess.pageKeys.includes("factory/sheets-sacks");
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];
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
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <PageHeader title="Sheets & Sacks" subtitle="Track packaging materials inventory" />
        {canEdit && (
          <Button onClick={() => setShowAddDialog(true)} data-testid="button-add-item">
            <Plus className="h-4 w-4 mr-1" />
            Add Item
          </Button>
        )}
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Total Sheets</span>
            </div>
            <div className="text-2xl font-bold mt-1">{stats.sheets}</div>
            <div className="text-xs text-muted-foreground mt-0.5">${fmt(stats.sheetValue)} value</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Total Sacks</span>
            </div>
            <div className="text-2xl font-bold mt-1">{stats.sacks}</div>
            <div className="text-xs text-muted-foreground mt-0.5">${fmt(stats.sackValue)} value</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">All Items</span>
            </div>
            <div className="text-2xl font-bold mt-1">{items.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground">$</span>
              <span className="text-sm text-muted-foreground">Total Value</span>
            </div>
            <div className="text-2xl font-bold mt-1">${fmt(stats.totalValue)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Tab switcher */}
      {effectiveTab ? (
      <div className="flex items-center gap-1 border-b">
        {showStock && <button
          onClick={() => setActiveTab("stock")}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            effectiveTab === "stock"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <Layers className="h-4 w-4" />
          Current Stock
        </button>}
        {showMovements && <button
          onClick={() => setActiveTab("movements")}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            effectiveTab === "movements"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <History className="h-4 w-4" />
          Movement Log
        </button>}
      </div>
      ) : (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          No Sheets & Sacks tabs are available for this user.
        </div>
      )}

      {/* ─── CURRENT STOCK TAB ───────────────────────────────────────────── */}
      {effectiveTab === "stock" && (
        <>
          {/* Filters */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, size..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 w-64"
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(search || typeFilter !== "all") && (
              <span className="text-xs text-muted-foreground">
                Showing {filtered.length} of {items.length} items
              </span>
            )}
          </div>

          {/* Table */}
          <Card>
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
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-6" />
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Size / Weight</TableHead>
                        <TableHead className="text-right">Qty (packs)</TableHead>
                        <TableHead className="text-right"># / Pack</TableHead>
                        <TableHead className="text-right">Total Pcs</TableHead>
                        <TableHead className="text-right">Price / Pc</TableHead>
                        <TableHead className="text-right">Total Value</TableHead>
                        <TableHead>Notes</TableHead>
                        {canEdit && <TableHead className="text-right">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((item) => {
                        const totalPcs = parseFloat(item.quantity || "0");
                        const totalVal = totalPcs * parseFloat(item.unitPrice || "0");
                        const bg = item.rowColor ? `${item.rowColor}18` : undefined;
                        return (
                          <TableRow key={item.id} style={bg ? { backgroundColor: bg } : undefined}>
                            <TableCell className="px-2">
                              {item.rowColor ? (
                                <span
                                  className="inline-block rounded-full border border-border/50"
                                  style={{ width: 14, height: 14, backgroundColor: item.rowColor }}
                                />
                              ) : (
                                <span
                                  className="inline-block rounded-full border border-border/30 bg-transparent"
                                  style={{ width: 14, height: 14 }}
                                />
                              )}
                            </TableCell>
                            <TableCell className="font-medium">{item.name}</TableCell>
                            <TableCell>{typeBadge(item.type)}</TableCell>
                            <TableCell className="text-muted-foreground">{item.size || "—"}</TableCell>
                            <TableCell className="text-right font-mono">{fmtInt(item.packQty)}</TableCell>
                            <TableCell className="text-right font-mono">{fmtInt(item.pcsPerPack)}</TableCell>
                            <TableCell className="text-right font-mono">
                              {totalPcs > 0 ? totalPcs.toLocaleString("en-US") : "0"}
                            </TableCell>
                            <TableCell className="text-right font-mono">${fmt(item.unitPrice)}</TableCell>
                            <TableCell className="text-right font-mono font-medium">${fmt(totalVal)}</TableCell>
                            <TableCell className="text-muted-foreground text-sm max-w-xs truncate">
                              {item.notes || "—"}
                            </TableCell>
                            {canEdit && (
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => setRestockItem(item)}
                                    title="Add Stock"
                                  >
                                    <PlusCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                                  </Button>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => setDeductItem(item)}
                                    title="Deduct"
                                  >
                                    <MinusCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                                  </Button>
                                  <Button size="icon" variant="ghost" onClick={() => setEditItem(item)} title="Edit">
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={() => setDeleteItem(item)}
                                    title="Delete"
                                  >
                                    <Trash2 className="h-4 w-4 text-destructive" />
                                  </Button>
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                    <tfoot className="border-t-2 bg-muted/40 font-semibold">
                      <tr>
                        <td className="w-6 px-2 py-3" />
                        <td className="py-3 px-4 text-sm text-muted-foreground">
                          Totals <span className="font-normal">({filtered.length} items)</span>
                        </td>
                        <td className="py-3 px-4" />
                        {/* Type */}
                        <td className="py-3 px-4" />
                        {/* Size */}
                        <td className="py-3 px-4 text-right font-mono text-sm">
                          {colTotals.packQty > 0 ? colTotals.packQty.toLocaleString("en-US") : "—"}
                        </td>
                        <td className="py-3 px-4" />
                        {/* # / Pack */}
                        <td className="py-3 px-4 text-right font-mono text-sm">
                          {colTotals.pcs.toLocaleString("en-US")}
                        </td>
                        <td className="py-3 px-4" />
                        {/* Price / Pc */}
                        <td className="py-3 px-4 text-right font-mono text-sm font-bold">${fmt(colTotals.value)}</td>
                        <td className="py-3 px-4" />
                        {/* Notes */}
                        {canEdit && <td className="py-3 px-4" />}
                      </tr>
                    </tfoot>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ─── MOVEMENT LOG TAB ─────────────────────────────────────────────── */}
      {effectiveTab === "movements" && <MovementLog items={items} />}

      {/* Dialogs */}
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
