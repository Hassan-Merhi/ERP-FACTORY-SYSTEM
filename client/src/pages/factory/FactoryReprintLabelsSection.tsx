// Extracted from ./FactoryReprintLabels.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { CheckSquare, ChevronDown, Filter, Package, Printer, Search, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useFactoryReprintLabelsState } from "./useFactoryReprintLabelsState";

export function FactoryReprintLabelsSection({
  allFilteredSelected,
  articleCodeFilters,
  articleCodeSearch,
  articlePickerOpen,
  balesData,
  balesLoading,
  deselectAll,
  filteredBales,
  handlePrint,
  recordChanges,
  search,
  selectAll,
  selectedIds,
  setArticleCodeFilters,
  setArticleCodeSearch,
  setArticlePickerOpen,
  setSearch,
  toggleSelect,
  uniqueArticleCodes,
}: Pick<
  ReturnType<typeof useFactoryReprintLabelsState>,
  | "allFilteredSelected"
  | "articleCodeFilters"
  | "articleCodeSearch"
  | "articlePickerOpen"
  | "balesData"
  | "balesLoading"
  | "deselectAll"
  | "filteredBales"
  | "handlePrint"
  | "recordChanges"
  | "search"
  | "selectAll"
  | "selectedIds"
  | "setArticleCodeFilters"
  | "setArticleCodeSearch"
  | "setArticlePickerOpen"
  | "setSearch"
  | "toggleSelect"
  | "uniqueArticleCodes"
>) {
  return (
    <>
      {/* Search bar + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Filter by bale name or reference…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-bales"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              data-testid="button-clear-search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <Popover open={articlePickerOpen} onOpenChange={setArticlePickerOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="default" className="gap-2" data-testid="button-article-code-filter">
              <Filter className="h-4 w-4" />
              {articleCodeFilters.size === 0 ? "Article code" : `${articleCodeFilters.size} selected`}
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-2" align="start">
            <div className="relative mb-2">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Search article codes…"
                value={articleCodeSearch}
                onChange={(e) => setArticleCodeSearch(e.target.value)}
                className="pl-7 h-8 text-sm"
                data-testid="input-article-code-search"
              />
              {articleCodeSearch && (
                <button
                  onClick={() => setArticleCodeSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {articleCodeFilters.size > 0 && (
              <button
                onClick={() => setArticleCodeFilters(new Set())}
                className="text-xs text-muted-foreground hover:text-foreground mb-2 w-full text-left"
                data-testid="button-clear-article-filters"
              >
                Clear all ({articleCodeFilters.size})
              </button>
            )}

            <div className="max-h-52 overflow-y-auto space-y-0.5">
              {uniqueArticleCodes
                .filter((c) => !articleCodeSearch.trim() || searchAny(articleCodeSearch, c))
                .map((code) => (
                  <label
                    key={code}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-xs cursor-pointer hover-elevate text-sm"
                    data-testid={`option-article-${code}`}
                  >
                    <Checkbox
                      checked={articleCodeFilters.has(code)}
                      onCheckedChange={(checked) => {
                        setArticleCodeFilters((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(code);
                          else next.delete(code);
                          return next;
                        });
                      }}
                      data-testid={`checkbox-article-${code}`}
                    />
                    <span>{code}</span>
                  </label>
                ))}
              {uniqueArticleCodes.filter((c) => !articleCodeSearch.trim() || searchAny(articleCodeSearch, c)).length ===
                0 && <p className="text-sm text-muted-foreground text-center py-2">No article codes found</p>}
            </div>
          </PopoverContent>
        </Popover>

        <Button
          variant="outline"
          size="sm"
          onClick={allFilteredSelected ? deselectAll : selectAll}
          disabled={filteredBales.length === 0}
          data-testid="button-select-all"
        >
          {allFilteredSelected ? (
            <>
              <Square className="h-4 w-4 mr-1.5" /> Deselect All
            </>
          ) : (
            <>
              <CheckSquare className="h-4 w-4 mr-1.5" /> Select All
            </>
          )}
        </Button>

        {recordChanges.allowed && (
          <Button
            size="sm"
            onClick={handlePrint}
            disabled={selectedIds.size === 0 || balesLoading}
            data-testid="button-print-selected"
          >
            <Printer className="h-4 w-4 mr-1.5" />
            Print {selectedIds.size > 0 ? `${selectedIds.size} Label(s)` : "Selected"}
          </Button>
        )}
      </div>

      {/* Active article code filter chips */}
      {articleCodeFilters.size > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-muted-foreground">Filtering by:</span>
          {Array.from(articleCodeFilters).map((code) => (
            <Badge
              key={code}
              variant="secondary"
              className="gap-1 cursor-pointer"
              onClick={() =>
                setArticleCodeFilters((prev) => {
                  const next = new Set(prev);
                  next.delete(code);
                  return next;
                })
              }
              data-testid={`chip-article-${code}`}
            >
              {code}
              <X className="h-3 w-3" />
            </Badge>
          ))}
          <button
            onClick={() => setArticleCodeFilters(new Set())}
            className="text-xs text-muted-foreground hover:text-foreground"
            data-testid="button-clear-all-chips"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Bale list */}
      {balesLoading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : filteredBales.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">
          <Package className="h-8 w-8 mx-auto mb-2 opacity-40" />
          {balesData.length === 0 ? "No bales in stock at this location." : `No bales match "${search}".`}
        </Card>
      ) : (
        <>
          <div className="text-xs text-muted-foreground">
            Showing {filteredBales.length} of {balesData.length} bales
            {selectedIds.size > 0 && (
              <span className="ml-2 font-medium text-foreground">· {selectedIds.size} selected</span>
            )}
          </div>

          {/* Desktop table */}
          <div className="hidden sm:block rounded-md border overflow-x-auto">
            <table className="text-sm w-full">
              <thead className="sticky top-0 z-30 bg-muted">
                <tr className="h-10">
                  <th className="w-10 px-3"></th>
                  <th className="text-left px-3 font-medium">Reference No.</th>
                  <th className="text-left px-3 font-medium">Bale Name</th>
                  <th className="text-left px-3 font-medium">Article Code</th>
                  <th className="text-right px-3 font-medium">Weight (KG)</th>
                  <th className="text-right px-3 font-medium">Pcs</th>
                </tr>
              </thead>
              <tbody>
                {filteredBales.map((row) => {
                  const checked = selectedIds.has(row.bale.id);
                  const articleCode = row.product?.articleCode || row.bale.articleCode || row.bale.category || "-";
                  const prodName = row.bale.productName || row.product?.name || row.bale.category || "-";
                  return (
                    <tr
                      key={row.bale.id}
                      className={`border-t h-11 cursor-pointer transition-colors ${checked ? "bg-primary/5" : "hover:bg-muted/30"}`}
                      onClick={() => toggleSelect(row.bale.id)}
                      data-testid={`row-bale-${row.bale.id}`}
                    >
                      <td className="px-3 text-center">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleSelect(row.bale.id)}
                          data-testid={`checkbox-bale-${row.bale.id}`}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-3 font-mono text-xs text-muted-foreground">
                        {row.bale.referenceNumber || row.bale.baleCode}
                      </td>
                      <td className="px-3 font-medium">{prodName}</td>
                      <td className="px-3 font-mono text-xs text-muted-foreground">{articleCode}</td>
                      <td className="px-3 text-right font-mono">
                        {parseFloat(row.bale.weightKg).toLocaleString(undefined, {
                          minimumFractionDigits: 1,
                          maximumFractionDigits: 1,
                        })}
                      </td>
                      <td className="px-3 text-right font-mono">{row.bale.quantity}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="sm:hidden space-y-2">
            {filteredBales.map((row) => {
              const checked = selectedIds.has(row.bale.id);
              const articleCode = row.product?.articleCode || row.bale.articleCode || row.bale.category || "-";
              const prodName = row.bale.productName || row.product?.name || row.bale.category || "-";
              return (
                <Card
                  key={row.bale.id}
                  className={`p-3 cursor-pointer transition-colors ${checked ? "ring-2 ring-primary" : ""}`}
                  onClick={() => toggleSelect(row.bale.id)}
                  data-testid={`card-bale-${row.bale.id}`}
                >
                  <div className="flex items-start gap-2">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleSelect(row.bale.id)}
                      data-testid={`checkbox-bale-mobile-${row.bale.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{prodName}</div>
                      <div className="text-xs text-muted-foreground font-mono mt-0.5">
                        {row.bale.referenceNumber || row.bale.baleCode}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span>{articleCode}</span>
                        <span>
                          {parseFloat(row.bale.weightKg).toLocaleString(undefined, {
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 1,
                          })}{" "}
                          KG
                        </span>
                        <span>{row.bale.quantity} pc(s)</span>
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
