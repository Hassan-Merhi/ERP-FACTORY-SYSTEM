import { SearchField } from "@/components/ui/search-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tag, RefreshCw, AlertCircle, Download, Upload } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { useFactoryPriceListState } from "./useFactoryPriceListState";
import { EmptyState, ErrorState } from "@/components/ui/page-state";
import { FactoryPriceListTable } from "./FactoryPriceListTable";

export default function FactoryPriceList() {
  const {
    refetchProducts,
    productsError,
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
          ) : productsError && products.length === 0 ? (
            <ErrorState
              onAction={() => void refetchProducts()}
              actionLabel="Try again"
              className="rounded-none border-0"
            />
          ) : filteredProducts.length > 0 ? (
            <FactoryPriceListTable
              categoryMap={categoryMap}
              editingCell={editingCell}
              filteredProducts={filteredProducts}
              handleKeyDown={handleKeyDown}
              handleSave={handleSave}
              handleStartEdit={handleStartEdit}
              inputRef={inputRef}
              mhd={mhd}
              recordChanges={recordChanges}
              setEditingCell={setEditingCell}
              updatePriceMutation={updatePriceMutation}
            />
          ) : (
            <EmptyState
              icon={Tag}
              title="No products found"
              description={
                showZeroOnly
                  ? "All products have a selling price set."
                  : search || categoryFilter !== "all"
                    ? "Try adjusting your filters."
                    : "Add bale products to see them here."
              }
              className="rounded-none border-0"
            />
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
