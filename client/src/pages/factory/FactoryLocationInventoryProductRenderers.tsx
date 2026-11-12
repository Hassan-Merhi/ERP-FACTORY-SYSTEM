import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Package, Trash2, Tag } from "lucide-react";
import type { FactoryBaleProduct } from "./factorylocationinventory/types";
import { catColor } from "./factorylocationinventory/utils";
import type { useFactoryLocationInventory } from "./FactoryLocationInventoryModel";

type FactoryLocationInventoryModel = ReturnType<typeof useFactoryLocationInventory>;

export function createFactoryLocationProductRenderers(
  inventory: FactoryLocationInventoryModel,
  nameFor: (articleCode: string | null | undefined, originalName: string) => string
) {
  const {
    canChangeExistingRecords,
    canReprint,
    fmt,
    formatAmount,
    handleReprintProduct,
    hideSellingPrice,
    hiddenColumns,
    myAccess,
    navigate,
    proformaMode,
    selectedLocation,
    selections,
    setDeleteDialogOpen,
    setDeleteProduct,
    setDeleteQty,
    toggleSelection,
    updateSelectionPrice,
    updateSelectionQty,
  } = inventory;
  const col = (key: string) => !hiddenColumns.has(key);
  const renderProductRow = (prod: FactoryBaleProduct, testIdSuffix = "") => {
    const weightPerBale = prod.baleCount > 0 ? prod.totalWeight / prod.baleCount : 0;
    const isSelected = selections.has(prod.productId);
    const selection = selections.get(prod.productId);
    return (
      <tr
        key={prod.productId}
        className={`inventory-product-row border-t h-12 ${proformaMode && isSelected ? "bg-primary/5" : ""}`}
        data-testid={`row-product${testIdSuffix}-${prod.productId}`}
      >
        {proformaMode && (
          <td className="px-2 text-center">
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => toggleSelection(prod)}
              data-testid={`checkbox-product${testIdSuffix}-${prod.productId}`}
            />
          </td>
        )}
        <td className="px-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() =>
                !proformaMode && navigate(`/factory/bale-product-history/${prod.productId}/${selectedLocation?.id}`)
              }
              className={`text-left font-medium leading-snug ${proformaMode ? "" : "hover:underline cursor-pointer"}`}
              data-testid={`link-product${testIdSuffix}-${prod.productId}`}
            >
              {nameFor(prod.articleCode, prod.productName)}
            </button>
            {prod.isInactive && (
              <Badge variant="outline" className="text-xs text-muted-foreground no-default-active-elevate">
                Inactive
              </Badge>
            )}
          </div>
          {prod.articleCode && <div className="text-xs text-muted-foreground font-mono mt-0.5">{prod.articleCode}</div>}
        </td>
        {col("category") && (
          <td className="px-3">
            <Badge
              variant="outline"
              className={`inventory-category-badge text-xs font-medium no-default-active-elevate whitespace-nowrap ${catColor(prod.category)}`}
            >
              {prod.category || "Uncategorized"}
            </Badge>
          </td>
        )}
        <td className="text-right px-3 font-mono whitespace-nowrap">
          <span>{prod.baleCount - (prod.loadingCount ?? 0)}</span>
        </td>
        {proformaMode && (
          <td className="text-right px-3">
            {isSelected && selection ? (
              <Input
                type="number"
                value={selection.selectedQty}
                onChange={(e) => updateSelectionQty(prod.productId, e.target.value)}
                className="w-[70px] text-right ml-auto"
                min={1}
                data-testid={`input-qty${testIdSuffix}-${prod.productId}`}
              />
            ) : (
              <span className="text-muted-foreground">-</span>
            )}
          </td>
        )}
        {proformaMode && (
          <td className="text-right px-3">
            {isSelected && selection ? (
              <Input
                type="number"
                value={selection.pricePerBale}
                onChange={(e) => updateSelectionPrice(prod.productId, e.target.value)}
                className="w-[90px] text-right ml-auto"
                step="0.01"
                data-testid={`input-price${testIdSuffix}-${prod.productId}`}
              />
            ) : (
              <span className="text-muted-foreground">-</span>
            )}
          </td>
        )}
        {col("avg_kg") && <td className="text-right px-3 font-mono">{fmt(weightPerBale)}</td>}
        {!hideSellingPrice && col("sell_price") && (
          <td className="text-right px-3 font-mono">{formatAmount(parseFloat(prod.sellingPrice || "0"))}</td>
        )}
        {!hideSellingPrice && col("sell_value") && (
          <td className="text-right px-3 font-mono">
            {formatAmount((prod.baleCount - (prod.loadingCount ?? 0)) * parseFloat(prod.sellingPrice || "0"))}
          </td>
        )}
        {!hideSellingPrice && col("cost_price") && (
          <td className="text-right px-3 font-mono">{formatAmount(prod.productionPrice)}</td>
        )}
        {!hideSellingPrice && col("cost_value") && (
          <td className="text-right px-3 font-mono">
            {formatAmount((prod.baleCount - (prod.loadingCount ?? 0)) * prod.productionPrice)}
          </td>
        )}
        {col("total_kg") && <td className="text-right px-3 font-mono">{fmt(prod.totalWeight)}</td>}
        {!proformaMode && col("actions") && (
          <td className="px-1 text-center">
            <div className="flex items-center justify-center gap-0.5">
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                title="View details"
                onClick={() => navigate(`/factory/bale-product-history/${prod.productId}/${selectedLocation?.id}`)}
                data-testid={`button-view-details${testIdSuffix}-${prod.productId}`}
              >
                <Package className="h-3.5 w-3.5" />
              </Button>
              {canReprint && myAccess?.fullAccess && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  title="Print barcodes"
                  onClick={() => handleReprintProduct(prod)}
                  data-testid={`button-print-barcodes${testIdSuffix}-${prod.productId}`}
                >
                  <Tag className="h-3.5 w-3.5" />
                </Button>
              )}
              {canChangeExistingRecords && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive"
                  title="Remove bales"
                  onClick={() => {
                    setDeleteProduct(prod);
                    setDeleteQty(1);
                    setDeleteDialogOpen(true);
                  }}
                  data-testid={`button-delete-product${testIdSuffix}-${prod.productId}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </td>
        )}
      </tr>
    );
  };

  const renderMobileCard = (prod: FactoryBaleProduct, testIdSuffix = "") => {
    const weightPerBale = prod.baleCount > 0 ? prod.totalWeight / prod.baleCount : 0;
    const isSelected = selections.has(prod.productId);
    const selection = selections.get(prod.productId);
    return (
      <div
        key={prod.productId}
        className={`inventory-mobile-card rounded-xl border p-3 ${proformaMode && isSelected ? "ring-2 ring-primary border-primary" : ""}`}
        data-testid={`card-product${testIdSuffix}-${prod.productId}`}
      >
        <div className="flex items-center gap-2 mb-2">
          {proformaMode && (
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => toggleSelection(prod)}
              data-testid={`checkbox-mobile${testIdSuffix}-${prod.productId}`}
            />
          )}
          <Package className="h-4 w-4 text-muted-foreground" />
          <button
            onClick={() =>
              !proformaMode && navigate(`/factory/bale-product-history/${prod.productId}/${selectedLocation?.id}`)
            }
            className={`text-left font-medium flex-1 ${proformaMode ? "" : "text-primary hover:underline cursor-pointer"}`}
            data-testid={`link-mobile${testIdSuffix}-${prod.productId}`}
          >
            {nameFor(prod.articleCode, prod.productName)}
          </button>
          {prod.isInactive && (
            <Badge variant="outline" className="text-xs text-muted-foreground no-default-active-elevate shrink-0">
              Inactive
            </Badge>
          )}
          {!proformaMode && (
            <div className="flex items-center gap-0.5 ml-auto">
              {canReprint && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => handleReprintProduct(prod)}
                  data-testid={`button-reprint-mobile${testIdSuffix}-${prod.productId}`}
                >
                  <Tag className="h-3.5 w-3.5" />
                </Button>
              )}
              {canChangeExistingRecords && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive"
                  onClick={() => {
                    setDeleteProduct(prod);
                    setDeleteQty(1);
                    setDeleteDialogOpen(true);
                  }}
                  data-testid={`button-delete-mobile${testIdSuffix}-${prod.productId}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <span>{prod.articleCode}</span>
          {prod.category && <span>| {prod.category}</span>}
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-muted-foreground">Bales: </span>
            <span className="font-mono">{prod.baleCount - (prod.loadingCount ?? 0)}</span>
          </div>
          <div className="text-right">
            <span className="text-muted-foreground">Wt/Bale: </span>
            <span className="font-mono">{fmt(weightPerBale)} KG</span>
          </div>
          <div>
            <span className="text-muted-foreground">Total KG: </span>
            <span className="font-mono">{fmt(prod.totalWeight)}</span>
          </div>
          {!hideSellingPrice && (
            <div className="text-right">
              <span className="text-muted-foreground">Sell Value: </span>
              <span className="font-mono font-medium">
                {formatAmount((prod.baleCount - (prod.loadingCount ?? 0)) * parseFloat(prod.sellingPrice || "0"))}
              </span>
            </div>
          )}
        </div>
        {proformaMode && isSelected && selection && (
          <div className="mt-2 pt-2 border-t flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">Qty:</span>
            <Input
              type="number"
              value={selection.selectedQty}
              onChange={(e) => updateSelectionQty(prod.productId, e.target.value)}
              className="w-20 text-right"
              min={1}
              data-testid={`input-qty-mobile${testIdSuffix}-${prod.productId}`}
            />
            <span className="text-xs text-muted-foreground">/ {prod.baleCount}</span>
            <span className="text-xs text-muted-foreground ml-2">Price:</span>
            <Input
              type="number"
              value={selection.pricePerBale}
              onChange={(e) => updateSelectionPrice(prod.productId, e.target.value)}
              className="w-24 text-right"
              step="0.01"
              data-testid={`input-price-mobile${testIdSuffix}-${prod.productId}`}
            />
          </div>
        )}
      </div>
    );
  };
  return { renderProductRow, renderMobileCard };
}
