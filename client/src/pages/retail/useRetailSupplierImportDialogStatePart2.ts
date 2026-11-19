// Extracted from ./RetailSupplierImportDialog.tsx to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { uploadRetailPhoto } from "./retailPhotoUpload";
import type { RetailSupplierPurchaseDetail } from "./RetailSupplierImportHistory";
import { readRetailSupplierImageZip } from "./retailSupplierImageZip";
import type { SupplierPurchaseResult } from "./retailSupplierImportTypes";
import { confirmAction } from "@/components/ConfirmHost";
import { useRetailSupplierImportDialogStatePart1 } from "./useRetailSupplierImportDialogStatePart1";
export { useRetailSupplierImportDialogStatePart3 } from "./useRetailSupplierImportDialogStatePart3";

export function useRetailSupplierImportDialogStatePart2({
  catalogPreview,
  currency,
  deliveryReference,
  exchangeRate,
  imageMatches,
  importKey,
  invoiceDate,
  invoiceFile,
  invoiceReference,
  locationId,
  locations,
  needsRate,
  partialReceipt,
  readyForPosting,
  rows,
  setDeliveryReference,
  setFileError,
  setFileName,
  setImportKey,
  setInvoiceFile,
  setInvoiceReference,
  setPhotoArchive,
  setPhotoArchiveName,
  setPhotoBusy,
  setPhotoError,
  setPostingError,
  setPurchaseResult,
  setReceiptLabelItems,
  setReceiptLabelsOpen,
  setRows,
  setShowProblemsOnly,
  setUploadProgress,
  showSavedPurchase,
  summary,
  supplierId,
  suppliers,
  toast,
  uploadedInvoiceCache,
  uploadedPhotoCache,
}: Pick<
  Awaited<ReturnType<typeof useRetailSupplierImportDialogStatePart1>>,
  | "catalogPreview"
  | "currency"
  | "deliveryReference"
  | "exchangeRate"
  | "imageMatches"
  | "importKey"
  | "invoiceDate"
  | "invoiceFile"
  | "invoiceReference"
  | "locationId"
  | "locations"
  | "needsRate"
  | "partialReceipt"
  | "readyForPosting"
  | "rows"
  | "setDeliveryReference"
  | "setFileError"
  | "setFileName"
  | "setImportKey"
  | "setInvoiceFile"
  | "setInvoiceReference"
  | "setPhotoArchive"
  | "setPhotoArchiveName"
  | "setPhotoBusy"
  | "setPhotoError"
  | "setPostingError"
  | "setPurchaseResult"
  | "setReceiptLabelItems"
  | "setReceiptLabelsOpen"
  | "setRows"
  | "setShowProblemsOnly"
  | "setUploadProgress"
  | "showSavedPurchase"
  | "summary"
  | "supplierId"
  | "suppliers"
  | "toast"
  | "uploadedInvoiceCache"
  | "uploadedPhotoCache"
>) {
  /** Inspect the durable receipt identity after a lost network response. Never submit stock again here. */
  const checkPurchaseStatus = async () => {
    try {
      const response = await fetch(`/api/retail/supplier-import/requests/${encodeURIComponent(importKey)}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (response.status === 404) {
        toast({
          title: "No committed receipt found",
          description: "The purchase is not recorded under this request ID. You may retry the unchanged import.",
        });
        return;
      }
      if (!response.ok) throw new Error("Could not check receipt status");
      const saved = (await response.json()) as RetailSupplierPurchaseDetail;
      if (!saved.movementsMatch || !saved.barcodesMatch) {
        setPostingError(
          "Purchase was recorded, but its receipt identity or stock movements need review. See import history before reprinting."
        );
        setPurchaseResult({
          replayed: true,
          operationId: saved.operationId,
          voucherId: saved.voucherId,
          purchaseTotal: saved.purchaseTotal,
          baseTotal: saved.baseTotal,
          currency: saved.currency,
          items: saved.items,
        });
        setReceiptLabelItems([]);
        setReceiptLabelsOpen(false);
        return;
      }
      showSavedPurchase({
        replayed: true,
        operationId: saved.operationId,
        voucherId: saved.voucherId,
        purchaseTotal: saved.purchaseTotal,
        baseTotal: saved.baseTotal,
        currency: saved.currency,
        items: saved.items,
      });
    } catch (error) {
      toast({
        title: "Receipt status check failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  const startNextDelivery = () => {
    setPurchaseResult(null);
    setReceiptLabelItems([]);
    setReceiptLabelsOpen(false);
    setRows([]);
    setFileName("");
    setDeliveryReference("");
    if (!partialReceipt) {
      setInvoiceReference("");
      setInvoiceFile(null);
      uploadedInvoiceCache.current = null;
    }
    setPhotoArchive(null);
    setPhotoArchiveName("");
    setPhotoError("");
    setFileError("");
    setShowProblemsOnly(false);
    uploadedPhotoCache.current.clear();
    setPostingError("");
    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
  };

  const saveMutation = useMutation<SupplierPurchaseResult>({
    mutationFn: async () => {
      if (!readyForPosting || !catalogPreview)
        throw new Error("Resolve all import validation errors before confirming");
      const confirmed = await confirmAction({
        title: "Receive these items from the supplier?",
        description: "This posts the inventory and supplier credit voucher.",
        details: [
          { label: "Items", value: summary.totalUnits },
          { label: "Supplier", value: knownSupplier?.legalName || knownSupplier?.name || "—" },
        ],
        confirmText: "Receive and post",
        tone: "warning",
      });
      if (!confirmed) {
        throw new Error("Purchase confirmation cancelled");
      }
      // Reuse uploaded URLs on retry. Otherwise a lost success response would
      // generate new file IDs and turn the same idempotency key into a changed payload.
      const photoUrls = uploadedPhotoCache.current;
      const upload = async (file: File): Promise<string> => {
        const cached = photoUrls.get(file);
        if (cached) return cached;
        setUploadProgress(`Uploading picture ${photoUrls.size + 1}…`);
        const url = await uploadRetailPhoto(file);
        photoUrls.set(file, url);
        return url;
      };
      const lines = [];
      for (const row of rows) {
        const matched = imageMatches.get(row.rowNumber)?.files ?? [];
        const imageUrls = [];
        for (const file of matched) imageUrls.push(await upload(file));
        lines.push({
          rowNumber: row.rowNumber,
          name: row.name,
          category: row.category,
          brand: row.brand,
          color: row.color || "Default",
          size: row.size || "One Size",
          quantity: row.quantity,
          costPrice: row.costPrice,
          sellingPrice: row.sellingPrice,
          barcode: row.barcode,
          sku: row.sku,
          description: row.description,
          imageUrls,
        });
      }
      let invoiceFileId: number | null = null;
      if (invoiceFile) {
        if (uploadedInvoiceCache.current?.file === invoiceFile) {
          invoiceFileId = uploadedInvoiceCache.current.id;
        } else {
          setUploadProgress("Uploading supplier invoice attachment…");
          const formData = new FormData();
          formData.append("file", invoiceFile);
          const uploadResponse = await fetch("/api/files/upload", {
            method: "POST",
            credentials: "include",
            body: formData,
          });
          const uploadResult = (await uploadResponse.json().catch(() => ({}))) as { id?: number; message?: string };
          if (!uploadResponse.ok || !uploadResult.id) {
            throw new Error(uploadResult.message || "Supplier invoice could not be uploaded");
          }
          invoiceFileId = uploadResult.id;
          uploadedInvoiceCache.current = { file: invoiceFile, id: invoiceFileId };
        }
      }
      setUploadProgress("Posting supplier purchase, stock, and accounting voucher…");
      const response = await apiRequest("POST", "/api/retail/supplier-import/confirm", {
        idempotencyKey: importKey,
        supplierId: Number(supplierId),
        locationId: Number(locationId),
        invoiceReference: invoiceReference.trim(),
        invoiceDate,
        currency,
        partialReceipt,
        deliveryReference: partialReceipt ? deliveryReference.trim() : "",
        invoiceFileId,
        exchangeRate: needsRate ? (1 / Number(exchangeRate)).toFixed(10) : "1",
        lines,
      });
      return response.json();
    },
    onSuccess: (result) => showSavedPurchase(result),
    onError: (error) => {
      setUploadProgress("");
      if (error.message !== "Purchase confirmation cancelled") {
        setPostingError(error instanceof Error ? error.message : String(error));
        toast({
          title: "Supplier purchase not posted",
          description: error instanceof Error ? error.message : String(error),
          variant: "destructive",
        });
      }
    },
  });

  const handlePhotoArchive = async (file?: File) => {
    setPhotoArchive(null);
    setPhotoArchiveName("");
    setPhotoError("");
    uploadedPhotoCache.current.clear();
    setPurchaseResult(null);
    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
    if (!file) return;
    setPhotoBusy(true);
    try {
      const archive = await readRetailSupplierImageZip(file);
      setPhotoArchive(archive);
      setPhotoArchiveName(archive.filename);
      toast({ title: "Image archive checked", description: `${archive.imageCount} images available for matching` });
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : "Cannot open image ZIP");
    } finally {
      setPhotoBusy(false);
    }
  };
  const knownSupplier = suppliers.find((supplier) => String(supplier.id) === supplierId);
  const knownLocation = locations.find((location) => String(location.id) === locationId);
  return { checkPurchaseStatus, handlePhotoArchive, knownLocation, knownSupplier, saveMutation, startNextDelivery };
}
