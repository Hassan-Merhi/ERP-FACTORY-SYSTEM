import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import {
  Plus,
  Package,
  Upload,
  Download,
  ChevronDown,
  ChevronRight,
  Tags,
  Pencil,
  Trash2,
  X,
  FileSpreadsheet,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { CreateBaleProductDialog } from "../components/CreateBaleProductDialog";
import { AdminAuthDialog } from "@/components/AdminAuthDialog";
import { useBaleProductsModel } from "./baleproducts/useBaleProductsModel";
import { BaleProductsDialog1 } from "./baleproducts/components/BaleProductsDialog1";
import { BaleProductsDialog2 } from "./baleproducts/components/BaleProductsDialog2";
import { BaleProductsView1 } from "./baleproducts/components/BaleProductsView1";

export default function BaleProducts() {
  const model = useBaleProductsModel();
  const {
    designColors: _designColors,
    createDialogOpen,
    setCreateDialogOpen,
    adminAuthOpen,
    setAdminAuthOpen,
    pendingAdminAuth,
    setPendingAdminAuth,
    importDialogOpen: _importDialogOpen,
    setImportDialogOpen: _setImportDialogOpen,
    importPreview: _importPreview,
    setImportPreview: _setImportPreview,
    importError: _importError,
    setImportFile: _setImportFile,
    condensedView: _condensedView,
    expandedGroups: _expandedGroups,
    showCategories,
    setShowCategories,
    expandedCategories,
    setExpandedCategories,
    newCategoryName,
    setNewCategoryName,
    editingCategory,
    setEditingCategory,
    editingProduct: _editingProduct,
    setEditingProduct: _setEditingProduct,
    editForm: _editForm,
    setEditForm: _setEditForm,
    pendingDelete,
    setPendingDelete,
    selectedIds: _selectedIds,
    setSelectedIds: _setSelectedIds,
    showHidden: _showHidden,
    setShowHidden: _setShowHidden,
    showZeroPrice: _showZeroPrice,
    setShowZeroPrice: _setShowZeroPrice,
    showNoColor: _showNoColor,
    setShowNoColor: _setShowNoColor,
    filterCategoryId: _filterCategoryId,
    setFilterCategoryId: _setFilterCategoryId,
    filterWeight: _filterWeight,
    setFilterWeight: _setFilterWeight,
    searchQuery: _searchQuery,
    setSearchQuery: _setSearchQuery,
    fileInputRef,
    isAdmin,
    hideAvgRate,
    hideSellingPriceBP,
    products,
    isLoading: _isLoading,
    categories,
    categoryMap: _categoryMap,
    noColorCount: _noColorCount,
    distinctWeights: _distinctWeights,
    activeProducts: _activeProducts,
    hiddenProducts: _hiddenProducts,
    toggleSelectId: _toggleSelectId,
    toggleSelectAll: _toggleSelectAll,
    selectedActiveIds: _selectedActiveIds,
    selectedHiddenIds: _selectedHiddenIds,
    createCategoryMutation,
    updateCategoryMutation,
    deleteCategoryMutation,
    importMutation: _importMutation,
    editProductMutation: _editProductMutation,
    colorUpdateMutation: _colorUpdateMutation,
    deleteProductMutation: _deleteProductMutation,
    bulkToggleActiveMutation: _bulkToggleActiveMutation,
    handleEditSubmit: _handleEditSubmit,
    handleExportExcel,
    handleExportNoPrices,
    handleDownloadTemplate,
    handleFileSelect,
    handleConfirmImport: _handleConfirmImport,
    toggleGroup: _toggleGroup,
    groupedProducts: _groupedProducts,
  } = model;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.csv"
        className="hidden"
        onChange={handleFileSelect}
        data-testid="input-import-file"
      />

      {/* ── Page header ── */}
      <div className="rounded-xl border overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Package className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-base font-semibold leading-tight">Bale Products</h1>
              <p className="text-xs text-muted-foreground">Manage product types for bale production</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {isAdmin && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" data-testid="button-actions-menu">
                    Actions
                    <ChevronDown className="h-3 w-3 ml-2" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">Categories</DropdownMenuLabel>
                  <DropdownMenuItem
                    onClick={() => setShowCategories(!showCategories)}
                    data-testid="menu-manage-categories"
                  >
                    <Tags className="h-4 w-4 mr-2" />
                    {showCategories ? "Hide Categories" : "Manage Categories"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs text-muted-foreground">Make Your Order</DropdownMenuLabel>
                  <DropdownMenuItem
                    onClick={() => handleExportExcel("selling")}
                    data-testid="menu-export-selling-price"
                  >
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    Selling Price
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExportExcel("production")}
                    data-testid="menu-export-production-price"
                  >
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    Production Price
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportNoPrices} data-testid="menu-export-no-prices">
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    No Prices
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs text-muted-foreground">Import / Template</DropdownMenuLabel>
                  <DropdownMenuItem onClick={handleDownloadTemplate} data-testid="menu-download-template">
                    <Download className="h-4 w-4 mr-2" />
                    Download Template
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => fileInputRef.current?.click()} data-testid="menu-import-excel">
                    <Upload className="h-4 w-4 mr-2" />
                    Import Excel
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button
              onClick={() => {
                if (isAdmin) {
                  setCreateDialogOpen(true);
                } else {
                  setAdminAuthOpen(true);
                }
              }}
              data-testid="button-create-product"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Product
            </Button>
          </div>
        </div>
      </div>

      {showCategories && (
        <div className="rounded-xl border overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
            <Tags className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold text-sm">Product Categories</span>
          </div>
          <div className="px-4 py-4 space-y-4">
            <div className="flex gap-2">
              <Input
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="New category name..."
                data-testid="input-new-category"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newCategoryName.trim()) {
                    createCategoryMutation.mutate(newCategoryName.trim());
                  }
                }}
              />
              <Button
                onClick={() => {
                  if (newCategoryName.trim()) createCategoryMutation.mutate(newCategoryName.trim());
                }}
                disabled={!newCategoryName.trim() || createCategoryMutation.isPending}
                data-testid="button-add-category"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add
              </Button>
            </div>
            {categories && categories.length > 0 ? (
              <div className="space-y-1">
                {categories.map((cat) => {
                  const catProducts = (products ?? []).filter((p) => p.categoryId === cat.id);
                  const isExpanded = expandedCategories.has(cat.id);
                  return (
                    <div key={cat.id} className="rounded-md border overflow-hidden">
                      {/* Category header row */}
                      <div className="flex items-center justify-between gap-2 p-2 bg-muted/30">
                        {editingCategory?.id === cat.id ? (
                          <div className="flex items-center gap-2 flex-1">
                            <Input
                              value={editingCategory.name}
                              onChange={(e) => setEditingCategory({ ...editingCategory, name: e.target.value })}
                              data-testid={`input-edit-category-${cat.id}`}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && editingCategory.name.trim()) {
                                  updateCategoryMutation.mutate({ id: cat.id, name: editingCategory.name.trim() });
                                }
                                if (e.key === "Escape") setEditingCategory(null);
                              }}
                            />
                            <Button
                              size="sm"
                              onClick={() =>
                                updateCategoryMutation.mutate({ id: cat.id, name: editingCategory.name.trim() })
                              }
                              disabled={!editingCategory.name.trim()}
                              data-testid={`button-save-category-${cat.id}`}
                            >
                              Save
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => setEditingCategory(null)}>
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ) : (
                          <>
                            <button
                              className="flex items-center gap-2 flex-1 text-left min-w-0"
                              onClick={() =>
                                setExpandedCategories((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(cat.id)) next.delete(cat.id);
                                  else next.add(cat.id);
                                  return next;
                                })
                              }
                              data-testid={`button-expand-category-${cat.id}`}
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                              )}
                              <span className="font-medium" data-testid={`text-category-${cat.id}`}>
                                {cat.name}
                              </span>
                              {!cat.isActive && <Badge variant="outline">Inactive</Badge>}
                              <span className="text-xs text-muted-foreground ml-1">({catProducts.length})</span>
                            </button>
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setEditingCategory({ id: cat.id, name: cat.name })}
                                data-testid={`button-edit-category-${cat.id}`}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setPendingDelete(() => () => deleteCategoryMutation.mutate(cat.id))}
                                data-testid={`button-delete-category-${cat.id}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </>
                        )}
                      </div>

                      {/* Expanded products list */}
                      {isExpanded && (
                        <div className="border-t">
                          {catProducts.length === 0 ? (
                            <p className="text-xs text-muted-foreground px-4 py-2">No products in this category.</p>
                          ) : (
                            <table className="w-full text-sm">
                              <thead className="sticky top-0 z-30 bg-muted/50">
                                <tr className="border-b bg-muted/10">
                                  <th className="text-left px-4 py-1.5 text-xs font-medium text-muted-foreground">
                                    Code
                                  </th>
                                  <th className="text-left px-4 py-1.5 text-xs font-medium text-muted-foreground">
                                    Name
                                  </th>
                                  {!hideAvgRate && (
                                    <th className="text-right px-4 py-1.5 text-xs font-medium text-muted-foreground">
                                      Prod. Price
                                    </th>
                                  )}
                                  {!hideSellingPriceBP && (
                                    <th className="text-right px-4 py-1.5 text-xs font-medium text-muted-foreground">
                                      Sell Price
                                    </th>
                                  )}
                                  <th className="text-right px-4 py-1.5 text-xs font-medium text-muted-foreground">
                                    Wt/Bale
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {catProducts.map((p) => (
                                  <tr
                                    key={p.id}
                                    className="border-b last:border-0 hover-elevate"
                                    data-testid={`row-cat-product-${p.id}`}
                                  >
                                    <td className="px-4 py-1.5 font-mono text-xs text-muted-foreground">
                                      {p.articleCode}
                                    </td>
                                    <td className="px-4 py-1.5 font-medium">
                                      {p.name}
                                      {p.active === false && (
                                        <Badge variant="outline" className="ml-2 text-xs">
                                          Hidden
                                        </Badge>
                                      )}
                                    </td>
                                    {!hideAvgRate && (
                                      <td className="px-4 py-1.5 text-right tabular-nums text-xs">
                                        {parseFloat(p.productionPrice || "0") > 0 ? (
                                          `$${parseFloat(p.productionPrice!).toFixed(2)}`
                                        ) : (
                                          <span className="text-muted-foreground">—</span>
                                        )}
                                      </td>
                                    )}
                                    {!hideSellingPriceBP && (
                                      <td className="px-4 py-1.5 text-right tabular-nums text-xs">
                                        {parseFloat(p.sellingPrice || "0") > 0 ? (
                                          `$${parseFloat(p.sellingPrice!).toFixed(2)}`
                                        ) : (
                                          <span className="text-muted-foreground">—</span>
                                        )}
                                      </td>
                                    )}
                                    <td className="px-4 py-1.5 text-right tabular-nums text-xs text-muted-foreground">
                                      {p.weightPerBaleKg ? `${p.weightPerBaleKg} kg` : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No categories yet. Create one above.</p>
            )}
          </div>
        </div>
      )}

      {/* ── Product List ── */}
      <BaleProductsView1 model={model} />

      <CreateBaleProductDialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) setPendingAdminAuth(null);
        }}
        adminAuth={pendingAdminAuth}
      />

      <AdminAuthDialog
        open={adminAuthOpen}
        onOpenChange={(open) => {
          setAdminAuthOpen(open);
        }}
        action="create a new bale product"
        onAuthorized={(credentials) => {
          setPendingAdminAuth(credentials);
          setAdminAuthOpen(false);
          setCreateDialogOpen(true);
        }}
      />

      <BaleProductsDialog1 model={model} />

      <BaleProductsDialog2 model={model} />
      <DeleteConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          pendingDelete?.();
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
