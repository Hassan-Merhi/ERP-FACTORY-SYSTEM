// Extracted from ./FactoryProformas.tsx
import { useFactoryProformasModel } from "./factoryproformas/useFactoryProformasModel";
import type { Proforma } from "./factoryproformas/types";

export function useFactoryProformasState() {
  const model = useFactoryProformasModel();
  const { recordChanges } = model;
  const {
    navigate,
    expandedProformaIds,
    setExpandedProformaIds,
    pendingDelete,
    setPendingDelete,
    customerId,
    customers,
    customersLoading,
    proformas,
    proformasLoading,
    expandedProformaStateById,
    showInactive,
    setShowInactive,
    proformaSearch,
  } = model;

  const openAddLineFor = (proformaId: number) => {
    model.setAddLineProformaId(proformaId);
    model.setAddLineMode("catalog");
    model.setCatalogSelectedItem(null);
    model.setCatalogSearch("");
    model.setNewLine({ articleCode: "", productName: "", quantity: "", pricePerBale: "" });
    model.setIsAddLineOpen(true);
  };

  const beginInlineQtyEdit = (lineId: number, currentQuantity: number) => {
    model.setInlineQtyLineId(lineId);
    model.setInlineQtyValue(String(currentQuantity));
  };

  const beginRename = (proforma: Proforma) => {
    model.setRenamingProforma(proforma);
    model.setRenameValue(proforma.name);
  };

  const beginAssignDestination = (proforma: Proforma) => {
    model.setDestinationProforma(proforma);
    model.setDestinationValue(proforma.destination || "");
  };

  const beginTransfer = (proforma: Proforma) => {
    model.setTransferProforma(proforma);
    model.setTransferTargetCustomerId("");
  };
  return {
    model,
    recordChanges,
    customerId,
    proformas,
    proformasLoading,
    customersLoading,
    setExpandedProformaIds,
    customers,
    proformaSearch,
    showInactive,
    expandedProformaIds,
    setShowInactive,
    expandedProformaStateById,
    navigate,
    setPendingDelete,
    pendingDelete,
    openAddLineFor,
    beginInlineQtyEdit,
    beginRename,
    beginAssignDestination,
    beginTransfer,
  };
}
