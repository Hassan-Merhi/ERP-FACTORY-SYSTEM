// Extracted from ./FactoryInvoiceDetail.tsx: state, queries and handlers for FactoryInvoiceDetail.
import { useCompany } from "@/contexts/CompanyContext";
import { factoryRecordChangeAccess } from "./factoryRecordChangeAccess";
import { useFactoryInvoiceDetailModel } from "./factoryinvoicedetail/useFactoryInvoiceDetailModel";

export function useFactoryInvoiceDetailPageModel() {
  const model = useFactoryInvoiceDetailModel();
  // View Only / Create Only roles read the invoice but never reprice, revert, delete or edit charges.
  const recordChanges = factoryRecordChangeAccess(useCompany().selectedCompany?.role);
  const canChange = recordChanges.allowed;
  const {
    formatDisplayDate,
    navigate,
    editingArticleCode,
    editingChargeLedger,
    setEditingChargeLedger,
    editingChargeAmount,
    setEditingChargeAmount,
    chargeAmountInput,
    setChargeAmountInput,
    showAddCharge,
    setShowAddCharge,
    newChargeName,
    setNewChargeName,
    newChargeAmount,
    setNewChargeAmount,
    newChargeType,
    setNewChargeType,
    newChargeLedgerId,
    setNewChargeLedgerId,
    editValue,
    setEditValue,
    setRevertDialogOpen,
    setDeleteDialogOpen,
    setBaleRefArticle,
    setShowProformaDialog,
    setSelectedProformaId,
    inputRef,
    order,
    isLoading,
    ledgerAccounts,
    updateChargeLedgerMutation,
    addChargeMutation,
    relinkVouchersMutation,
    updateChargeAmountMutation,
    isDeveloper,
    dispatchBatch,
    hideExportSelling,
    isAdmin,
    getStatusBadge,
    repriceMutation,
    repriceArticleMutation,
    repriceProductionMutation,
    applyProformaMutation,
    startEdit,
    commitEdit,
    cancelEdit,
    handleExportExcel,
    handleExportExcelNoCharges,
    handleExportPdf,
    handleExportPdfNoCharges,
    handleExportLoadingStatus,
  } = model;

  const invoiceQueryParams =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const viewWithoutCharges = invoiceQueryParams.get("view") === "no-charges";
  const fromAnalytics = invoiceQueryParams.get("from") === "analytics";
  const backTarget: "/factory/analytics" | "/factory/invoicing?tab=invoices" = fromAnalytics
    ? "/factory/analytics"
    : "/factory/invoicing?tab=invoices";

  return {
    model,
    recordChanges,
    canChange,
    formatDisplayDate,
    navigate,
    editingArticleCode,
    editingChargeLedger,
    setEditingChargeLedger,
    editingChargeAmount,
    setEditingChargeAmount,
    chargeAmountInput,
    setChargeAmountInput,
    showAddCharge,
    setShowAddCharge,
    newChargeName,
    setNewChargeName,
    newChargeAmount,
    setNewChargeAmount,
    newChargeType,
    setNewChargeType,
    newChargeLedgerId,
    setNewChargeLedgerId,
    editValue,
    setEditValue,
    setRevertDialogOpen,
    setDeleteDialogOpen,
    setBaleRefArticle,
    setShowProformaDialog,
    setSelectedProformaId,
    inputRef,
    order,
    isLoading,
    ledgerAccounts,
    updateChargeLedgerMutation,
    addChargeMutation,
    relinkVouchersMutation,
    updateChargeAmountMutation,
    isDeveloper,
    dispatchBatch,
    hideExportSelling,
    isAdmin,
    getStatusBadge,
    repriceMutation,
    repriceArticleMutation,
    repriceProductionMutation,
    applyProformaMutation,
    startEdit,
    commitEdit,
    cancelEdit,
    handleExportExcel,
    handleExportExcelNoCharges,
    handleExportPdf,
    handleExportPdfNoCharges,
    handleExportLoadingStatus,
    viewWithoutCharges,
    backTarget,
  };
}

export type FactoryInvoiceDetailPageModel = ReturnType<typeof useFactoryInvoiceDetailPageModel>;

/** Totals and status flags for a loaded invoice (the page renders this only once the order exists). */
export function deriveFactoryInvoiceView(order: NonNullable<FactoryInvoiceDetailPageModel["order"]>) {
  const sortedLines = [...(order.lines || [])].sort((a, b) => (a.baleName || "").localeCompare(b.baleName || ""));

  const freightCharges = (order.charges || []).filter((c) => c.chargeType === "FREIGHT");
  const otherCharges = (order.charges || []).filter((c) => c.chargeType !== "FREIGHT");

  const subtotal = parseFloat(order.subtotalBales || "0");
  const totalCharges = parseFloat(order.freightAmount || "0") + parseFloat(order.otherChargesTotal || "0");
  const grandTotal = parseFloat(order.grandTotal || "0");
  const totalBalesQty = sortedLines.reduce((sum, line) => sum + (line.qty || 0), 0);
  const totalWeightKg = sortedLines.reduce((sum, line) => sum + (Number(line.totalWeight) || 0), 0);

  const isPendingVerification = order.status === "PENDING_VERIFICATION";
  const isVerifiedStatus = order.status === "VERIFIED";
  const isLoadingStatus = order.status === "LOADING";
  const isFinalized = order.status === "FINALIZED";

  return {
    sortedLines,
    freightCharges,
    otherCharges,
    subtotal,
    totalCharges,
    grandTotal,
    totalBalesQty,
    totalWeightKg,
    isPendingVerification,
    isVerifiedStatus,
    isLoadingStatus,
    isFinalized,
  };
}

export type FactoryInvoiceView = ReturnType<typeof deriveFactoryInvoiceView>;
