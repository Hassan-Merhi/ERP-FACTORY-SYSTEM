// Extracted from ./FactoryPendingLoadings.tsx to keep that module under the source-size cap.
import { useFactoryPendingLoadingsStatePart1 } from "./useFactoryPendingLoadingsStatePart1";
import { useFactoryPendingLoadingsStatePart3 } from "./useFactoryPendingLoadingsStatePart3";

export function useFactoryPendingLoadingsState() {
  const {
    refetchLoads,
    loadsError,
    canStartLoading,
    cancelMutation,
    closeLinkDialog,
    collapsedCustomers,
    customerCount,
    customerFilter,
    customerNames,
    deleteTarget,
    dismissUndo,
    editingNoteId,
    editingNoteText,
    formatDate,
    formatDisplayDate,
    groups,
    handleConfirmDelete,
    handleConfirmLink,
    handleDelete,
    handleExport,
    handleOpenLink,
    handleUndo,
    isLoading,
    linkProformaMutation,
    linkTarget,
    loads,
    navigate,
    proformas,
    proformasLoading,
    queryClient,
    recordChanges,
    restoreMutation,
    saveNoteMutation,
    searchTerm,
    selectedProformaId,
    setCustomerFilter,
    setDeleteTarget,
    setEditingNoteId,
    setEditingNoteText,
    setSearchTerm,
    setSelectedProformaId,
    setSortOrder,
    sortOrder,
    toggleCustomer,
    totalBales,
    totalKg,
    undoItems,
    visibleLoads,
  } = useFactoryPendingLoadingsStatePart1();
  const { renderLoadCard } = useFactoryPendingLoadingsStatePart2({
    cancelMutation,
    editingNoteId,
    editingNoteText,
    formatDate,
    handleDelete,
    handleExport,
    handleOpenLink,
    navigate,
    recordChanges,
    saveNoteMutation,
    setEditingNoteId,
    setEditingNoteText,
  });
  return {
    refetchLoads,
    loadsError,
    canStartLoading,
    closeLinkDialog,
    collapsedCustomers,
    customerCount,
    customerFilter,
    customerNames,
    deleteTarget,
    dismissUndo,
    formatDate,
    formatDisplayDate,
    groups,
    handleConfirmDelete,
    handleConfirmLink,
    handleUndo,
    isLoading,
    linkProformaMutation,
    linkTarget,
    loads,
    navigate,
    proformas,
    proformasLoading,
    queryClient,
    renderLoadCard,
    restoreMutation,
    searchTerm,
    selectedProformaId,
    setCustomerFilter,
    setDeleteTarget,
    setSearchTerm,
    setSelectedProformaId,
    setSortOrder,
    sortOrder,
    toggleCustomer,
    totalBales,
    totalKg,
    undoItems,
    visibleLoads,
  };
}

function useFactoryPendingLoadingsStatePart2({
  cancelMutation,
  editingNoteId,
  editingNoteText,
  formatDate,
  handleDelete,
  handleExport,
  handleOpenLink,
  navigate,
  recordChanges,
  saveNoteMutation,
  setEditingNoteId,
  setEditingNoteText,
}: Pick<
  Awaited<ReturnType<typeof useFactoryPendingLoadingsStatePart1>>,
  | "cancelMutation"
  | "editingNoteId"
  | "editingNoteText"
  | "formatDate"
  | "handleDelete"
  | "handleExport"
  | "handleOpenLink"
  | "navigate"
  | "recordChanges"
  | "saveNoteMutation"
  | "setEditingNoteId"
  | "setEditingNoteText"
>) {
  const { renderLoadCard } = useFactoryPendingLoadingsStatePart3({
    cancelMutation,
    editingNoteId,
    editingNoteText,
    formatDate,
    handleDelete,
    handleExport,
    handleOpenLink,
    navigate,
    recordChanges,
    saveNoteMutation,
    setEditingNoteId,
    setEditingNoteText,
  });
  return { renderLoadCard };
}
