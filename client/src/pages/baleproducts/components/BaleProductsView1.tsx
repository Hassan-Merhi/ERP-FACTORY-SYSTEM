import { ChevronDown, ChevronRight, Pencil, X, EyeOff, Eye, AlertCircle, Palette, Search } from "lucide-react";
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
export function BaleProductsView1({ model }: { model: Model }) {
  const {
    setCreateDialogOpen,
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
    products: _products,
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
  } = model;
  return (
    <div className="rounded-xl border overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b bg-muted/20 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm">Product List</span>
          {selectedIds.size > 0 && (
            <>
              <span className="text-xs text-muted-foreground border-l pl-2">{selectedIds.size} selected</span>
              {selectedActiveIds.length > 0 && (
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
              {selectedHiddenIds.length > 0 && (
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
              className="pl-8 w-52 h-8 text-sm"
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
              <SelectTrigger className="w-40 h-8 text-sm" data-testid="select-filter-category">
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
              <SelectTrigger className="w-32 h-8 text-sm" data-testid="select-filter-weight">
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
                    className="h-8"
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
            <Table mobileLayout="cards" wrapperClassName="max-h-[calc(100vh-320px)] overflow-auto">
              <TableHeader className="sticky top-0 z-30">
                <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
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
                {groupedProducts.map((group) => (
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
                      <TableCell className="font-medium">{group.name}</TableCell>
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
                      group.items.map((product) => (
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
                          <TableCell className="text-sm">{product.name}</TableCell>
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
                            {isAdmin && (
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
            <EmptyState onCreateClick={() => setCreateDialogOpen(true)} />
          )
        ) : activeProducts && activeProducts.length > 0 ? (
          <Table mobileLayout="cards" wrapperClassName="max-h-[calc(100vh-320px)] overflow-auto">
            <TableHeader className="sticky top-0 z-30">
              <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
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
              {activeProducts.map((product) => (
                <TableRow
                  key={product.id}
                  data-testid={`row-product-${product.id}`}
                  className={selectedIds.has(product.id) ? "bg-muted/50" : ""}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(product.id)}
                      onCheckedChange={() => toggleSelectId(product.id)}
                      data-testid={`checkbox-product-${product.id}`}
                    />
                  </TableCell>
                  <TableCell className="font-mono font-medium">{product.articleCode || "-"}</TableCell>
                  <TableCell className="font-medium">{product.name}</TableCell>
                  <TableCell className="font-medium text-right" dir="rtl" lang="ar">
                    {product.nameAr || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {product.categoryId ? categoryMap.get(product.categoryId) || "Uncategorized" : "Uncategorized"}
                  </TableCell>
                  <TableCell className="text-right font-mono">{product.weightPerBaleKg || "-"}</TableCell>
                  {!hideAvgRate && (
                    <TableCell className="text-right font-mono">
                      {product.productionPrice && parseFloat(product.productionPrice) > 0
                        ? parseFloat(product.productionPrice).toLocaleString()
                        : "—"}
                    </TableCell>
                  )}
                  {!hideSellingPriceBP && (
                    <TableCell className="text-right font-mono">
                      {product.sellingPrice && parseFloat(product.sellingPrice) > 0
                        ? parseFloat(product.sellingPrice).toLocaleString()
                        : "—"}
                    </TableCell>
                  )}
                  <TableCell>
                    {isAdmin && (
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
          <EmptyState onCreateClick={() => setCreateDialogOpen(true)} />
        )}

        {showHidden && hiddenProducts && hiddenProducts.length > 0 && (
          <div className="border-t">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/10">
              <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Hidden Products ({hiddenProducts.length})
              </span>
            </div>
            <Table mobileLayout="cards" wrapperClassName="max-h-[400px] overflow-auto">
              <TableHeader className="sticky top-0 z-30">
                <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
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
                    className={selectedIds.has(product.id) ? "bg-muted/50" : ""}
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
