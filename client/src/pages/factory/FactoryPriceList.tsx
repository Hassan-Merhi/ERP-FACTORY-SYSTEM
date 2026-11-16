import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, X, Pencil, Tag, RefreshCw, AlertCircle, Download, Upload } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { useFactoryPriceListState } from "./useFactoryPriceListState";

export default function FactoryPriceList() {
  const {
    categories,
    categoryFilter,
    categoryMap,
    downloadTemplate,
    editingCell,
    fileInputRef,
    filteredProducts,
    handleKeyDown,
    handleSave,
    handleStartEdit,
    handleUpload,
    inputRef,
    isLoading,
    isUploading,
    mhd,
    products,
    recordChanges,
    search,
    setCategoryFilter,
    setEditingCell,
    setSearch,
    setShowZeroOnly,
    showZeroOnly,
    totalActive,
    updatePriceMutation,
    updatedCount,
  } = useFactoryPriceListState();

  return (
    <div className="flex flex-col h-full p-3 sm:p-6 space-y-4 sm:space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={handleUpload}
        data-testid="input-price-upload-file"
      />

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 flex-wrap">
        <div>
          <PageHeader title="Factory Price List" subtitle="Set selling prices for bale products." />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary" data-testid="text-price-coverage">
            {updatedCount} / {totalActive} priced
          </Badge>
          <Button
            variant="outline"
            onClick={downloadTemplate}
            disabled={isLoading || products.length === 0}
            className="gap-2"
            data-testid="button-download-price-template"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Download Template</span>
            <span className="sm:hidden">Template</span>
          </Button>
          {recordChanges.allowed && (
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="gap-2"
              data-testid="button-upload-price-excel"
            >
              {isUploading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              <span className="hidden sm:inline">{isUploading ? "Uploading…" : "Upload Prices"}</span>
              <span className="sm:hidden">{isUploading ? "…" : "Upload"}</span>
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <SearchField
          value={search}
          onValueChange={setSearch}
          placeholder="Search..."
          wrapperClassName="flex-1 min-w-[160px]"
          data-testid="input-search"
        />
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[150px] sm:w-[180px]" data-testid="select-category-filter">
            <SelectValue placeholder="All Categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={showZeroOnly ? "default" : "outline"}
          onClick={() => setShowZeroOnly((v) => !v)}
          className="gap-2 whitespace-nowrap"
          data-testid="button-show-zero-price-only"
        >
          <AlertCircle className="h-4 w-4" />
          <span className="hidden sm:inline">{showZeroOnly ? "Showing unpriced" : "Show unpriced"}</span>
          <span className="sm:hidden">Unpriced</span>
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Tag className="h-4 w-4" />
            Product Prices
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredProducts.length > 0 ? (
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead className="hidden sm:table-cell">Article Code</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="hidden sm:table-cell">Category</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">Kg / Bale</TableHead>
                  <TableHead className="text-right">Sell Price</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">Prod. Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredProducts.map((product) => {
                  const sellingIsEditing =
                    editingCell?.productId === product.id && editingCell.field === "sellingPrice";
                  const productionIsEditing =
                    editingCell?.productId === product.id && editingCell.field === "productionPrice";
                  const sellingPrice = parseFloat(product.sellingPrice || "0");
                  const productionPrice = parseFloat(product.productionPrice || "0");

                  return (
                    <TableRow key={product.id} data-testid={`row-product-${product.id}`}>
                      <TableCell
                        className="font-mono text-sm hidden sm:table-cell"
                        data-testid={`text-article-code-${product.id}`}
                      >
                        {product.articleCode || product.code || "—"}
                      </TableCell>
                      <TableCell className="font-medium" data-testid={`text-product-name-${product.id}`}>
                        <div>{mhd.nameFor(product.articleCode, product.name)}</div>
                        {/* Mobile-only: show article code + category inline */}
                        <div className="sm:hidden flex flex-wrap items-center gap-1.5 mt-0.5">
                          {(product.articleCode || product.code) && (
                            <span className="font-mono text-xs text-muted-foreground">
                              {product.articleCode || product.code}
                            </span>
                          )}
                          {product.categoryId && (
                            <Badge variant="outline" className="text-xs">
                              {categoryMap.get(product.categoryId) || "—"}
                            </Badge>
                          )}
                          {product.weightPerBaleKg && (
                            <span className="text-xs text-muted-foreground">
                              {parseFloat(product.weightPerBaleKg).toFixed(1)} kg/bale
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {product.categoryId ? (
                          <Badge variant="outline">{categoryMap.get(product.categoryId) || "—"}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground hidden sm:table-cell">
                        {product.weightPerBaleKg ? `${parseFloat(product.weightPerBaleKg).toFixed(1)} kg` : "—"}
                      </TableCell>

                      {/* Selling Price Cell */}
                      <TableCell className="text-right">
                        {sellingIsEditing ? (
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              ref={inputRef}
                              type="number"
                              min="0"
                              step="0.01"
                              value={editingCell.value}
                              onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                              onKeyDown={handleKeyDown}
                              disabled={updatePriceMutation.isPending}
                              className="w-24 text-right font-mono"
                              data-testid={`input-selling-price-${product.id}`}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleSave()}
                              disabled={updatePriceMutation.isPending}
                              data-testid={`button-save-selling-${product.id}`}
                            >
                              {updatePriceMutation.isPending ? (
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Check className="h-3.5 w-3.5 text-green-600" />
                              )}
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setEditingCell(null)}
                              data-testid={`button-cancel-selling-${product.id}`}
                            >
                              <X className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        ) : (
                          <div
                            className={`flex items-center justify-end gap-2 group rounded-md px-2 py-1 ${recordChanges.allowed ? "cursor-pointer hover-elevate" : ""}`}
                            onClick={() => handleStartEdit(product, "sellingPrice")}
                            data-testid={`cell-selling-price-${product.id}`}
                          >
                            <span
                              className={`font-mono font-medium ${sellingPrice > 0 ? "" : "text-muted-foreground"}`}
                            >
                              {sellingPrice > 0 ? `$${sellingPrice.toFixed(2)}` : "—"}
                            </span>
                            {recordChanges.allowed && (
                              <Pencil className="h-3 w-3 text-muted-foreground opacity-60 md:opacity-0 md:group-hover:opacity-100 touch:opacity-100" />
                            )}
                          </div>
                        )}
                      </TableCell>

                      {/* Production Cost Cell — hidden on mobile, tap sell price row to edit */}
                      <TableCell className="text-right hidden sm:table-cell">
                        {productionIsEditing ? (
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              ref={inputRef}
                              type="number"
                              min="0"
                              step="0.01"
                              value={editingCell.value}
                              onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                              onKeyDown={handleKeyDown}
                              disabled={updatePriceMutation.isPending}
                              className="w-24 text-right font-mono"
                              data-testid={`input-production-price-${product.id}`}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleSave()}
                              disabled={updatePriceMutation.isPending}
                              data-testid={`button-save-production-${product.id}`}
                            >
                              {updatePriceMutation.isPending ? (
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Check className="h-3.5 w-3.5 text-green-600" />
                              )}
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setEditingCell(null)}
                              data-testid={`button-cancel-production-${product.id}`}
                            >
                              <X className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        ) : (
                          <div
                            className={`flex items-center justify-end gap-2 group rounded-md px-2 py-1 ${recordChanges.allowed ? "cursor-pointer hover-elevate" : ""}`}
                            onClick={() => handleStartEdit(product, "productionPrice")}
                            data-testid={`cell-production-price-${product.id}`}
                          >
                            <span className={`font-mono text-sm text-muted-foreground`}>
                              {productionPrice > 0 ? `$${productionPrice.toFixed(2)}` : "—"}
                            </span>
                            {recordChanges.allowed && (
                              <Pencil className="h-3 w-3 text-muted-foreground opacity-60 md:opacity-0 md:group-hover:opacity-100 touch:opacity-100" />
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-12">
              <Tag className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No products found</h3>
              <p className="text-muted-foreground mt-2 text-sm">
                {showZeroOnly
                  ? "All products have a selling price set."
                  : search || categoryFilter !== "all"
                    ? "Try adjusting your filters."
                    : "Add bale products to see them here."}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="rounded-md bg-muted/50 border p-4 text-sm text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">How prices work:</p>
        <p>
          Selling prices set here are the catalog prices used across proformas when you click "Apply Catalog Prices."
        </p>
        <p>On each proforma line you can lock the price — locked lines are skipped when applying catalog prices.</p>
        <p>Production cost is used for profitability reports and is not shown to customers.</p>
      </div>
    </div>
  );
}
