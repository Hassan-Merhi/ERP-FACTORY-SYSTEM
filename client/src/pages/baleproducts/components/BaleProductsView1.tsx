import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { ChevronDown, ChevronRight, Pencil, X, EyeOff, Eye, AlertCircle, Palette, Search, Layers3 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "../components/EmptyState";
import type { useBaleProductsModel } from "../useBaleProductsModel";

type Model = ReturnType<typeof useBaleProductsModel>;
type BaleProduct = NonNullable<Model["activeProducts"]>[number];

function ProductColorPills({
  product,
  designColors,
  colorUpdateMutation,
  canEdit,
}: {
  product: BaleProduct;
  designColors: Model["designColors"];
  colorUpdateMutation: Model["colorUpdateMutation"];
  canEdit: boolean;
}) {
  const selectedColor = designColors.find((color) => color.value === product.labelDesignColor);
  const isUpdating = colorUpdateMutation.isPending && colorUpdateMutation.variables?.id === product.id;

  if (!canEdit) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        title={selectedColor?.label ?? product.labelDesignColor ?? "No Design"}
      >
        <span
          className="h-4 w-4 rounded-full border border-foreground/30"
          style={selectedColor ? { backgroundColor: selectedColor.color } : undefined}
        />
        {!selectedColor && !product.labelDesignColor ? "No Design" : null}
      </span>
    );
  }

  return (
    <div
      className="inline-flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label={`Label design color for ${product.name}`}
      data-testid={`product-color-pills-${product.id}`}
    >
      <button
        type="button"
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-foreground/30 bg-background text-muted-foreground hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${!product.labelDesignColor ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}
        title="No Design"
        aria-label={`No Design for ${product.name}`}
        aria-pressed={!product.labelDesignColor}
        disabled={colorUpdateMutation.isPending}
        onClick={() => {
          if (product.labelDesignColor) colorUpdateMutation.mutate({ id: product.id, labelDesignColor: null });
        }}
        data-testid={`quick-label-color-none-${product.id}`}
      >
        <X className="h-3 w-3" />
      </button>
      {designColors.map((color) => (
        <button
          key={color.value}
          type="button"
          className={`h-5 w-5 shrink-0 rounded-full border border-foreground/30 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${product.labelDesignColor === color.value ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""}`}
          style={{ backgroundColor: color.color }}
          title={color.label}
          aria-label={`Set ${product.name} label design to ${color.label}`}
          aria-pressed={product.labelDesignColor === color.value}
          disabled={colorUpdateMutation.isPending}
          onClick={() => {
            if (product.labelDesignColor !== color.value) {
              colorUpdateMutation.mutate({ id: product.id, labelDesignColor: color.value });
            }
          }}
          data-testid={`quick-label-color-${product.id}-${color.value}`}
        />
      ))}
      {isUpdating && <span className="text-xs text-muted-foreground">Saving...</span>}
      {product.labelDesignColor && !selectedColor && (
        <span className="text-xs text-muted-foreground" title="Saved design is not in the current color palette">
          {product.labelDesignColor}
        </span>
      )}
    </div>
  );
}

