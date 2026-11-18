import { ChevronDown, ChevronRight, Pencil, EyeOff, Eye } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "../components/EmptyState";
import {
  BaleProductsView1TableHeaderSection,
  ProductColorPills,
  useBaleProductsView1State,
  type Model,
} from "./useBaleProductsView1State";
import { BaleProductsView1Section } from "./BaleProductsView1Section";

export function BaleProductsView1(props: { model: Model }) {
  const {
    activeProducts,
    bulkToggleActiveMutation,
    canChangeExistingRecords,
    canEditProducts,
    categories,
    categoryMap,
    colorUpdateMutation,
    condensedView,
    designColors,
    distinctWeights,
    expandedGroups,
    filterCategoryId,
    filterWeight,
    groupedProducts,
    hiddenProducts,
    hideAvgRate,
    hideSellingPriceBP,
    isLoading,
    mhd,
    noColorCount,
    openCreateDialog,
    searchQuery,
    selectedActiveIds,
    selectedHiddenIds,
    selectedIds,
    setEditingProduct,
    setFilterCategoryId,
    setFilterWeight,
    setSearchQuery,
    setSelectedIds,
    setShowHidden,
    setShowNoColor,
    setShowZeroPrice,
    showHidden,
    showNoColor,
    showZeroPrice,
    toggleGroup,
    toggleSelectAll,
    toggleSelectId,
  } = useBaleProductsView1State(props);
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-sm dark:border-blue-400/20 dark:bg-[#111c2e]">
      {/* Toolbar */}
      <BaleProductsView1Section
        bulkToggleActiveMutation={bulkToggleActiveMutation}
        canChangeExistingRecords={canChangeExistingRecords}
        categories={categories}
        distinctWeights={distinctWeights}
        filterCategoryId={filterCategoryId}
        filterWeight={filterWeight}
        hiddenProducts={hiddenProducts}
        hideSellingPriceBP={hideSellingPriceBP}
        noColorCount={noColorCount}
        searchQuery={searchQuery}
        selectedActiveIds={selectedActiveIds}
        selectedHiddenIds={selectedHiddenIds}
        selectedIds={selectedIds}
        setFilterCategoryId={setFilterCategoryId}
        setFilterWeight={setFilterWeight}
        setSearchQuery={setSearchQuery}
        setSelectedIds={setSelectedIds}
        setShowHidden={setShowHidden}
        setShowNoColor={setShowNoColor}
        setShowZeroPrice={setShowZeroPrice}
        showHidden={showHidden}
        showNoColor={showNoColor}
        showZeroPrice={showZeroPrice}
      />
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
              <BaleProductsView1TableHeaderSection hideAvgRate={hideAvgRate} hideSellingPriceBP={hideSellingPriceBP} />
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
