// Extracted from ./RetailSupplierImportDialog.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  buildRetailSupplierReceiptLabelItems,
  type RetailSupplierReceiptLabelItem,
} from "./retailSupplierReceiptLabels";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { getJson, type Location } from "./retailInventoryTypes";
import { matchRetailSupplierImages, type RetailSupplierImageArchive } from "./retailSupplierImageZip";
import { type RetailSupplierImportRow, summarizeRetailSupplierImport } from "./retailSupplierImportDraft";
import { localISODate } from "./retailSupplierImportSpreadsheet";
import type { CatalogPreview, SupplierOption, SupplierPurchaseResult } from "./retailSupplierImportTypes";

export function useRetailSupplierImportDialogStatePart1(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { open, onOpenChange } = props;
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id ?? 0;
  const enabled = open && selectedCompany?.companyType === "retail";
  const { toast } = useToast();

  const [supplierId, setSupplierId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [exchangeRate, setExchangeRate] = useState("");
  const [importKey, setImportKey] = useState(
    () =>
      `retail-supplier-${
        typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
      }`
  );
  const [uploadProgress, setUploadProgress] = useState("");
  const uploadedPhotoCache = useRef<Map<File, string>>(new Map());
  const [purchaseResult, setPurchaseResult] = useState<SupplierPurchaseResult | null>(null);
  const [receiptLabelItems, setReceiptLabelItems] = useState<RetailSupplierReceiptLabelItem[]>([]);
  const [receiptLabelsOpen, setReceiptLabelsOpen] = useState(false);
  const [invoiceReference, setInvoiceReference] = useState("");
  const [partialReceipt, setPartialReceipt] = useState(false);
  const [deliveryReference, setDeliveryReference] = useState("");
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [invoiceFileError, setInvoiceFileError] = useState("");
  const uploadedInvoiceCache = useRef<{ file: File; id: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [postingError, setPostingError] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(localISODate);
  const [fileName, setFileName] = useState("");
  const [photoArchiveName, setPhotoArchiveName] = useState("");
  const [photoArchive, setPhotoArchive] = useState<RetailSupplierImageArchive | null>(null);
  const [photoError, setPhotoError] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoPreviewUrls, setPhotoPreviewUrls] = useState<Map<number, string>>(new Map());
  const [rows, setRows] = useState<RetailSupplierImportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [fileError, setFileError] = useState("");
  const [showProblemsOnly, setShowProblemsOnly] = useState(false);

  useEffect(() => {
    setSupplierId("");
    setLocationId("");
    setInvoiceReference("");
    setInvoiceDate(localISODate());
    setCurrency("USD");
    setExchangeRate("");
    setShowProblemsOnly(false);
    setFileName("");
    setPhotoArchiveName("");
    setPhotoArchive(null);
    setPhotoError("");
    uploadedPhotoCache.current.clear();
    setRows([]);
    setFileError("");
    setPurchaseResult(null);
    setReceiptLabelItems([]);
    setReceiptLabelsOpen(false);
    setPartialReceipt(false);
    setDeliveryReference("");
    setInvoiceFile(null);
    setInvoiceFileError("");
    uploadedInvoiceCache.current = null;
    setHistoryOpen(false);
    setPostingError("");
    setImportKey(
      `retail-supplier-${
        typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
      }`
    );
  }, [companyId]);

  const { data: suppliers = [], isError: suppliersFailed } = useQuery<SupplierOption[]>({
    queryKey: ["retail-supplier-import-suppliers", companyId],
    queryFn: () => getJson("/api/suppliers"),
    enabled,
  });
  const { data: locations = [], isError: locationsFailed } = useQuery<Location[]>({
    queryKey: ["retail-locations", companyId],
    queryFn: () => getJson("/api/locations"),
    enabled,
  });
  const summary = useMemo(() => summarizeRetailSupplierImport(rows), [rows]);
  const imageMatches = useMemo(() => matchRetailSupplierImages(rows, photoArchive), [rows, photoArchive]);
  const imageIssueCount = useMemo(
    () => [...imageMatches.values()].filter((result) => result.errors.length > 0).length,
    [imageMatches]
  );
  const imageMatchedCount = useMemo(
    () => [...imageMatches.values()].reduce((count, result) => count + result.files.length, 0),
    [imageMatches]
  );
  const {
    data: catalogPreview,
    isFetching: catalogChecking,
    isError: catalogFailed,
  } = useQuery<CatalogPreview>({
    queryKey: ["retail-supplier-catalog-preview", companyId, rows],
    queryFn: async () => {
      const response = await apiRequest("POST", "/api/retail/supplier-import/catalog-preview", {
        rows: rows.map((row) => ({
          rowNumber: row.rowNumber,
          name: row.name,
          brand: row.brand,
          category: row.category,
          size: row.size,
          color: row.color,
          sku: row.sku,
          barcode: row.barcode,
        })),
      });
      return response.json();
    },
    enabled: enabled && rows.length > 0 && summary.invalidRows === 0,
    staleTime: 30000,
    retry: false,
  });
  const needsRate = currency !== "USD";
  const validRate = !needsRate || (Number.isFinite(Number(exchangeRate)) && Number(exchangeRate) > 0);
  const hasMissingContext =
    !supplierId ||
    !locationId ||
    !invoiceDate.trim() ||
    !invoiceReference.trim() ||
    !validRate ||
    photoBusy ||
    (partialReceipt && !deliveryReference.trim()) ||
    Boolean(invoiceFileError);
  const readyForPosting =
    rows.length > 0 &&
    !summary.invalidRows &&
    !imageIssueCount &&
    !hasMissingContext &&
    Boolean(catalogPreview) &&
    !catalogChecking &&
    !catalogFailed &&
    !catalogPreview?.summary.conflicts;
  useEffect(() => {
    const previews = new Map<number, string>();
    for (const row of rows.slice(0, 100)) {
      const file = imageMatches.get(row.rowNumber)?.files[0];
      if (file) previews.set(row.rowNumber, URL.createObjectURL(file));
    }
    setPhotoPreviewUrls(previews);
    return () => {
      previews.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [rows, imageMatches]);

  const showSavedPurchase = (result: SupplierPurchaseResult) => {
    setPurchaseResult(result);
    setPostingError("");
    setUploadProgress("");
    try {
      const labels = buildRetailSupplierReceiptLabelItems(result.items, rows);
      setReceiptLabelItems(labels);
      if (labels.length) setReceiptLabelsOpen(true);
    } catch (error) {
      toast({
        title: "Purchase recorded; barcode labels need review",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
    queryClient.invalidateQueries({ queryKey: ["retail-products"] });
    queryClient.invalidateQueries({ queryKey: ["retail-catalog-navigation"] });
    queryClient.invalidateQueries({ queryKey: ["retail-catalog-facets"] });
    queryClient.invalidateQueries({ queryKey: ["retail-brands"] });
    queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] });
    queryClient.invalidateQueries({ queryKey: ["retail-supplier-import-history"] });
    queryClient.invalidateQueries({ queryKey: ["/api/suppliers"] });
    queryClient.invalidateQueries({ queryKey: ["/api/accounts"] });
    toast({
      title: result.replayed ? "Purchase already recorded" : "Supplier stock purchase posted",
      description: `Voucher #${result.voucherId} · ${result.currency} ${result.purchaseTotal} supplier payable`,
    });
  };
  return {
    busy,
    catalogChecking,
    catalogFailed,
    catalogPreview,
    companyId,
    currency,
    deliveryReference,
    exchangeRate,
    fileError,
    fileName,
    historyOpen,
    imageIssueCount,
    imageMatchedCount,
    imageMatches,
    importKey,
    invoiceDate,
    invoiceFile,
    invoiceFileError,
    invoiceReference,
    locationId,
    locations,
    locationsFailed,
    needsRate,
    onOpenChange,
    open,
    partialReceipt,
    photoArchive,
    photoArchiveName,
    photoBusy,
    photoError,
    photoPreviewUrls,
    postingError,
    purchaseResult,
    readyForPosting,
    receiptLabelItems,
    receiptLabelsOpen,
    rows,
    selectedCompany,
    setBusy,
    setCurrency,
    setDeliveryReference,
    setExchangeRate,
    setFileError,
    setFileName,
    setHistoryOpen,
    setImportKey,
    setInvoiceDate,
    setInvoiceFile,
    setInvoiceFileError,
    setInvoiceReference,
    setLocationId,
    setPartialReceipt,
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
    setSupplierId,
    setUploadProgress,
    showProblemsOnly,
    showSavedPurchase,
    summary,
    supplierId,
    suppliers,
    suppliersFailed,
    toast,
    uploadProgress,
    uploadedInvoiceCache,
    uploadedPhotoCache,
    validRate,
  };
}
