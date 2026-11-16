import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Layers, Plus, Loader2, Package, ShoppingBag, History, Warehouse, Wallet } from "lucide-react";
import { fmt } from "./factorysheetsandsacks/utils";
import { useFactorySheetsAndSacksState } from "./useFactorySheetsAndSacksState";
import { FactorySheetsAndSacksCardSection } from "./FactorySheetsAndSacksCardSection";
import { FactorySheetsAndSacksSection } from "./FactorySheetsAndSacksSection";
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

export default function FactorySheetsAndSacks() {
  const {
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
  } = useFactorySheetsAndSacksState();

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Visual refresh: existing stock KPIs, permissions and mutations stay unchanged. */}
      <div className="relative isolate overflow-hidden rounded-2xl border border-indigo-200/70 bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100 px-5 py-6 shadow-sm dark:border-indigo-400/20 dark:from-blue-950 dark:via-blue-900 dark:to-blue-800 sm:px-7">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-blue-400/20 blur-3xl dark:bg-blue-500/20"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-36 right-20 h-64 w-96 rounded-full bg-violet-400/20 blur-3xl"
        />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-lg shadow-indigo-600/20">
              <Layers className="h-7 w-7" />
            </div>
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.17em] text-indigo-600 dark:text-indigo-300">
                <Warehouse className="h-3.5 w-3.5" /> Packaging inventory
              </p>
              <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white sm:text-3xl">
                Sheets &amp; Sacks
              </h1>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Track packaging materials inventory</p>
            </div>
          </div>
          {canEdit && showStock && (
            <Button
              onClick={() => setShowAddDialog(true)}
              data-testid="button-add-item"
              className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-5 font-semibold text-white shadow-md shadow-indigo-600/20 hover:from-blue-700 hover:to-indigo-700"
            >
              <Plus className="mr-2 h-4 w-4" /> Add Item
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          {
            label: "Total Sheets",
            value: stats.sheets.toLocaleString(),
            detail: `$${fmt(stats.sheetValue)} value`,
            icon: Layers,
            colors:
              "from-blue-50 to-cyan-50 border-blue-200/80 dark:from-blue-950 dark:to-blue-900 dark:border-blue-500/40",
            iconColors: "bg-blue-600 text-white",
          },
          {
            label: "Total Sacks",
            value: stats.sacks.toLocaleString(),
            detail: `$${fmt(stats.sackValue)} value`,
            icon: ShoppingBag,
            colors:
              "from-emerald-50 to-teal-50 border-emerald-200/80 dark:from-[#053c38] dark:to-[#07564a] dark:border-emerald-500/40",
            iconColors: "bg-emerald-600 text-white",
          },
          {
            label: "All Items",
            value: items.length.toLocaleString(),
            detail: "Active inventory entries",
            icon: Package,
            colors:
              "from-violet-50 to-purple-50 border-violet-200/80 dark:from-blue-950 dark:to-blue-900 dark:border-violet-500/40",
            iconColors: "bg-violet-600 text-white",
          },
          {
            label: "Total Value",
            value: `$${fmt(stats.totalValue)}`,
            detail: "Current inventory value",
            icon: Wallet,
            colors:
              "from-amber-50 to-orange-50 border-amber-200/80 dark:from-[#423016] dark:to-[#563b18] dark:border-amber-500/40",
            iconColors: "bg-amber-600 text-white",
          },
        ].map((metric) => (
          <Card
            key={metric.label}
            className={`relative overflow-hidden rounded-2xl border bg-gradient-to-br shadow-sm ${metric.colors}`}
          >
            <CardContent className="relative flex min-h-32 flex-col justify-between p-4 sm:p-5">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-14 -right-10 h-28 w-36 rounded-full border-[16px] border-white/20 dark:border-white/5"
              />
              <div className="flex items-center gap-2.5">
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl shadow-sm ${metric.iconColors}`}
                >
                  <metric.icon className="h-4 w-4" />
                </span>
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200 sm:text-sm">
                  {metric.label}
                </span>
              </div>
              <div className="mt-3">
                <div className="text-2xl font-extrabold tracking-tight text-slate-950 dark:text-white sm:text-[28px]">
                  {metric.value}
                </div>
                <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{metric.detail}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tab switcher */}
      {effectiveTab ? (
        <TabsList
          aria-label="Sheets and sacks sections"
          className="w-max max-w-full rounded-2xl border-indigo-200/70 bg-indigo-50/80 p-1.5 dark:border-indigo-400/20 dark:bg-card"
        >
          {showStock && (
            <PillTabButton
              onClick={() => setActiveTab("stock")}
              selected={effectiveTab === "stock"}
              className={
                effectiveTab === "stock"
                  ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md hover:text-white"
                  : "hover:bg-indigo-100/70 dark:hover:bg-indigo-500/10"
              }
            >
              <Layers className="h-4 w-4" />
              Current Stock
            </PillTabButton>
          )}
          {showMovements && (
            <PillTabButton
              onClick={() => setActiveTab("movements")}
              selected={effectiveTab === "movements"}
              className={
                effectiveTab === "movements"
                  ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md hover:text-white"
                  : "hover:bg-indigo-100/70 dark:hover:bg-indigo-500/10"
              }
            >
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
            <FactorySheetsAndSacksSection
              columnVisible={columnVisible}
              exportStock={exportStock}
              filtered={filtered}
              items={items}
              search={search}
              selectedVisibleCount={selectedVisibleCount}
              setHiddenColumns={setHiddenColumns}
              setSearch={setSearch}
              setTypeFilter={setTypeFilter}
              typeFilter={typeFilter}
            />

            {/* Table */}
            <FactorySheetsAndSacksCardSection
              allVisibleSelected={allVisibleSelected}
              canEdit={canEdit}
              colTotals={colTotals}
              columnVisible={columnVisible}
              filtered={filtered}
              isLoading={isLoading}
              items={items}
              selectedIds={selectedIds}
              setDeductItem={setDeductItem}
              setDeleteItem={setDeleteItem}
              setEditItem={setEditItem}
              setRestockItem={setRestockItem}
              setSelectedIds={setSelectedIds}
              setShowAddDialog={setShowAddDialog}
              someVisibleSelected={someVisibleSelected}
              toggleVisibleSelection={toggleVisibleSelection}
              typeBadge={typeBadge}
            />
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
