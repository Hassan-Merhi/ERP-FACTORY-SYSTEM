// Extracted from ./FactoryDispatchBatchDetail.tsx: state, queries and handlers for FactoryDispatchBatchDetail.
import { useFactoryDispatchBatchDetailState } from "./useFactoryDispatchBatchDetailState";
import { BATCH_STATUS_CONFIG } from "./factorydispatchbatchdetail/utils";

export function useFactoryDispatchBatchDetailModel() {
  const {
    addRideMutation,
    addRideOpen,
    auditScans,
    batchId,
    cancelMutation,
    cancelOpen,
    data,
    error,
    formatDisplayDate,
    generateMutation,
    generateOpen,
    invoiceDate,
    isDeveloper,
    isError,
    isLoading,
    me,
    navigate,
    preview,
    previewLoading,
    previewOpen,
    recordChanges,
    reopenReason,
    reopenRideId,
    reopenRideMutation,
    rideForm,
    setAddRideOpen,
    setCancelOpen,
    setGenerateOpen,
    setInvoiceDate,
    setPreviewOpen,
    setReopenReason,
    setReopenRideId,
    setRideForm,
    setShowBales,
    showBales,
  } = useFactoryDispatchBatchDetailState();

  return {
    addRideMutation,
    addRideOpen,
    auditScans,
    batchId,
    cancelMutation,
    cancelOpen,
    data,
    error,
    formatDisplayDate,
    generateMutation,
    generateOpen,
    invoiceDate,
    isDeveloper,
    isError,
    isLoading,
    me,
    navigate,
    preview,
    previewLoading,
    previewOpen,
    recordChanges,
    reopenReason,
    reopenRideId,
    reopenRideMutation,
    rideForm,
    setAddRideOpen,
    setCancelOpen,
    setGenerateOpen,
    setInvoiceDate,
    setPreviewOpen,
    setReopenReason,
    setReopenRideId,
    setRideForm,
    setShowBales,
    showBales,
  };
}

export type FactoryDispatchBatchDetailModel = ReturnType<typeof useFactoryDispatchBatchDetailModel>;

export function deriveFactoryDispatchBatchDetailView({
  bd,
}: {
  bd: FactoryDispatchBatchDetailModel & {
    batchId: NonNullable<FactoryDispatchBatchDetailModel["batchId"]>;
    data: NonNullable<FactoryDispatchBatchDetailModel["data"]>;
  };
}) {
  const { batch, customerName, proforma, proformaLines, rides, articleTotals, finalInvoice } = bd.data;
  const isReadOnly = batch.status === "INVOICED" || batch.status === "CANCELLED";
  // Rides, cancel, reopen, scan and invoice generation all change this existing batch.
  const canChangeBatch = !isReadOnly && bd.recordChanges.allowed;

  const totalBales = rides.reduce((s, r) => s + parseInt(String(r.baleCount || 0)), 0);
  const totalWeight = rides.reduce((s, r) => s + parseFloat(r.totalWeightKg || "0"), 0);
  const totalValue = rides.reduce((s, r) => s + parseFloat(r.totalAmount || "0"), 0);

  const batchCfg = BATCH_STATUS_CONFIG[batch.status] || { label: batch.status, className: "" };

  const buildProformaProgress = () => {
    if (!proformaLines.length) return [];
    return proformaLines.map((pl) => {
      const at = articleTotals.find((a) => a.articleCode === pl.articleCode);
      const scanned = parseInt(String(at?.scannedQty || 0));
      return {
        articleCode: pl.articleCode,
        productName: pl.productName,
        proformaQty: pl.quantity,
        proformaPrice: pl.pricePerBale,
        scannedQty: scanned,
        remaining: pl.quantity - scanned,
        totalAmount: at?.scannedAmount || "0",
      };
    });
  };

  const progress = buildProformaProgress();

  return {
    batch,
    customerName,
    proforma,
    rides,
    finalInvoice,
    isReadOnly,
    canChangeBatch,
    totalBales,
    totalWeight,
    totalValue,
    batchCfg,
    progress,
  };
}

export type FactoryDispatchBatchDetailView = ReturnType<typeof deriveFactoryDispatchBatchDetailView>;
