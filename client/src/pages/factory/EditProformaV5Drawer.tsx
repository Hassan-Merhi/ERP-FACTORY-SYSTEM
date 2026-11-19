import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertTriangle,
  Loader2,
  CheckCircle2,
  Save,
  BookmarkCheck,
  FilePenLine,
  Package,
  Boxes,
  Scale,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import { V5ProformaMobileLines } from "./V5ProformaMobileLines";
import { type Props } from "./useEditProformaV5DrawerState";
import { SearchField } from "@/components/ui/search-field";
import { useEditProformaV5DrawerModel } from "./EditProformaV5DrawerModel";
import { EditProformaV5LinesTable } from "./EditProformaV5LinesTable";

export default function EditProformaV5Drawer(props: Props) {
  const m = useEditProformaV5DrawerModel(props);

  return (
    <div className="flex min-w-0 flex-col bg-background pb-5" data-testid="page-edit-proforma-v5">
      <section className="px-3 pb-3 pt-5 sm:px-5">
        <PageHeader title="Edit Proforma" subtitle="Stock Allocation" icon={<FilePenLine className="h-5 w-5" />} />
        {!m.isLoading && !m.proformaQuery.isError && (
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-5">
            <div className="flex min-w-0 items-center gap-3 rounded-xl border border-violet-500/25 bg-violet-500/[0.07] p-3.5 shadow-sm">
              <Package className="hidden h-9 w-9 shrink-0 rounded-lg bg-violet-500/15 p-2 text-violet-500 sm:block" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Total Products</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-violet-500">
                  {m.visibleRows.length.toLocaleString()}
                </p>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3.5 shadow-sm">
              <Boxes className="hidden h-9 w-9 shrink-0 rounded-lg bg-emerald-500/15 p-2 text-emerald-500 sm:block" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Qty / Container</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-emerald-500">{m.totalQty.toLocaleString()}</p>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3.5 shadow-sm">
              <Scale className="hidden h-9 w-9 shrink-0 rounded-lg bg-amber-500/15 p-2 text-amber-500 sm:block" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Total KG</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-amber-500">{m.totalKg.toLocaleString()}</p>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-xl border border-sky-500/25 bg-sky-500/[0.07] p-3.5 shadow-sm">
              <Save className="hidden h-9 w-9 shrink-0 rounded-lg bg-sky-500/15 p-2 text-sky-500 sm:block" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Total Value</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-sky-500">{m.totalValue.toLocaleString()}</p>
              </div>
            </div>
            <div className="col-span-2 lg:col-span-1 flex min-w-0 items-center gap-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] p-3.5 shadow-sm">
              <AlertTriangle className="hidden h-9 w-9 shrink-0 rounded-lg bg-rose-500/15 p-2 text-rose-500 sm:block" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Shortages</p>
                <p className="mt-1 text-2xl font-bold tabular-nums text-rose-500">{m.warningCount.toLocaleString()}</p>
              </div>
            </div>
          </div>
        )}
      </section>

      {m.isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : m.proformaQuery.isError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center" role="alert">
          <AlertTriangle className="h-6 w-6 text-destructive" />
          <p className="text-sm text-destructive">Could not load this proforma: {m.proformaQuery.error.message}</p>
          <Button variant="outline" onClick={() => m.proformaQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          {/* Top fields */}
          <div className="mx-3 flex flex-wrap items-end gap-4 rounded-t-xl border bg-card/70 p-3.5 shadow-sm sm:mx-5 sm:p-4">
            <div className="flex flex-col gap-1.5 min-w-[200px] flex-1">
              <Label htmlFor="edit-v5-proforma-name" className="text-xs font-medium">
                Proforma Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="edit-v5-proforma-name"
                data-testid="input-edit-v5-proforma-name"
                value={m.proformaName}
                onChange={(e) => m.setProformaName(e.target.value)}
                placeholder="Proforma name"
              />
            </div>

            <div className="flex flex-col gap-1.5 min-w-[190px] flex-1">
              <Label htmlFor="edit-v5-proforma-destination" className="text-xs font-medium">
                Destination <span className="text-destructive">*</span>
              </Label>
              <Input
                id="edit-v5-proforma-destination"
                data-testid="input-edit-v5-proforma-destination"
                value={m.destination}
                onChange={(e) => {
                  m.setDestination(e.target.value);
                  m.setAppliedPrice(null);
                }}
                placeholder="e.g. L'SHI, MALI, KINSHASA"
                list="edit-proforma-destination-suggestions"
              />
              <datalist id="edit-proforma-destination-suggestions">
                <option value="L'SHI" />
                <option value="MALI" />
                <option value="KINSHASA" />
              </datalist>
              {!m.proformaQuery.data?.destination && (
                <p className="text-xs text-muted-foreground">
                  Old proforma: assign its destination here. Existing prices are preserved until you explicitly apply
                  destination prices.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium">Status</Label>
              <div className="flex items-center gap-2 h-9">
                <Switch
                  checked={m.isActive}
                  onCheckedChange={m.setIsActive}
                  data-testid="switch-edit-v5-proforma-active"
                />
                <span className="text-sm text-muted-foreground">{m.isActive ? "Active" : "Inactive"}</span>
              </div>
            </div>
            <div className="w-full sm:w-72">
              <Label className="mb-1 block text-xs font-medium">Search</Label>
              <SearchField
                value={m.articleSearch}
                onValueChange={m.setArticleSearch}
                placeholder="Search product name or code..."
                className="h-10 rounded-lg text-sm"
                data-testid="input-v5-edit-search"
                clearTestId="button-v5-edit-clear-search"
              />
            </div>
            <div className="w-full sm:w-56">
              <Label className="mb-1 block text-xs font-medium">Catalog</Label>
              <Select value={m.catalogFilter} onValueChange={m.setCatalogFilter}>
                <SelectTrigger className="h-10 rounded-lg" data-testid="select-v5-edit-catalog">
                  <SelectValue placeholder="All Catalogs" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All Catalogs</SelectItem>
                  {m.catalogCategories.map((category) => (
                    <SelectItem key={category} value={category}>
                      {category}
                    </SelectItem>
                  ))}
                  {m.articleRows.some((row) => !row.categoryName?.trim()) && (
                    <SelectItem value="__uncategorized__">Uncategorized</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mx-3 flex flex-wrap items-center gap-2 border-x border-b bg-card/70 px-3.5 py-3 sm:mx-5 sm:px-4">
            {m.zeroItemCount > 0 && (
              <div className="">
                <Button
                  size="default"
                  variant={m.showZeroItems ? "secondary" : "outline"}
                  onClick={() => m.setShowZeroItems((v) => !v)}
                  data-testid="button-edit-v5-toggle-zero"
                  className="h-9 rounded-full px-4 text-xs font-semibold"
                >
                  {m.showZeroItems ? `Hide 0-stock (${m.zeroItemCount})` : `Show 0-stock (${m.zeroItemCount})`}
                </Button>
              </div>
            )}

            {m.nonPositiveCount > 0 && (
              <div className="">
                <Button
                  size="default"
                  variant={m.hideNonPositive ? "default" : "outline"}
                  onClick={() => m.setHideNonPositive((v) => !v)}
                  data-testid="button-edit-v5-hide-non-positive"
                  className="h-9 rounded-full px-4 text-xs font-semibold"
                >
                  {m.hideNonPositive
                    ? `Show all (${m.nonPositiveCount} hidden)`
                    : `Hide 0 & negative (${m.nonPositiveCount})`}
                </Button>
              </div>
            )}

            {m.garbageWipersCount > 0 && (
              <div>
                <Button
                  size="default"
                  variant={m.showGarbageWipers ? "secondary" : "outline"}
                  onClick={() => m.setShowGarbageWipers((v) => !v)}
                  data-testid="button-edit-v5-toggle-garbage-wipers"
                  className="h-9 rounded-full px-4 text-xs font-semibold"
                >
                  {m.showGarbageWipers
                    ? `Hide Garbage/Wipers (${m.garbageWipersCount})`
                    : `Show Garbage/Wipers (${m.garbageWipersCount})`}
                </Button>
              </div>
            )}

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={m.appliedPrice === "sell" ? "secondary" : "outline"}
                onClick={m.applyCatalogSellingPrice}
                disabled={!m.productsQuery.data}
                data-testid="button-edit-v5-apply-sell-price"
                className={cn(
                  "h-9 rounded-full px-4 text-xs font-semibold",
                  m.appliedPrice === "sell" && "ring-2 ring-violet-500/40"
                )}
              >
                {m.appliedPrice === "sell" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
                Apply Sell Price
              </Button>
              <Button
                size="sm"
                variant={m.appliedPrice === "prod" ? "secondary" : "outline"}
                onClick={m.applyCatalogProductionPrice}
                disabled={!m.productsQuery.data}
                data-testid="button-edit-v5-apply-prod-price"
                className={cn(
                  "h-9 rounded-full px-4 text-xs font-semibold",
                  m.appliedPrice === "prod" && "ring-2 ring-violet-500/40"
                )}
              >
                {m.appliedPrice === "prod" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
                Apply Prod Price
              </Button>
              <Button
                size="sm"
                variant={m.appliedPrice === "customer" ? "secondary" : "outline"}
                onClick={m.applySavedAgreedPrices}
                disabled={
                  !m.initialized ||
                  m.customerPriceListQuery.isFetching ||
                  m.customerPriceListQuery.isError ||
                  !m.customerPriceListQuery.data?.length
                }
                data-testid="button-edit-v5-apply-customer-price"
                title={
                  m.customerPriceListQuery.isError
                    ? "Could not load saved agreed prices for this customer"
                    : m.customerPriceListQuery.data?.length
                      ? `Apply ${m.customerPriceListQuery.data.length} saved agreed price(s) for this customer`
                      : "No agreed prices saved for this customer yet"
                }
                className={cn(
                  "h-9 rounded-full px-4 text-xs font-semibold",
                  m.appliedPrice === "customer" && "ring-2 ring-violet-500/40"
                )}
              >
                {m.appliedPrice === "customer" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
                <BookmarkCheck className="h-3.5 w-3.5 mr-1.5" />
                Apply Saved Agreed Prices
                {m.customerPriceListQuery.data && m.customerPriceListQuery.data.length > 0 && (
                  <span className="ml-1 text-[11px] opacity-70">({m.customerPriceListQuery.data.length})</span>
                )}
              </Button>
            </div>
          </div>

          {/* Table */}
          <V5ProformaMobileLines
            variant="edit"
            rows={m.visibleRows}
            quantities={m.quantities}
            prices={m.prices}
            kgPrices={m.kgPrices}
            pricingModes={m.pricingModes}
            onQuantityChange={(code, value) => m.setQuantities((previous) => ({ ...previous, [code]: value }))}
            onPriceChange={(code, value) => m.setPrices((previous) => ({ ...previous, [code]: value }))}
            onKgPriceChange={(code, value) => m.setKgPrices((previous) => ({ ...previous, [code]: value }))}
            onModeChange={(code, value) => m.setPricingModes((previous) => ({ ...previous, [code]: value }))}
            weightPerBale={(code) => Number(m.map.get(code)?.weightPerBaleKg || 0)}
            shortageCount={(row, qty) => (qty > 0 && row.freeToPromise < 0 ? Math.abs(row.freeToPromise) : 0)}
            existingCodes={new Set(m.proformaQuery.data?.lines.map((line) => line.articleCode) ?? [])}
            onClear={(code) => m.setQuantities((previous) => ({ ...previous, [code]: "0" }))}
          />
          <EditProformaV5LinesTable m={m} />

          {/* Footer */}
          <div className="mx-3 mt-3 flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card/90 px-4 py-3 shadow-sm sm:mx-5">
            <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
              <span>
                <span className="font-semibold text-foreground">{m.filledLines}</span> line
                {m.filledLines !== 1 ? "s" : ""} visible
              </span>
              <span>
                <span className="font-semibold text-foreground">{m.totalQty}</span> visible bales
              </span>
              {m.totalKg > 0 && (
                <span>
                  <span className="font-semibold text-foreground">
                    {m.totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </span>{" "}
                  kg
                </span>
              )}
              {m.warningCount > 0 && (
                <span className="flex items-center gap-1 text-destructive">
                  <AlertTriangle className="h-3 w-3" />
                  {m.warningCount} product{m.warningCount !== 1 ? "s" : ""} with shortage
                </span>
              )}
              <span className="text-[11px] text-muted-foreground/60">Ctrl/⌘+S to save</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={m.onClose} data-testid="button-edit-v5-cancel">
                Cancel
              </Button>
              <Button
                onClick={() => m.saveMutation.mutate()}
                disabled={m.saveMutation.isPending || !m.proformaName.trim()}
                data-testid="button-edit-v5-save"
                className="bg-violet-600 text-white hover:bg-violet-700"
              >
                {m.saveMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
