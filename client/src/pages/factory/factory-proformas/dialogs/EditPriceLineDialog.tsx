/**
 * EditPriceLineDialog — extracted from FactoryProformas.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import { useId } from "react";
import type { useFactoryProformasModel } from "../../factoryproformas/useFactoryProformasModel";

type FactoryProformasModel = ReturnType<typeof useFactoryProformasModel>;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DecimalInput, MoneyInput } from "@/components/ui/decimal-input";
import { FormGrid } from "@/components/ui/form";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function EditPriceLineDialog({
  editLineMutation,
  editLineValues,
  editingLine,
  handleEditLine,
  setEditLineValues,
  setEditingLine,
}: {
  editLineMutation: FactoryProformasModel["editLineMutation"];
  editLineValues: FactoryProformasModel["editLineValues"];
  editingLine: FactoryProformasModel["editingLine"];
  handleEditLine: FactoryProformasModel["handleEditLine"];
  setEditLineValues: FactoryProformasModel["setEditLineValues"];
  setEditingLine: FactoryProformasModel["setEditingLine"];
}) {
  const formId = useId();
  return (
    <Dialog open={!!editingLine} onOpenChange={(open) => !open && setEditingLine(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Price Line</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="bg-muted p-3 rounded-md mb-2">
            <p className="text-sm font-semibold">{editingLine?.articleCode}</p>
            <p className="text-xs text-muted-foreground">{editingLine?.productName}</p>
          </div>
          <div>
            <label htmlFor={`${formId}-product-name`} className="text-sm font-medium mb-1 block">
              Product Name
            </label>
            <Input
              id={`${formId}-product-name`}
              value={editLineValues.productName}
              onChange={(e) => setEditLineValues({ ...editLineValues, productName: e.target.value })}
              data-testid="input-edit-line-product-name"
            />
          </div>
          <FormGrid minColumnWidth="8rem">
            <div>
              <label htmlFor={`${formId}-quantity`} className="text-sm font-medium mb-1 block">
                Quantity
              </label>
              <DecimalInput
                id={`${formId}-quantity`}
                step="1"
                value={editLineValues.quantity}
                onChange={(e) => setEditLineValues({ ...editLineValues, quantity: e.target.value })}
                data-testid="input-edit-line-quantity"
              />
            </div>
            <div>
              <label htmlFor={`${formId}-price`} className="text-sm font-medium mb-1 block">
                Price per Bale
              </label>
              <MoneyInput
                id={`${formId}-price`}
                step="0.01"
                value={editLineValues.pricePerBale}
                onChange={(e) => setEditLineValues({ ...editLineValues, pricePerBale: e.target.value })}
                data-testid="input-edit-line-price"
              />
            </div>
            <div>
              <label htmlFor={`${formId}-weight`} className="text-sm font-medium mb-1 block">
                KG / Bale
              </label>
              <DecimalInput
                id={`${formId}-weight`}
                step="0.01"
                placeholder="e.g. 97"
                value={editLineValues.weightPerBaleKg}
                onChange={(e) => setEditLineValues({ ...editLineValues, weightPerBaleKg: e.target.value })}
                data-testid="input-edit-line-weight"
              />
            </div>
          </FormGrid>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setEditingLine(null)} data-testid="button-cancel-edit-line">
              Cancel
            </Button>
            <FormSubmitButton
              type="button"
              onClick={handleEditLine}
              disabled={!editLineValues.pricePerBale || !editLineValues.quantity}
              pending={editLineMutation.isPending}
              data-testid="button-confirm-edit-line"
            >
              Save
            </FormSubmitButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
