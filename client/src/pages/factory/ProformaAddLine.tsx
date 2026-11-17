import { ArrowLeft, Check, Plus, Search, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/formatNumber";
import { PageHeader } from "@/components/PageHeader";
import { SearchField } from "@/components/ui/search-field";
import { useProformaAddLineState } from "./useProformaAddLineState";

export default function ProformaAddLine() {
  const {
    addMutation,
    autoSave,
    autoSaveCountdown,
    clearAutoSaveTimers,
    filtered,
    getEffectiveWeight,
    goBack,
    groupFilter,
    groups,
    handleSelectItem,
    isAdded,
    isSelected,
    itemsLoading,
    price,
    proformaName,
    qty,
    search,
    selectedItem,
    setGroupFilter,
    setPrice,
    setQty,
    setSearch,
    setSelectedItem,
    toggleAutoSave,
  } = useProformaAddLineState();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      {/* Header and search stick together, so the header may wrap on phones without the search bar
          (previously pinned 57px down) sliding underneath it. */}
      <div className="sticky top-0 z-20 bg-background">
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
          <Button size="icon" variant="ghost" onClick={goBack} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-40 flex-1">
            <p className="text-xs text-muted-foreground">Adding line to</p>
            <PageHeader title={proformaName} />
          </div>
          {/* Autosave toggle */}
          <button
            onClick={toggleAutoSave}
            className={`flex items-center gap-1.5 px-3 h-9 rounded-md border text-sm font-medium transition-colors ${
              autoSave
                ? "bg-green-500/10 border-green-500/50 text-green-600 dark:text-green-400"
                : "bg-background border-border text-muted-foreground"
            }`}
            data-testid="button-autosave-toggle"
            title={autoSave ? "Autosave ON — items added automatically" : "Autosave OFF — press Add manually"}
          >
            <Zap className={`h-4 w-4 ${autoSave ? "fill-green-500 text-green-500" : ""}`} />
            <span className="hidden sm:inline">Autosave</span>
            <span
              className={`w-8 h-4 rounded-full relative transition-colors ${autoSave ? "bg-green-500" : "bg-muted-foreground/30"}`}
            >
              <span
                className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${autoSave ? "translate-x-4" : "translate-x-0.5"}`}
              />
            </span>
          </button>
          <Button variant="outline" size="sm" onClick={goBack} data-testid="button-done">
            Done
          </Button>
        </div>

        {/* Search + Group filters */}
        <div className="border-b px-4 py-2 space-y-2">
          <SearchField
            placeholder="Search by name or article code..."
            value={search}
            onValueChange={setSearch}
            autoFocus
            data-testid="input-search"
            clearTestId="button-clear-search"
          />
          {groups.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
              {groups.map((g) => (
                <button
                  key={g}
                  onClick={() => setGroupFilter(g)}
                  className={`shrink-0 text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    groupFilter === g
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground border-border hover-elevate"
                  }`}
                  data-testid={`button-group-${g}`}
                >
                  {g === "all" ? "All" : g}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Item count */}
      <div className="px-4 pt-2 pb-1">
        <p className="text-xs text-muted-foreground">
          {itemsLoading
            ? "Loading..."
            : `${filtered.length} item${filtered.length !== 1 ? "s" : ""}${search ? ` matching "${search}"` : ""}`}
        </p>
      </div>

      {/* Items grid — padded at bottom for the sticky bar (literal classes so Tailwind emits them,
          plus the home-indicator inset the bar sits above) */}
      <div
        className={`flex-1 overflow-y-auto px-4 ${selectedItem ? "pb-[calc(11rem+env(safe-area-inset-bottom))]" : "pb-6"}`}
      >
        {itemsLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mt-2">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Search className="h-8 w-8 mb-2 opacity-30" />
            <p className="text-sm">No items found</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mt-2">
            {filtered.map((item) => {
              const added = isAdded(item);
              const selected = isSelected(item);
              const effectiveWt = getEffectiveWeight(item);
              const wt = effectiveWt ? parseFloat(effectiveWt) : null;
              const wtFromBaleProduct = !item.weightPerBaleKg || parseFloat(item.weightPerBaleKg) === 0;
              return (
                <button
                  key={item.id}
                  onClick={() => !added && handleSelectItem(item)}
                  disabled={added}
                  className={`relative text-left rounded-md border p-3 transition-colors flex flex-col gap-1
                    ${added ? "opacity-50 cursor-default bg-muted" : "cursor-pointer"}
                    ${selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-card hover-elevate"}
                  `}
                  data-testid={`button-item-${item.id}`}
                >
                  {added && (
                    <span className="absolute top-2 right-2 bg-green-500 text-white rounded-full p-0.5">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                  {selected && !added && (
                    <span className="absolute top-2 right-2 bg-primary text-primary-foreground rounded-full p-0.5">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                  <p className="text-sm font-medium leading-snug line-clamp-2 pr-5">{item.name}</p>
                  {item.code && <p className="text-xs font-mono text-muted-foreground">{item.code}</p>}
                  {wt !== null && (
                    <p className="text-xs text-muted-foreground mt-auto">
                      {formatNumber(wt)} kg/bale{wtFromBaleProduct && wt > 0 ? " *" : ""}
                    </p>
                  )}
                  {item.salePrice && parseFloat(item.salePrice) > 0 && (
                    <p className="text-xs text-muted-foreground">${parseFloat(item.salePrice).toFixed(2)}</p>
                  )}
                  {item.stockGroup?.name && (
                    <Badge variant="secondary" className="text-xs mt-1 w-fit no-default-active-elevate">
                      {item.stockGroup.name}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Sticky bottom panel when item selected */}
      {selectedItem && (
        <div className="fixed bottom-0 left-0 right-0 z-30 bg-background border-t shadow-lg px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {/* Autosave progress bar */}
          {autoSave && autoSaveCountdown > 0 && (
            <div className="absolute top-0 left-0 right-0 h-1 bg-muted overflow-hidden rounded-none">
              <div
                className="h-full bg-green-500 transition-all duration-100"
                style={{ width: `${autoSaveCountdown}%` }}
              />
            </div>
          )}
          <div className="max-w-2xl mx-auto">
            <div className="flex items-start gap-3 mb-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold truncate">{selectedItem.name}</p>
                  {autoSave && (
                    <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-0.5 shrink-0">
                      <Zap className="h-3 w-3 fill-green-500" />
                      {addMutation.isPending ? "Saving…" : "Auto-adding…"}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <p className="text-xs text-muted-foreground font-mono">{selectedItem.code}</p>
                  {(() => {
                    const ew = getEffectiveWeight(selectedItem);
                    if (!ew || parseFloat(ew) === 0) return null;
                    const fromBaleProduct =
                      !selectedItem.weightPerBaleKg || parseFloat(selectedItem.weightPerBaleKg) === 0;
                    return (
                      <p className="text-xs text-muted-foreground">
                        {formatNumber(parseFloat(ew))} kg/bale{fromBaleProduct ? " (from product)" : ""}
                      </p>
                    );
                  })()}
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={() => {
                  setSelectedItem(null);
                  clearAutoSaveTimers();
                }}
                data-testid="button-deselect"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="text-xs font-medium mb-1 block text-muted-foreground">Quantity (bales)</label>
                <Input
                  type="number"
                  min="1"
                  placeholder="Qty"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
                    if (e.key === "Enter" && qty && price) addMutation.mutate();
                  }}
                  data-testid="input-qty"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs font-medium mb-1 block text-muted-foreground">Price per bale</label>
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
                    if (e.key === "Enter" && qty && price) addMutation.mutate();
                  }}
                  data-testid="input-price"
                />
              </div>
              <Button
                onClick={() => {
                  clearAutoSaveTimers();
                  addMutation.mutate();
                }}
                disabled={!qty || !price || addMutation.isPending}
                data-testid="button-add-line"
              >
                <Plus className="h-4 w-4 mr-1" />
                {addMutation.isPending ? "Adding..." : "Add"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
