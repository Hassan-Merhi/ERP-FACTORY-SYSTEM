// Extracted from ./useFactoryProformasModel.ts
import { useFactoryProformasModelPart1 } from "./useFactoryProformasModelPart1";
import { useFactoryProformasModelPart2 } from "./useFactoryProformasModelPart2";

export function useFactoryProformasModelPart4({
  addLineMutation,
  addLineProformaId,
  createProformaMutation,
  customerId,
  editLineMutation,
  editLineValues,
  editingLine,
  newDestination,
  newLine,
  newProformaName,
}: Pick<
  Awaited<ReturnType<typeof useFactoryProformasModelPart1>> & Awaited<ReturnType<typeof useFactoryProformasModelPart2>>,
  | "addLineMutation"
  | "addLineProformaId"
  | "createProformaMutation"
  | "customerId"
  | "editLineMutation"
  | "editLineValues"
  | "editingLine"
  | "newDestination"
  | "newLine"
  | "newProformaName"
>) {
  const handleCreateProforma = () => {
    if (!newProformaName.trim() || !newDestination.trim() || !customerId) return;
    createProformaMutation.mutate({
      customerId,
      name: newProformaName.trim(),
      destination: newDestination.trim(),
      isActive: false,
    });
  };

  const handleAddLine = () => {
    if (
      !addLineProformaId ||
      !newLine.articleCode.trim() ||
      !newLine.productName.trim() ||
      !newLine.quantity ||
      !newLine.pricePerBale
    )
      return;
    addLineMutation.mutate({
      proformaId: addLineProformaId,
      articleCode: newLine.articleCode.trim(),
      productName: newLine.productName.trim(),
      quantity: parseInt(newLine.quantity),
      pricePerBale: newLine.pricePerBale,
    });
  };

  const handleEditLine = () => {
    if (!editingLine || !editLineValues.pricePerBale || !editLineValues.quantity) return;
    editLineMutation.mutate({
      id: editingLine.id,
      pricePerBale: editLineValues.pricePerBale,
      productName: editLineValues.productName,
      quantity: editLineValues.quantity,
      weightPerBaleKg: editLineValues.weightPerBaleKg,
    });
  };
  return { handleAddLine, handleCreateProforma, handleEditLine };
}
