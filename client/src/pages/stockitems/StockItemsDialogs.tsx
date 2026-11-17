import { CombinedImportDialog } from "@/components/CombinedImportDialog";
import { StockItemCreateDialog } from "@/components/StockItemCreateDialog";
import { StockItemDetailsDialog } from "@/components/StockItemDetailsDialog";
import { StockItemEditDialog } from "@/components/StockItemEditDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/page-state";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, Layers, MinusCircle, Pencil, Plus, PlusCircle, Tag, Trash2, X } from "lucide-react";

import type { useStockItems } from "./useStockItems";

type StockItemsModel = ReturnType<typeof useStockItems>;

export function StockItemsDialogs({ stockItems }: { stockItems: StockItemsModel }) {
  const {
    selectedStockItemId,
    selectedStockItemName,
    detailsDialogOpen,
    setDetailsDialogOpen,
    editDialogOpen,
    setEditDialogOpen,
    editStockItemId,
    createDialogOpen,
    setCreateDialogOpen,
    selectedIds,
    deleteDialogOpen,
    setDeleteDialogOpen,
    importDialogOpen,
    setImportDialogOpen,
    assignCategoryDialogOpen,
    setAssignCategoryDialogOpen,
    pendingCategoryId,
    setPendingCategoryId,
    adjustDialogOpen,
    setAdjustDialogOpen,
    adjustStockItemId,
    setAdjustStockItemId,
    adjustLocationId,
    setAdjustLocationId,
    adjustQuantity,
    setAdjustQuantity,
    adjustType,
    setAdjustType,
    manageGradesOpen,
    setManageGradesOpen,
    newGradeName,
    setNewGradeName,
    editingGradeId,
    setEditingGradeId,
    editingGradeName,
    setEditingGradeName,
    manageCategoriesOpen,
    setManageCategoriesOpen,
    newCategoryName,
    setNewCategoryName,
    editingCategoryId,
    setEditingCategoryId,
    editingCategoryName,
    setEditingCategoryName,
    allStockItems,
    stockGrades,
    stockCategories,
    locations,
    deleteMutation,
    adjustStockMutation,
    assignCategoryMutation,
    createGradeMutation,
    updateGradeMutation,
    deleteGradeMutation,
    createCategoryMutation,
    updateCategoryMutation,
    deleteCategoryMutation,
    handleAdjustStock,
  } = stockItems;

  return (
    <>
      <StockItemDetailsDialog
        open={detailsDialogOpen && !!selectedStockItemId}
        onOpenChange={setDetailsDialogOpen}
        stockItemId={selectedStockItemId ?? 0}
        stockItemName={selectedStockItemName}
      />
      <StockItemEditDialog open={editDialogOpen} onOpenChange={setEditDialogOpen} stockItemId={editStockItemId} />
      <StockItemCreateDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
      <CombinedImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent data-testid="dialog-confirm-delete">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Deletion</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {selectedIds.length} stock {selectedIds.length === 1 ? "item" : "items"}?
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                deleteMutation.mutate(selectedIds);
                setDeleteDialogOpen(false);
              }}
              className="bg-destructive hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={assignCategoryDialogOpen} onOpenChange={setAssignCategoryDialogOpen}>
        <DialogContent data-testid="dialog-assign-category">
          <DialogHeader>
            <DialogTitle>Assign Category</DialogTitle>
            <DialogDescription>
              Choose a category to assign to the {selectedIds.length} selected{" "}
              {selectedIds.length === 1 ? "item" : "items"}.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label className="mb-2 block">Category</Label>
            <Select value={pendingCategoryId} onValueChange={setPendingCategoryId}>
              <SelectTrigger data-testid="select-assign-category">
                <SelectValue placeholder="Select a category..." />
              </SelectTrigger>
              <SelectContent>
                {stockCategories.map((category) => (
                  <SelectItem key={category.id} value={category.id.toString()}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAssignCategoryDialogOpen(false)}
              data-testid="button-cancel-assign-category"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const categoryId = pendingCategoryId === "" ? null : parseInt(pendingCategoryId);
                assignCategoryMutation.mutate({ ids: selectedIds, categoryId });
              }}
              disabled={pendingCategoryId === "" || assignCategoryMutation.isPending}
              data-testid="button-confirm-assign-category"
            >
              {assignCategoryMutation.isPending ? "Saving..." : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={adjustDialogOpen} onOpenChange={setAdjustDialogOpen}>
        <DialogContent data-testid="dialog-adjust-stock">
          <DialogHeader>
            <DialogTitle>Adjust Stock Manually</DialogTitle>
            <DialogDescription>Add or subtract quantity from a stock item at a specific location</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Stock Item</Label>
              <Select value={adjustStockItemId} onValueChange={setAdjustStockItemId}>
                <SelectTrigger data-testid="select-adjust-stock-item">
                  <SelectValue placeholder="Select stock item..." />
                </SelectTrigger>
                <SelectContent>
                  {allStockItems.map((item) => (
                    <SelectItem key={item.id} value={item.id.toString()}>
                      {item.code} - {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Location</Label>
              <Select value={adjustLocationId} onValueChange={setAdjustLocationId}>
                <SelectTrigger data-testid="select-adjust-location">
                  <SelectValue placeholder="Select location..." />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((location) => (
                    <SelectItem key={location.id} value={location.id.toString()}>
                      {location.code} - {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Adjustment Type</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={adjustType === "add" ? "default" : "outline"}
                  className="flex-1 gap-2"
                  onClick={() => setAdjustType("add")}
                  data-testid="button-adjust-add"
                >
                  <PlusCircle className="h-4 w-4" /> Add (+)
                </Button>
                <Button
                  type="button"
                  variant={adjustType === "subtract" ? "destructive" : "outline"}
                  className="flex-1 gap-2"
                  onClick={() => setAdjustType("subtract")}
                  data-testid="button-adjust-subtract"
                >
                  <MinusCircle className="h-4 w-4" /> Subtract (-)
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Quantity</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={adjustQuantity}
                onChange={(event) => setAdjustQuantity(event.target.value)}
                placeholder="Enter quantity..."
                data-testid="input-adjust-quantity"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustDialogOpen(false)} data-testid="button-adjust-cancel">
              Cancel
            </Button>
            <Button
              onClick={handleAdjustStock}
              disabled={adjustStockMutation.isPending}
              data-testid="button-adjust-confirm"
            >
              {adjustStockMutation.isPending ? "Adjusting..." : `${adjustType === "add" ? "Add" : "Subtract"} Stock`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={manageGradesOpen} onOpenChange={setManageGradesOpen}>
        <DialogContent className="max-w-md" data-testid="dialog-manage-grades">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="h-4 w-4" /> Manage Grades
            </DialogTitle>
            <DialogDescription>Add, rename, or remove stock grades.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2 max-h-72 overflow-y-auto pr-1">
            {stockGrades.length === 0 && <EmptyState title="No grades yet. Add one below." className="min-h-0 py-4" />}
            {stockGrades.map((grade) => (
              <div key={grade.id} className="flex items-center gap-2 group">
                {editingGradeId === grade.id ? (
                  <>
                    <Input
                      value={editingGradeName}
                      onChange={(event) => setEditingGradeName(event.target.value)}
                      className="flex-1 h-8 text-sm"
                      autoFocus
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && editingGradeName.trim()) {
                          updateGradeMutation.mutate({ id: grade.id, name: editingGradeName.trim() });
                        }
                        if (event.key === "Escape") {
                          setEditingGradeId(null);
                          setEditingGradeName("");
                        }
                      }}
                      data-testid={`input-edit-grade-${grade.id}`}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        if (editingGradeName.trim()) {
                          updateGradeMutation.mutate({ id: grade.id, name: editingGradeName.trim() });
                        }
                      }}
                      disabled={updateGradeMutation.isPending}
                      data-testid={`button-save-grade-${grade.id}`}
                    >
                      <Check className="h-4 w-4 text-green-600" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setEditingGradeId(null);
                        setEditingGradeName("");
                      }}
                      data-testid={`button-cancel-grade-${grade.id}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm px-2 py-1.5 rounded-md hover:bg-muted/50 cursor-default">
                      {grade.name}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setEditingGradeId(grade.id);
                        setEditingGradeName(grade.name);
                      }}
                      data-testid={`button-edit-grade-${grade.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteGradeMutation.mutate(grade.id)}
                      disabled={deleteGradeMutation.isPending}
                      data-testid={`button-delete-grade-${grade.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2 pt-2 border-t">
            <Input
              placeholder="New grade name..."
              value={newGradeName}
              onChange={(event) => setNewGradeName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newGradeName.trim()) createGradeMutation.mutate(newGradeName.trim());
              }}
              className="flex-1"
              data-testid="input-new-grade"
            />
            <Button
              onClick={() => {
                if (newGradeName.trim()) createGradeMutation.mutate(newGradeName.trim());
              }}
              disabled={!newGradeName.trim() || createGradeMutation.isPending}
              className="gap-1.5"
              data-testid="button-add-grade"
            >
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={manageCategoriesOpen} onOpenChange={setManageCategoriesOpen}>
        <DialogContent className="max-w-md" data-testid="dialog-manage-categories">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="h-4 w-4" /> Manage Categories
            </DialogTitle>
            <DialogDescription>Add, rename, or remove stock categories.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2 max-h-72 overflow-y-auto pr-1">
            {stockCategories.length === 0 && (
              <EmptyState title="No categories yet. Add one below." className="min-h-0 py-4" />
            )}
            {stockCategories.map((category) => (
              <div key={category.id} className="flex items-center gap-2 group">
                {editingCategoryId === category.id ? (
                  <>
                    <Input
                      value={editingCategoryName}
                      onChange={(event) => setEditingCategoryName(event.target.value)}
                      className="flex-1 h-8 text-sm"
                      autoFocus
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && editingCategoryName.trim()) {
                          updateCategoryMutation.mutate({ id: category.id, name: editingCategoryName.trim() });
                        }
                        if (event.key === "Escape") {
                          setEditingCategoryId(null);
                          setEditingCategoryName("");
                        }
                      }}
                      data-testid={`input-edit-category-${category.id}`}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        if (editingCategoryName.trim()) {
                          updateCategoryMutation.mutate({ id: category.id, name: editingCategoryName.trim() });
                        }
                      }}
                      disabled={updateCategoryMutation.isPending}
                      data-testid={`button-save-category-${category.id}`}
                    >
                      <Check className="h-4 w-4 text-green-600" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setEditingCategoryId(null);
                        setEditingCategoryName("");
                      }}
                      data-testid={`button-cancel-category-${category.id}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm px-2 py-1.5 rounded-md hover:bg-muted/50 cursor-default">
                      {category.name}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setEditingCategoryId(category.id);
                        setEditingCategoryName(category.name);
                      }}
                      data-testid={`button-edit-category-${category.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteCategoryMutation.mutate(category.id)}
                      disabled={deleteCategoryMutation.isPending}
                      data-testid={`button-delete-category-${category.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2 pt-2 border-t">
            <Input
              placeholder="New category name..."
              value={newCategoryName}
              onChange={(event) => setNewCategoryName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newCategoryName.trim())
                  createCategoryMutation.mutate(newCategoryName.trim());
              }}
              className="flex-1"
              data-testid="input-new-category"
            />
            <Button
              onClick={() => {
                if (newCategoryName.trim()) createCategoryMutation.mutate(newCategoryName.trim());
              }}
              disabled={!newCategoryName.trim() || createCategoryMutation.isPending}
              className="gap-1.5"
              data-testid="button-add-category"
            >
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