export function BaleProductsView1({ model }: { model: Model }) {
  const mhd = useFactoryMhdView();
  const {
    setCreateDialogOpen,
    designColors,
    colorUpdateMutation,
    condensedView,
    expandedGroups,
    setEditingProduct,
    selectedIds,
    setSelectedIds,
    showHidden,
    setShowHidden,
    showZeroPrice,
    setShowZeroPrice,
    showNoColor,
    setShowNoColor,
    filterCategoryId,
    setFilterCategoryId,
    filterWeight,
    setFilterWeight,
    searchQuery,
    setSearchQuery,
    isAdmin,
    hideAvgRate,
    hideSellingPriceBP,
    isLoading,
    categories,
    categoryMap,
    noColorCount,
    distinctWeights,
    activeProducts,
    hiddenProducts,
    toggleSelectId,
    toggleSelectAll,
    selectedActiveIds,
    selectedHiddenIds,
    bulkToggleActiveMutation,
    toggleGroup,
    groupedProducts,
    canChangeExistingRecords,
    canCreate,
  } = model;
  const canEditProducts = isAdmin && canChangeExistingRecords;
  const openCreateDialog = canCreate("POST", "/api/factory/bale-products")
    ? () => setCreateDialogOpen(true)
    : undefined;
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-sm dark:border-blue-400/20 dark:bg-[#111c2e]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/70 bg-gradient-to-r from-slate-50 via-white to-blue-50/60 px-4 py-4 dark:border-blue-300/15 dark:from-[#142444] dark:via-[#111e36] dark:to-[#101b31]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="flex items-center gap-2.5 text-base font-bold tracking-tight text-slate-900 dark:text-white">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400">
              <Layers3 className="h-5 w-5" />
            </span>
            Product List
          </span>
          {selectedIds.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground border-l pl-2">{selectedIds.size} selected</span>
              {canChangeExistingRecords && selectedActiveIds.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => bulkToggleActiveMutation.mutate({ ids: selectedActiveIds, active: false })}
                  disabled={bulkToggleActiveMutation.isPending}
                  data-testid="button-bulk-hide"
                >
                  <EyeOff className="h-3.5 w-3.5 mr-1" />
                  Hide ({selectedActiveIds.length})
                </Button>
              )}
              {canChangeExistingRecords && selectedHiddenIds.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => bulkToggleActiveMutation.mutate({ ids: selectedHiddenIds, active: true })}
                  disabled={bulkToggleActiveMutation.isPending}
                  data-testid="button-bulk-unhide"
                >
                  <Eye className="h-3.5 w-3.5 mr-1" />
                  Unhide ({selectedHiddenIds.length})
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setSelectedIds(new Set())}
                data-testid="button-clear-selection"
              >
                <X className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setSelectedIds(new Set());
              }}
              placeholder="Search by name or code..."
              className="h-9 w-56 rounded-xl border-slate-300 bg-white/90 pl-9 text-sm shadow-sm focus-visible:ring-blue-500 dark:border-blue-300/20 dark:bg-[#0d192c]"
              data-testid="input-search-products"
            />
            {searchQuery && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setSearchQuery("");
                  setSelectedIds(new Set());
                }}
                data-testid="button-clear-search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {categories && categories.length > 0 && (
            <Select
              value={filterCategoryId === null ? "all" : String(filterCategoryId)}
              onValueChange={(val) => {
                setFilterCategoryId(val === "all" ? null : Number(val));
                setSelectedIds(new Set());
              }}
            >
              <SelectTrigger
                className="h-9 w-40 rounded-xl border-slate-300 bg-white/90 text-sm shadow-sm dark:border-blue-300/20 dark:bg-[#0d192c]"
                data-testid="select-filter-category"
              >
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={String(cat.id)}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {distinctWeights.length > 0 && (
            <Select
              value={filterWeight === null ? "all" : filterWeight}
              onValueChange={(val) => {
                setFilterWeight(val === "all" ? null : val);
                setSelectedIds(new Set());
              }}
            >
              <SelectTrigger
                className="h-9 w-32 rounded-xl border-slate-300 bg-white/90 text-sm shadow-sm dark:border-blue-300/20 dark:bg-[#0d192c]"
                data-testid="select-filter-weight"
              >
                <SelectValue placeholder="All weights" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All weights</SelectItem>
                {distinctWeights.map((w) => (
                  <SelectItem key={w} value={w}>
                    {w} kg
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {(() => {
            const activeFilterCount =
              (showZeroPrice && !hideSellingPriceBP ? 1 : 0) +
              (showNoColor && noColorCount > 0 ? 1 : 0) +
              (showHidden && hiddenProducts && hiddenProducts.length > 0 ? 1 : 0);
            const hasAnyFilter =
              !hideSellingPriceBP || noColorCount > 0 || (hiddenProducts && hiddenProducts.length > 0);
            if (!hasAnyFilter) return null;
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant={activeFilterCount > 0 ? "default" : "outline"}
                    className="h-9 rounded-xl shadow-sm"
                    data-testid="button-filters-dropdown"
                  >
                    <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
                    Filters
                    {activeFilterCount > 0 && (
                      <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-xs no-default-active-elevate">
                        {activeFilterCount}
                      </Badge>
                    )}
                    <ChevronDown className="h-3 w-3 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">Show in list</DropdownMenuLabel>
                  {!hideSellingPriceBP && (
                    <DropdownMenuItem
                      onClick={() => {
                        setShowZeroPrice((v) => !v);
                        setSelectedIds(new Set());
                      }}
                      data-testid="menu-filter-unpriced"
                      className="flex items-center justify-between"
                    >
                      <span className="flex items-center gap-2">
                        <AlertCircle className="h-4 w-4 text-muted-foreground" />
                        Unpriced products
                      </span>
                      {showZeroPrice && <span className="text-xs text-primary font-medium">On</span>}
                    </DropdownMenuItem>
                  )}
                  {noColorCount > 0 && (
                    <DropdownMenuItem
                      onClick={() => {
                        setShowNoColor((v) => !v);
                        setSelectedIds(new Set());
                      }}
                      data-testid="menu-filter-no-color"
                      className="flex items-center justify-between"
                    >
                      <span className="flex items-center gap-2">
                        <Palette className="h-4 w-4 text-muted-foreground" />
                        No color ({noColorCount})
                      </span>
                      {showNoColor && <span className="text-xs text-primary font-medium">On</span>}
                    </DropdownMenuItem>
                  )}
                  {hiddenProducts && hiddenProducts.length > 0 && (
                    <DropdownMenuItem
                      onClick={() => {
                        setShowHidden(!showHidden);
                        setSelectedIds(new Set());
                      }}
                      data-testid="menu-filter-hidden"
                      className="flex items-center justify-between"
                    >
                      <span className="flex items-center gap-2">
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                        Hidden products ({hiddenProducts.length})
                      </span>
                      {showHidden && <span className="text-xs text-primary font-medium">On</span>}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })()}
        </div>
      </div>
      <div>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : condensedView ? (
          groupedProducts.length > 0 ? (
            <Table
              mobileLayout="cards"
              wrapperClassName="rounded-none border-x-0 border-b-0 border-t-0 shadow-inner shadow-slate-200/20 dark:shadow-blue-400/5"
              className="[&_tbody_tr:hover]:bg-blue-50/70 dark:[&_tbody_tr:hover]:bg-blue-500/10 [&_td]:border-slate-200/70 dark:[&_td]:border-blue-200/10 [&_th]:border-slate-200/80 dark:[&_th]:border-blue-200/10"
            >
              <TableHeader className="sticky top-0 z-30 bg-slate-100 dark:bg-[#1b2c4d]">
                <TableRow className="border-b border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-100 dark:border-blue-300/20 dark:bg-[#1b2c4d] dark:text-blue-100 dark:hover:bg-[#1b2c4d]">
                  <TableHead className="w-8"></TableHead>
                  <TableHead className="w-8"></TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Article Code
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Name
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Category
                  </TableHead>
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Wt/Bale (kg)
                  </TableHead>
                  {!hideAvgRate && (
                    <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Prod. Price
                    </TableHead>
                  )}
                  {!hideSellingPriceBP && (
                    <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      Sell Price
                    </TableHead>
                  )}
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Count
                  </TableHead>
                  <TableHead className="w-[60px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mhd
                  .sortRows(groupedProducts, (group) => group.articleCode)
                  .map((group) => (
                    <>
                      <TableRow
                        key={group._key}
                        className="cursor-pointer hover-elevate"
                        onClick={() => toggleGroup(group._key)}
                        data-testid={`row-group-${group._key}`}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={group.items.length > 0 && group.items.every((p) => selectedIds.has(p.id))}
                            onCheckedChange={() => toggleSelectAll(group.items)}
                          />
                        </TableCell>
                        <TableCell>
                          {expandedGroups.has(group._key) ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </TableCell>
                        <TableCell className="font-mono font-medium">{group.articleCode || "-"}</TableCell>
                        <TableCell className="font-medium">{mhd.nameFor(group.articleCode, group.name)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {group.items[0]?.categoryId ? categoryMap.get(group.items[0].categoryId) || "-" : "-"}
                        </TableCell>
                        {!hideAvgRate && <TableCell></TableCell>}
                        {!hideSellingPriceBP && <TableCell></TableCell>}
                        <TableCell className="text-right">
                          <Badge variant="secondary">{group.count}</Badge>
                        </TableCell>
                      </TableRow>
                      {expandedGroups.has(group._key) &&
                        mhd
                          .sortRows(group.items, (product) => product.articleCode)
                          .map((product) => (
                            <TableRow
                              key={product.id}
                              className={`bg-muted/30 ${selectedIds.has(product.id) ? "bg-muted/60" : ""}`}
                              data-testid={`row-product-${product.id}`}
                            >
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                <Checkbox
                                  checked={selectedIds.has(product.id)}
                                  onCheckedChange={() => toggleSelectId(product.id)}
                                  data-testid={`checkbox-product-${product.id}`}
                                />
                              </TableCell>
                              <TableCell></TableCell>
                              <TableCell className="font-mono text-muted-foreground text-sm pl-8">
                                {product.articleCode || "-"}
                              </TableCell>
                              <TableCell className="text-sm">
                                {mhd.nameFor(product.articleCode, product.name)}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {product.categoryId ? categoryMap.get(product.categoryId) || "-" : "-"}
                              </TableCell>
                              <TableCell className="text-right text-sm text-muted-foreground">
                                {product.weightPerBaleKg ? `${product.weightPerBaleKg} kg` : "-"}
                              </TableCell>
                              {!hideAvgRate && (
                                <TableCell className="text-right text-sm font-mono text-muted-foreground">
                                  {product.productionPrice && parseFloat(product.productionPrice) > 0
                                    ? parseFloat(product.productionPrice).toLocaleString()
                                    : "—"}
                                </TableCell>
                              )}
                              {!hideSellingPriceBP && (
                                <TableCell className="text-right text-sm font-mono text-muted-foreground">
                                  {product.sellingPrice && parseFloat(product.sellingPrice) > 0
                                    ? parseFloat(product.sellingPrice).toLocaleString()
                                    : "—"}
                                </TableCell>
                              )}
                              <TableCell></TableCell>
                              <TableCell>
                                {canEditProducts && (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setEditingProduct(product);
                                    }}
                                    data-testid={`button-edit-product-${product.id}`}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                    </>
                  ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState onCreateClick={openCreateDialog} />
          )
        ) : activeProducts && activeProducts.length > 0 ? (
          <Table
            mobileLayout="cards"
            wrapperClassName="rounded-none border-x-0 border-b-0 border-t-0 shadow-inner shadow-slate-200/20 dark:shadow-blue-400/5"
            className="[&_tbody_tr:hover]:bg-blue-50/70 dark:[&_tbody_tr:hover]:bg-blue-500/10 [&_td]:border-slate-200/70 dark:[&_td]:border-blue-200/10 [&_th]:border-slate-200/80 dark:[&_th]:border-blue-200/10"
          >
            <TableHeader className="sticky top-0 z-30 bg-slate-100 dark:bg-[#1b2c4d]">
              <TableRow className="border-b border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-100 dark:border-blue-300/20 dark:bg-[#1b2c4d] dark:text-blue-100 dark:hover:bg-[#1b2c4d]">
                <TableHead className="w-8">
                  <Checkbox
                    checked={activeProducts.length > 0 && activeProducts.every((p) => selectedIds.has(p.id))}
                    onCheckedChange={() => toggleSelectAll(activeProducts)}
                    data-testid="checkbox-select-all"
                  />
                </TableHead>
                <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Article Code
                </TableHead>
                <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Name
                </TableHead>
                <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Arabic Name
                </TableHead>
                <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Category
                </TableHead>
                <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Wt/Bale (kg)
                </TableHead>
                {!hideAvgRate && (
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Prod. Price
                  </TableHead>
                )}
                {!hideSellingPriceBP && (
                  <TableHead className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Sell Price
                  </TableHead>
                )}
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mhd
                .sortRows(activeProducts, (product) => product.articleCode)
                .map((product) => (
                  <TableRow
                    key={product.id}
                    data-testid={`row-product-${product.id}`}
                    className={selectedIds.has(product.id) ? "bg-blue-50/80 dark:bg-blue-500/15" : ""}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(product.id)}
                        onCheckedChange={() => toggleSelectId(product.id)}
                        data-testid={`checkbox-product-${product.id}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono font-semibold text-slate-800 dark:text-slate-100">
                      {product.articleCode || "-"}
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span>{mhd.nameFor(product.articleCode, product.name)}</span>
                        <ProductColorPills
                          product={product}
                          designColors={designColors}
                          colorUpdateMutation={colorUpdateMutation}
                          canEdit={canEditProducts}
                        />
                      </div>
                    </TableCell>
                    <TableCell
                      className="text-right font-medium text-slate-700 dark:text-slate-200"
                      dir="rtl"
                      lang="ar"
                    >
                      {product.nameAr || "—"}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex max-w-48 items-center rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 dark:border-blue-400/25 dark:bg-blue-500/15 dark:text-blue-200">
                        {product.categoryId ? categoryMap.get(product.categoryId) || "Uncategorized" : "Uncategorized"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold text-slate-800 dark:text-slate-100">
                      {product.weightPerBaleKg || "-"}
                    </TableCell>
                    {!hideAvgRate && (
                      <TableCell className="text-right font-mono font-semibold text-slate-800 dark:text-slate-100">
                        {product.productionPrice && parseFloat(product.productionPrice) > 0
                          ? parseFloat(product.productionPrice).toLocaleString()
                          : "—"}
                      </TableCell>
                    )}
                    {!hideSellingPriceBP && (
                      <TableCell className="text-right font-mono font-semibold text-slate-800 dark:text-slate-100">
                        {product.sellingPrice && parseFloat(product.sellingPrice) > 0
                          ? parseFloat(product.sellingPrice).toLocaleString()
                          : "—"}
                      </TableCell>
                    )}
                    <TableCell>
                      {canEditProducts && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => setEditingProduct(product)}
                          data-testid={`button-edit-product-${product.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState onCreateClick={openCreateDialog} />
        )}

        {showHidden && hiddenProducts && hiddenProducts.length > 0 && (
          <div className="border-t">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/10">
              <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Hidden Products ({hiddenProducts.length})
              </span>
            </div>
            <Table
              mobileLayout="cards"
              wrapperClassName="max-h-[400px] overflow-auto rounded-none border-x-0 border-b-0 dark:border-blue-400/10"
              className="[&_td]:border-slate-200/70 dark:[&_td]:border-blue-200/10"
            >
              <TableHeader className="sticky top-0 z-30 bg-slate-100 dark:bg-[#1b2c4d]">
                <TableRow className="border-b border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-100 dark:border-blue-300/20 dark:bg-[#1b2c4d] dark:text-blue-100 dark:hover:bg-[#1b2c4d]">
                  <TableHead className="w-8">
                    <Checkbox
                      checked={hiddenProducts.length > 0 && hiddenProducts.every((p) => selectedIds.has(p.id))}
                      onCheckedChange={() => toggleSelectAll(hiddenProducts)}
                      data-testid="checkbox-select-all-hidden"
                    />
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Article Code
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Name
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Category
                  </TableHead>
                  <TableHead className="w-[100px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hiddenProducts.map((product) => (
                  <TableRow
                    key={product.id}
                    className={selectedIds.has(product.id) ? "bg-blue-50/80 dark:bg-blue-500/15" : ""}
                    data-testid={`row-hidden-product-${product.id}`}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(product.id)}
                        onCheckedChange={() => toggleSelectId(product.id)}
                        data-testid={`checkbox-hidden-product-${product.id}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">{product.articleCode || "-"}</TableCell>
                    <TableCell className="text-muted-foreground">{product.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {product.categoryId ? categoryMap.get(product.categoryId) || "-" : "-"}
                    </TableCell>
                    <TableCell>
                      {canChangeExistingRecords && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => bulkToggleActiveMutation.mutate({ ids: [product.id], active: true })}
                          disabled={bulkToggleActiveMutation.isPending}
                          data-testid={`button-unhide-product-${product.id}`}
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          Unhide
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </section>
  );
}
