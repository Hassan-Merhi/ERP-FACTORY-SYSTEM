import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import { PageHeader } from "@/components/PageHeader";
import {
  Plus,
  Package,
  Upload,
  Download,
  ChevronDown,
  ChevronRight,
  Layers3,
  Archive,
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
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { BaleProductsDialog1 } from "./baleproducts/components/BaleProductsDialog1";
import { BaleProductsDialog2 } from "./baleproducts/components/BaleProductsDialog2";
import { BaleProductsView1 } from "./baleproducts/components/BaleProductsView1";

/** Standalone route entry. Route components receive router props, so the hub uses `BaleProductsContent` directly. */
export default function BaleProducts() {
  return <BaleProductsContent />;
}

/** `embedded` hides the page title when rendered as the Bale Products tab of the Bales hub. */
export function BaleProductsContent({ embedded = false }: { embedded?: boolean }) {
  const model = useBaleProductsModel();
  const mhd = useFactoryMhdView();
  const {
    createDialogOpen,
    setCreateDialogOpen,
    adminAuthOpen,
    setAdminAuthOpen,
    pendingAdminAuth,
    setPendingAdminAuth,
    showCategories,
    setShowCategories,
    expandedCategories,
    setExpandedCategories,
    newCategoryName,
    setNewCategoryName,
    editingCategory,
    setEditingCategory,
    pendingDelete,
    setPendingDelete,
    fileInputRef,
    isAdmin,
    hideAvgRate,
    hideSellingPriceBP,
    products,
    categories,
    createCategoryMutation,
    updateCategoryMutation,
    deleteCategoryMutation,
    handleExportExcel,
    handleExportNoPrices,
    handleDownloadTemplate,
    handleFileSelect,
    canChangeExistingRecords,
    canCreate,
  } = model;
  const canCreateCategory = canCreate("POST", "/api/factory/categories");

  const canCreateProduct = canCreate("POST", "/api/factory/bale-products");
  const headerActions = (isAdmin || canCreateProduct) && (
    <>
      {isAdmin && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="border-slate-300 bg-white/80 shadow-sm dark:border-blue-300/30 dark:bg-[#172a4e]/80"
              data-testid="button-actions-menu"
            >
              Actions
              <ChevronDown className="h-3 w-3 ml-2" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Categories</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => setShowCategories(!showCategories)} data-testid="menu-manage-categories">
              <Tags className="h-4 w-4 mr-2" />
              {showCategories ? "Hide Categories" : "Manage Categories"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Make Your Order</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => handleExportExcel("selling")} data-testid="menu-export-selling-price">
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
            {canChangeExistingRecords && (
              <DropdownMenuItem onClick={() => fileInputRef.current?.click()} data-testid="menu-import-excel">
                <Upload className="h-4 w-4 mr-2" />
                Import Excel
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {canCreateProduct && (
        <Button
          onClick={() => {
            if (isAdmin) {
              setCreateDialogOpen(true);
            } else {
              setAdminAuthOpen(true);
            }
          }}
          data-testid="button-create-product"
          className="bg-blue-600 text-white shadow-md shadow-blue-500/20 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
        >
          <Plus className="h-4 w-4 mr-2" />
          Create Product
        </Button>
      )}
    </>
  );

  return (
    <div className="container mx-auto max-w-none space-y-5 px-3 py-4 sm:px-6 sm:py-6" data-bale-products-modern="true">
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.csv"
        className="hidden"
        onChange={handleFileSelect}
        data-testid="input-import-file"
      />

      {/* ── Page header ── */}
      {embedded ? (
        headerActions && <div className="flex flex-wrap items-center justify-end gap-2">{headerActions}</div>
      ) : (
        <PageHeader
          title="Bale Products"
          subtitle="Manage product types for bale production"
          icon={<Package className="h-5 w-5" aria-hidden="true" />}
        >
          {headerActions}
        </PageHeader>
      )}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          {
            label: "Total Products",
            value: products?.length ?? 0,
            icon: Package,
            style:
              "border-blue-200 bg-blue-50/80 text-blue-700 dark:border-blue-400/25 dark:bg-blue-500/15 dark:text-blue-200",
          },
          {
            label: "Categories",
            value: categories?.length ?? 0,
            icon: Tags,
            style:
              "border-violet-200 bg-violet-50/80 text-violet-700 dark:border-violet-400/25 dark:bg-violet-500/15 dark:text-violet-200",
          },
          {
            label: "Active Products",
            value: (products ?? []).filter((product) => product.active !== false).length,
            icon: Layers3,
            style:
              "border-emerald-200 bg-emerald-50/80 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-500/15 dark:text-emerald-200",
          },
          {
            label: "Hidden Products",
            value: (products ?? []).filter((product) => product.active === false).length,
            icon: Archive,
            style:
              "border-amber-200 bg-amber-50/80 text-amber-700 dark:border-amber-400/25 dark:bg-amber-500/15 dark:text-amber-200",
          },
        ].map(({ label, value, icon: Icon, style }) => (
          <div key={label} className={`flex min-w-0 items-center gap-3 rounded-xl border px-3 py-3 shadow-sm ${style}`}>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-current/15 bg-white/50 dark:bg-white/5">
              <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[11px] font-medium opacity-80">{label}</p>
              <p className="text-xl font-bold leading-tight tabular-nums">{value.toLocaleString()}</p>
            </div>
          </div>
        ))}
      </div>

      {showCategories && (
        <div className="rounded-xl border overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
            <Tags className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold text-sm">Product Categories</span>
          </div>
          <div className="px-4 py-4 space-y-4">
            {canCreateCategory && (
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
            )}
            {categories && categories.length > 0 ? (
              <div className="space-y-1">
                {categories.map((cat) => {
                  const catProducts = mhd.sortRows(
                    (products ?? []).filter((p) => p.categoryId === cat.id),
                    (p) => p.articleCode
                  );
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
                            {canChangeExistingRecords && (
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
                            )}
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
                              <thead className="sticky top-0 z-30 bg-muted">
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
                                      {mhd.nameFor(p.articleCode, p.name)}
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
