import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookmarkCheck, CheckCircle2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type EditProformaAppliedPrice = "sell" | "prod" | "customer" | null;

interface Props {
  proformaName: string;
  setProformaName: (value: string) => void;
  destination: string;
  onDestinationChange: (value: string) => void;
  hasSavedDestination: boolean;
  isActive: boolean;
  setIsActive: (value: boolean) => void;
  articleSearch: string;
  setArticleSearch: (value: string) => void;
  catalogFilter: string;
  setCatalogFilter: (value: string) => void;
  catalogCategories: string[];
  hasUncategorized: boolean;
  zeroItemCount: number;
  nonPositiveCount: number;
  garbageWipersCount: number;
  showZeroItems: boolean;
  hideNonPositive: boolean;
  showGarbageWipers: boolean;
  onToggleZeroItems: () => void;
  onToggleHideNonPositive: () => void;
  onToggleGarbageWipers: () => void;
  appliedPrice: EditProformaAppliedPrice;
  catalogLoaded: boolean;
  canApplySavedPrices: boolean;
  savedPricesTitle: string;
  savedPriceCount: number;
  onApplySellPrice: () => void;
  onApplyProductionPrice: () => void;
  onApplySavedPrices: () => void;
}

/** Header fields, search, catalog filter and the price/visibility toggles of the Edit Proforma V5 drawer. */
export function EditProformaV5Toolbar({
  proformaName,
  setProformaName,
  destination,
  onDestinationChange,
  hasSavedDestination,
  isActive,
  setIsActive,
  articleSearch,
  setArticleSearch,
  catalogFilter,
  setCatalogFilter,
  catalogCategories,
  hasUncategorized,
  zeroItemCount,
  nonPositiveCount,
  garbageWipersCount,
  showZeroItems,
  hideNonPositive,
  showGarbageWipers,
  onToggleZeroItems,
  onToggleHideNonPositive,
  onToggleGarbageWipers,
  appliedPrice,
  catalogLoaded,
  canApplySavedPrices,
  savedPricesTitle,
  savedPriceCount,
  onApplySellPrice,
  onApplyProductionPrice,
  onApplySavedPrices,
}: Props) {
  return (
    <>
      <div className="mx-3 flex flex-wrap items-end gap-4 rounded-t-xl border bg-card/70 p-3.5 shadow-sm sm:mx-5 sm:p-4">
        <div className="flex flex-col gap-1.5 min-w-[200px] flex-1">
          <Label htmlFor="edit-v5-proforma-name" className="text-xs font-medium">
            Proforma Name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="edit-v5-proforma-name"
            data-testid="input-edit-v5-proforma-name"
            value={proformaName}
            onChange={(e) => setProformaName(e.target.value)}
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
            value={destination}
            onChange={(e) => onDestinationChange(e.target.value)}
            placeholder="e.g. L'SHI, MALI, KINSHASA"
            list="edit-proforma-destination-suggestions"
          />
          <datalist id="edit-proforma-destination-suggestions">
            <option value="L'SHI" />
            <option value="MALI" />
            <option value="KINSHASA" />
          </datalist>
          {!hasSavedDestination && (
            <p className="text-xs text-muted-foreground">
              Old proforma: assign its destination here. Existing prices are preserved until you explicitly apply
              destination prices.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium">Status</Label>
          <div className="flex items-center gap-2 h-9">
            <Switch checked={isActive} onCheckedChange={setIsActive} data-testid="switch-edit-v5-proforma-active" />
            <span className="text-sm text-muted-foreground">{isActive ? "Active" : "Inactive"}</span>
          </div>
        </div>

        <div className="relative w-full sm:w-72">
          <Label className="mb-1 block text-xs font-medium">Search</Label>
          <Search className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-muted-foreground" />
          <Input
            value={articleSearch}
            onChange={(event) => setArticleSearch(event.target.value)}
            placeholder="Search product name or code..."
            className="h-10 rounded-lg pl-9 pr-8 text-sm"
            data-testid="input-v5-edit-search"
          />
          {articleSearch && (
            <button
              type="button"
              onClick={() => setArticleSearch("")}
              className="absolute bottom-3 right-3 text-muted-foreground hover:text-foreground"
              data-testid="button-v5-edit-clear-search"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="w-full sm:w-56">
          <Label className="mb-1 block text-xs font-medium">Catalog</Label>
          <Select value={catalogFilter} onValueChange={setCatalogFilter}>
            <SelectTrigger className="h-10 rounded-lg" data-testid="select-v5-edit-catalog">
              <SelectValue placeholder="All Catalogs" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Catalogs</SelectItem>
              {catalogCategories.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
              {hasUncategorized && <SelectItem value="__uncategorized__">Uncategorized</SelectItem>}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="mx-3 flex flex-wrap items-center gap-2 border-x border-b bg-card/70 px-3.5 py-3 sm:mx-5 sm:px-4">
        {zeroItemCount > 0 && (
          <div className="">
            <Button
              size="default"
              variant={showZeroItems ? "secondary" : "outline"}
              onClick={onToggleZeroItems}
              data-testid="button-edit-v5-toggle-zero"
              className="h-9 rounded-full px-4 text-xs font-semibold"
            >
              {showZeroItems ? `Hide 0-stock (${zeroItemCount})` : `Show 0-stock (${zeroItemCount})`}
            </Button>
          </div>
        )}

        {nonPositiveCount > 0 && (
          <div className="">
            <Button
              size="default"
              variant={hideNonPositive ? "default" : "outline"}
              onClick={onToggleHideNonPositive}
              data-testid="button-edit-v5-hide-non-positive"
              className="h-9 rounded-full px-4 text-xs font-semibold"
            >
              {hideNonPositive ? `Show all (${nonPositiveCount} hidden)` : `Hide 0 & negative (${nonPositiveCount})`}
            </Button>
          </div>
        )}

        {garbageWipersCount > 0 && (
          <div>
            <Button
              size="default"
              variant={showGarbageWipers ? "secondary" : "outline"}
              onClick={onToggleGarbageWipers}
              data-testid="button-edit-v5-toggle-garbage-wipers"
              className="h-9 rounded-full px-4 text-xs font-semibold"
            >
              {showGarbageWipers
                ? `Hide Garbage/Wipers (${garbageWipersCount})`
                : `Show Garbage/Wipers (${garbageWipersCount})`}
            </Button>
          </div>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={appliedPrice === "sell" ? "secondary" : "outline"}
            onClick={onApplySellPrice}
            disabled={!catalogLoaded}
            data-testid="button-edit-v5-apply-sell-price"
            className={cn(
              "h-9 rounded-full px-4 text-xs font-semibold",
              appliedPrice === "sell" && "ring-2 ring-violet-500/40"
            )}
          >
            {appliedPrice === "sell" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
            Apply Sell Price
          </Button>
          <Button
            size="sm"
            variant={appliedPrice === "prod" ? "secondary" : "outline"}
            onClick={onApplyProductionPrice}
            disabled={!catalogLoaded}
            data-testid="button-edit-v5-apply-prod-price"
            className={cn(
              "h-9 rounded-full px-4 text-xs font-semibold",
              appliedPrice === "prod" && "ring-2 ring-violet-500/40"
            )}
          >
            {appliedPrice === "prod" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
            Apply Prod Price
          </Button>
          <Button
            size="sm"
            variant={appliedPrice === "customer" ? "secondary" : "outline"}
            onClick={onApplySavedPrices}
            disabled={!canApplySavedPrices}
            data-testid="button-edit-v5-apply-customer-price"
            title={savedPricesTitle}
            className={cn(
              "h-9 rounded-full px-4 text-xs font-semibold",
              appliedPrice === "customer" && "ring-2 ring-violet-500/40"
            )}
          >
            {appliedPrice === "customer" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
            <BookmarkCheck className="h-3.5 w-3.5 mr-1.5" />
            Apply Saved Agreed Prices
            {savedPriceCount > 0 && <span className="ml-1 text-[11px] opacity-70">({savedPriceCount})</span>}
          </Button>
        </div>
      </div>
    </>
  );
}
