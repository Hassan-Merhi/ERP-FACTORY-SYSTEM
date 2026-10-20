import { Trash2, AlertTriangle, Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { useBaleProductsModel } from "../useBaleProductsModel";

type Model = ReturnType<typeof useBaleProductsModel>;

const GRADE_OPTIONS = [
  { value: "CREAM", label: "CREAM", prefix: "HMD10" },
  { value: "#1", label: "#1", prefix: "HMD11" },
  { value: "#2", label: "#2", prefix: "HMD12" },
  { value: "#3", label: "#3", prefix: "HMD13" },
  { value: "#4", label: "#4", prefix: "HMD14" },
  { value: "Garbage", label: "Garbage", prefix: "HMD16" },
] as const;

function inferGradeFromArticleCode(articleCode: string): string {
  return GRADE_OPTIONS.find((option) => articleCode.startsWith(option.prefix))?.value ?? "";
}

export function BaleProductsDialog1({ model }: { model: Model }) {
  const {
    designColors,
    editingProduct,
    setEditingProduct,
    editForm,
    setEditForm,
    setPendingDelete,
    hideAvgRate,
    hideSellingPriceBP,
    categories,
    editProductMutation,
    deleteProductMutation,
  } = model;

  const selectedGrade = editForm.grade || inferGradeFromArticleCode(editForm.articleCode);

  const handleSave = () => {
    if (!editingProduct || !editForm.name.trim()) return;

    // Price-only edits must not resend nullable catalog fields. In particular,
    // converting the stored decimal weight ("45.00") to a JS number (45)
    // previously made the cascade endpoint think the bale weight had changed.
    const payload: {
      name?: string;
      articleCode?: string;
      weightPerBaleKg?: number | null;
      categoryId?: number | null;
      description?: string;
      productionPrice?: string;
      sellingPrice?: string;
      labelDesignColor?: string | null;
      grade?: string;
    } = {};
    const name = editForm.name.trim();
    if (name !== editingProduct.name) payload.name = name;

    const articleCode = editForm.articleCode.trim();
    if (articleCode !== (editingProduct.articleCode ?? "")) payload.articleCode = articleCode;

    const weight = editForm.weightPerBaleKg.trim() === "" ? null : Number(editForm.weightPerBaleKg);
    const previousWeight = editingProduct.weightPerBaleKg == null ? null : Number(editingProduct.weightPerBaleKg);
    if (weight !== previousWeight) payload.weightPerBaleKg = weight;

    const categoryId = editForm.categoryId ? Number(editForm.categoryId) : null;
    if (categoryId !== (editingProduct.categoryId ?? null)) payload.categoryId = categoryId;

    const description = editForm.description.trim();
    if (description !== (editingProduct.description ?? "")) payload.description = description;

    // An empty price input represents zero, not a null value or an instruction
    // to rewrite another field. Include prices only when their value changes.
    const cost = editForm.productionPrice.trim();
    if (Number(cost || 0) !== Number(editingProduct.productionPrice ?? 0)) payload.productionPrice = cost || "0";
    const selling = editForm.sellingPrice.trim();
    if (Number(selling || 0) !== Number(editingProduct.sellingPrice ?? 0)) payload.sellingPrice = selling || "0";

    const labelColor = editForm.labelDesignColor || null;
    if (labelColor !== (editingProduct.labelDesignColor ?? null)) payload.labelDesignColor = labelColor;

    // An inferred grade is display-only; never cascade it for a price edit.
    if (editForm.grade) payload.grade = editForm.grade;
    if (Object.keys(payload).length === 0) {
      setEditingProduct(null);
      return;
    }
    editProductMutation.mutate(payload);
  };

  return (
    <Dialog
      open={!!editingProduct}
      onOpenChange={(open) => {
        if (!open) setEditingProduct(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Product</DialogTitle>
          <DialogDescription>Update product details. Changes will cascade to related bales.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-name">Name *</Label>
            <Input
              id="edit-name"
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              required
              data-testid="input-edit-product-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-articleCode">Article Code</Label>
            <Input
              id="edit-articleCode"
              value={editForm.articleCode}
              onChange={(e) => setEditForm({ ...editForm, articleCode: e.target.value })}
              className="font-mono"
              data-testid="input-edit-product-articleCode"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-weight">Weight per Bale (KG)</Label>
            <Input
              id="edit-weight"
              type="number"
              value={editForm.weightPerBaleKg}
              onChange={(e) => setEditForm({ ...editForm, weightPerBaleKg: e.target.value })}
              data-testid="input-edit-product-weight"
            />
          </div>
          {(!hideAvgRate || !hideSellingPriceBP) && (
            <div className="grid grid-cols-2 gap-3">
              {!hideAvgRate && (
                <div className="space-y-2">
                  <Label htmlFor="edit-productionPrice">Cost Price</Label>
                  <Input
                    id="edit-productionPrice"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    value={editForm.productionPrice}
                    onChange={(e) => setEditForm({ ...editForm, productionPrice: e.target.value })}
                    data-testid="input-edit-product-production-price"
                  />
                </div>
              )}
              {!hideSellingPriceBP && (
                <div className="space-y-2">
                  <Label htmlFor="edit-sellingPrice">Sell Price</Label>
                  <Input
                    id="edit-sellingPrice"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    value={editForm.sellingPrice}
                    onChange={(e) => setEditForm({ ...editForm, sellingPrice: e.target.value })}
                    data-testid="input-edit-product-selling-price"
                  />
                </div>
              )}
            </div>
          )}
          <div className="space-y-2">
            <Label>Category</Label>
            <Select value={editForm.categoryId} onValueChange={(val) => setEditForm({ ...editForm, categoryId: val })}>
              <SelectTrigger data-testid="select-edit-product-category">
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {categories?.map((cat) => (
                  <SelectItem key={cat.id} value={String(cat.id)}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Grade</Label>
            <Select value={selectedGrade} onValueChange={(val) => setEditForm({ ...editForm, grade: val })}>
              <SelectTrigger data-testid="select-edit-product-grade">
                <SelectValue placeholder="Select grade" />
              </SelectTrigger>
              <SelectContent>
                {GRADE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              data-testid="input-edit-product-description"
            />
          </div>
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Palette className="h-3.5 w-3.5" />
              Label Design Color
            </Label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                data-testid="button-label-color-none"
                onClick={() => setEditForm({ ...editForm, labelDesignColor: "" })}
                className={`px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${!editForm.labelDesignColor ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover-elevate"}`}
              >
                No Design
              </button>
              {designColors.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`button-label-color-${opt.value}`}
                  onClick={() => setEditForm({ ...editForm, labelDesignColor: opt.value })}
                  className={`px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${editForm.labelDesignColor === opt.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover-elevate"}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {editForm.labelDesignColor && (
              <p className="text-xs text-muted-foreground">
                Labels for this product will print with the{" "}
                <span className="font-medium">
                  {designColors.find((o) => o.value === editForm.labelDesignColor)?.label}
                </span>{" "}
                design automatically.
              </p>
            )}
            {!editForm.labelDesignColor && (
              <p className="text-xs text-muted-foreground">Labels will print with no design banner.</p>
            )}
          </div>
          <div className="flex items-start gap-2 p-3 rounded-md bg-muted text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Changes to name, weight, and article code will also update all existing bales using this product.
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <Button
              variant="destructive"
              onClick={() => {
                setPendingDelete(() => () => deleteProductMutation.mutate(editingProduct!.id));
              }}
              disabled={deleteProductMutation.isPending}
              data-testid="button-delete-edit-product"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              {deleteProductMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setEditingProduct(null)}
                data-testid="button-cancel-edit-product"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={!editForm.name.trim() || editProductMutation.isPending}
                data-testid="button-save-edit-product"
              >
                {editProductMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
