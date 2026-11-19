// Extracted from ./FactoryPriceList.tsx
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Check, X, Pencil, RefreshCw } from "lucide-react";
import { useFactoryPriceListState } from "./useFactoryPriceListState";
import { formatUsd } from "@/lib/moneyDisplay";

export function FactoryPriceListTable({
  categoryMap,
  editingCell,
  filteredProducts,
  handleKeyDown,
  handleSave,
  handleStartEdit,
  inputRef,
  mhd,
  recordChanges,
  setEditingCell,
  updatePriceMutation,
}: Pick<
  ReturnType<typeof useFactoryPriceListState>,
  | "categoryMap"
  | "editingCell"
  | "filteredProducts"
  | "handleKeyDown"
  | "handleSave"
  | "handleStartEdit"
  | "inputRef"
  | "mhd"
  | "recordChanges"
  | "setEditingCell"
  | "updatePriceMutation"
>) {
  return (
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
          const sellingIsEditing = editingCell?.productId === product.id && editingCell.field === "sellingPrice";
          const productionIsEditing = editingCell?.productId === product.id && editingCell.field === "productionPrice";
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
                    <span className={`font-mono font-medium ${sellingPrice > 0 ? "" : "text-muted-foreground"}`}>
                      {sellingPrice > 0 ? formatUsd(sellingPrice, 2) : "—"}
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
                      {productionPrice > 0 ? formatUsd(productionPrice, 2) : "—"}
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
  );
}
