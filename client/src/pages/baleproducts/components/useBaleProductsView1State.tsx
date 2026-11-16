// Extracted from ./BaleProductsView1.tsx to keep that module under the source-size cap.
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { X } from "lucide-react";
import { TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { useBaleProductsModel } from "../useBaleProductsModel";

export type Model = ReturnType<typeof useBaleProductsModel>;

type BaleProduct = NonNullable<Model["activeProducts"]>[number];

export function ProductColorPills({
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

export function useBaleProductsView1State({ model }: { model: Model }) {
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
  return {
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
  };
}

export function BaleProductsView1TableHeaderSection({
  hideAvgRate,
  hideSellingPriceBP,
}: Pick<ReturnType<typeof useBaleProductsView1State>, "hideAvgRate" | "hideSellingPriceBP">) {
  return (
    <TableHeader className="sticky top-0 z-30 bg-slate-100 dark:bg-[#1b2c4d]">
      <TableRow className="border-b border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-100 dark:border-blue-300/20 dark:bg-[#1b2c4d] dark:text-blue-100 dark:hover:bg-[#1b2c4d]">
        <TableHead className="w-8"></TableHead>
        <TableHead className="w-8"></TableHead>
        <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Article Code
        </TableHead>
        <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Name</TableHead>
        <TableHead className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Category</TableHead>
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
  );
}
