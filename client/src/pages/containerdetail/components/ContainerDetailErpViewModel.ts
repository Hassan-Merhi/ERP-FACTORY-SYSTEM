// Extracted from ./ContainerDetailErpView.tsx: state, queries and handlers for ContainerDetailErpView.
import type { Model } from "./ContainerDetailErpView";
import { compareItemNamesAZ } from "@/lib/itemNameSort";

export function useContainerDetailErpViewModel({ model }: { model: { model: Model }["model"] }) {
  // prettier-ignore
  const { formatDisplayDate, containerId, showOffloadDialog, setShowOffloadDialog, showSellDialog, setShowSellDialog, pendingDelete, setPendingDelete, setLocation, formatAmount, isDeveloper, containerData, suppliers, customers, incomeAccounts, containerSale, docsData, showUploadDialog, setShowUploadDialog, uploadDocTypeId, setUploadDocTypeId, uploadFile, setUploadFile, fileInputRef, setShowPriceImportDialog, setPriceImportPreview, setPriceImportError, uploadDocMutation, handleExportContainer, handleExportContainerNoCost, backUrl, form, deletePOMutation, deleteContainerMutation, syncVoucherMutation, reverseOffloadMutation, sellContainerMutation, handleDeletePO, handleDeleteContainer, handleSellSubmit, handlePrint, saleCustomer, canChangeExistingRecords, canCreate } = model;
  // Properties owns the canonical physical container; receiving and sale are
  // intercompany workflows, not legacy ERP offload/sell/delete actions.
  const isPropertiesContainer = backUrl.startsWith("/properties");

  return {
    formatDisplayDate,
    containerId,
    showOffloadDialog,
    setShowOffloadDialog,
    showSellDialog,
    setShowSellDialog,
    pendingDelete,
    setPendingDelete,
    setLocation,
    formatAmount,
    isDeveloper,
    containerData,
    suppliers,
    customers,
    incomeAccounts,
    containerSale,
    docsData,
    showUploadDialog,
    setShowUploadDialog,
    uploadDocTypeId,
    setUploadDocTypeId,
    uploadFile,
    setUploadFile,
    fileInputRef,
    setShowPriceImportDialog,
    setPriceImportPreview,
    setPriceImportError,
    uploadDocMutation,
    handleExportContainer,
    handleExportContainerNoCost,
    backUrl,
    form,
    deletePOMutation,
    deleteContainerMutation,
    syncVoucherMutation,
    reverseOffloadMutation,
    sellContainerMutation,
    handleDeletePO,
    handleDeleteContainer,
    handleSellSubmit,
    handlePrint,
    saleCustomer,
    canChangeExistingRecords,
    canCreate,
    isPropertiesContainer,
  };
}

export type ContainerDetailErpViewModel = ReturnType<typeof useContainerDetailErpViewModel>;

export function deriveContainerErpView({
  containerData,
  m,
}: {
  containerData: NonNullable<ContainerDetailErpViewModel["containerData"]>;
  m: ContainerDetailErpViewModel;
}) {
  const { container, pos, charges } = containerData;
  // Display-only ordering, shared by desktop table and mobile item cards.
  const alphabetizedPos = pos.map((po) => ({
    ...po,
    items: [...po.items].sort((a, b) => compareItemNamesAZ(a.itemName, b.itemName)),
  }));
  const supplier = m.suppliers.find((s) => s.id === container.supplierId);

  // Compute totals live from the actual PO and charges data so they are
  // always accurate, even when the stored container totals are stale.
  const itemsTotal = pos.reduce((sum: number, po) => sum + parseFloat(po.itemsTotal || "0"), 0);
  const chargesTotal = charges.reduce((sum: number, c) => sum + parseFloat(c.amount || "0"), 0);
  const grandTotal = itemsTotal + chargesTotal;

  // Calculate total bales from all line items
  const totalBales = pos.reduce((total: number, po) => {
    return (
      total +
      po.items.reduce((sum, item) => {
        return sum + parseFloat(item.quantity || "0");
      }, 0)
    );
  }, 0);

  // Format quantity: strip trailing zeros (e.g. "7.000" → "7", "2.500" → "2.5")
  const fmtQty = (q: string | number | null | undefined) => {
    const n = parseFloat(String(q ?? "0"));
    if (isNaN(n)) return "0";
    return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  };

  return {
    container,
    pos,
    charges,
    alphabetizedPos,
    supplier,
    itemsTotal,
    chargesTotal,
    grandTotal,
    totalBales,
    fmtQty,
  };
}

export type ContainerErpView = ReturnType<typeof deriveContainerErpView>;
