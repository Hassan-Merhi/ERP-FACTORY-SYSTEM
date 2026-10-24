import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { uploadRetailPhoto } from "./retailPhotoUpload";
import { RetailLabelPrintDialog } from "./retailLabels";
import { RetailSupplierImportHistory, type RetailSupplierPurchaseDetail } from "./RetailSupplierImportHistory";
import {
  buildRetailSupplierReceiptLabelItems,
  type RetailSupplierReceiptLabelItem,
} from "./retailSupplierReceiptLabels";
import {
  AlertTriangle,
  FileSpreadsheet,
  Image as ImageIcon,
  Package,
  Printer,
  History,
  ShieldCheck,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { read, utils, writeFile } from "@/lib/excelHelper";
import { getJson, type Location } from "./retailInventoryTypes";
import {
  matchRetailSupplierImages,
  readRetailSupplierImageZip,
  type RetailSupplierImageArchive,
} from "./retailSupplierImageZip";
import {
  RETAIL_SUPPLIER_IMPORT_LIMIT,
  RETAIL_SUPPLIER_TEMPLATE_COLUMNS,
  parseRetailSupplierImportRows,
  summarizeRetailSupplierImport,
  type RetailSupplierImportRow,
} from "./retailSupplierImportDraft";

interface SupplierOption {
  id: number;
  code?: string | null;
  legalName?: string | null;
  name?: string | null;
}
type SourceRow = { rowNumber: number; values: Record<string, unknown> };

type CatalogDecision = {
  rowNumber: number;
  status: "new-product" | "new-variant" | "existing-variant" | "conflict";
  productId: number | null;
  variantId: number | null;
  existingBarcode: string | null;
  messages: string[];
};
type BarcodePlan = {
  rowNumber: number;
  action: "reuse" | "supplier" | "generate" | "conflict";
  barcode: string | null;
  message: string;
};
type SupplierPurchaseResult = {
  replayed: boolean;
  operationId: number;
  voucherId: number;
  purchaseTotal: string;
  baseTotal: string;
  currency: string;
  items: Array<{ rowNumber: number; variantId: number; barcode: string; quantity: number }>;
};
type CatalogPreview = {
  decisions: CatalogDecision[];
  barcodePlans: BarcodePlan[];
  summary: { newProducts: number; newVariants: number; existingVariants: number; conflicts: number };
};
const catalogLabels: Record<CatalogDecision["status"], string> = {
  "new-product": "New product",
  "new-variant": "New variant",
  "existing-variant": "Existing variant — restock",
  conflict: "Catalog conflict",
};

function localISODate() {
  const date = new Date();
  const digits = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${digits(date.getMonth() + 1)}-${digits(date.getDate())}`;
}

function spreadsheetText(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if ("result" in value) return value.result;
  if ("text" in value) return value.text;
  if ("richText" in value && Array.isArray(value.richText)) {
    return value.richText.map((part: { text?: string }) => part.text ?? "").join("");
  }
  return value;
}

async function downloadSupplierTemplate() {
  const sample = [
    {
      "Item Name": "Runner 270",
      Category: "Shoes",
      Brand: "Acme",
      Size: "42",
      Color: "Black",
      Quantity: 10,
      "Cost Price": 35,
      "Selling Price": 65,
      "Main Image": "runner-black.jpg",
      "Extra Images": "runner-black-side.jpg; runner-black-back.jpg",
      SKU: "",
      Barcode: "",
      Description: "Demo example - replace before uploading",
    },
    {
      "Item Name": "Cotton T-Shirt",
      Category: "Clothing",
      Brand: "Acme",
      Size: "M",
      Color: "White",
      Quantity: 20,
      "Cost Price": 12,
      "Selling Price": 24.99,
      "Main Image": "tee-white.jpg",
      "Extra Images": "",
      SKU: "",
      Barcode: "",
      Description: "Demo example - replace before uploading",
    },
  ];
  const workbook = utils.book_new();
  const sheet = utils.json_to_sheet(sample, { header: [...RETAIL_SUPPLIER_TEMPLATE_COLUMNS] });
  const worksheet = utils.book_append_sheet(workbook, sheet, "Supplier Stock");
  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).height = 24;
  worksheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B365D" } };
  });
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  // Preserve leading zeros in supplier barcodes and SKUs; never use Excel's
  // numeric/scientific display for scanner identities.
  worksheet.getColumn(11).numFmt = "@";
  worksheet.getColumn(12).numFmt = "@";
  worksheet.columns.forEach((column, index) => {
    column.width = index === 0 || index === 8 || index === 9 ? 29 : 17;
  });
  await writeFile(workbook, "retail_supplier_stock_template.xlsx");
}

export function RetailSupplierImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
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
  const catalogByRow = useMemo(
    () => new Map((catalogPreview?.decisions ?? []).map((decision) => [decision.rowNumber, decision])),
    [catalogPreview]
  );
  const barcodeByRow = useMemo(
    () => new Map((catalogPreview?.barcodePlans ?? []).map((plan) => [plan.rowNumber, plan])),
    [catalogPreview]
  );
  const issueRows = useMemo(
    () =>
      rows
        .map((row) => {
          const issues = [
            ...row.errors,
            ...(imageMatches.get(row.rowNumber)?.errors ?? []),
            ...(catalogByRow.get(row.rowNumber)?.status === "conflict"
              ? (catalogByRow.get(row.rowNumber)?.messages ?? [])
              : []),
          ];
          return { row, issues };
        })
        .filter((entry) => entry.issues.length > 0),
    [rows, imageMatches, catalogByRow]
  );
  const previewRows = showProblemsOnly ? issueRows.map((entry) => entry.row) : rows;

  const downloadImportErrors = () => {
    const csvCell = (value: string | number) => {
      const raw = String(value).replace(/[\r\n]+/g, " ");
      // Do not allow supplier-controlled product names to execute spreadsheet
      // formulas when the diagnostic CSV is opened in Excel.
      const safe = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = [
      ["Excel Row", "Item Name", "Brand", "Problems"].map(csvCell).join(","),
      ...issueRows.map(({ row, issues }) =>
        [row.rowNumber, row.name, row.brand, issues.join("; ")].map(csvCell).join(",")
      ),
    ].join("\r\n");
    const href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "retail_supplier_import_errors.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
  };
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
      if (
        !window.confirm(
          `Receive ${summary.totalUnits} items from ${knownSupplier?.legalName || knownSupplier?.name || "supplier"}? This posts the inventory and supplier credit voucher.`
        )
      ) {
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

  const handleSpreadsheet = async (file?: File) => {
    setFileName("");
    setRows([]);
    setFileError("");
    setPurchaseResult(null);
    setPostingError("");
    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
    if (!file) return;
    if (!/\.(xlsx|csv)$/i.test(file.name)) {
      setFileError("Choose an .xlsx or .csv spreadsheet");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setFileError("Spreadsheet must be 15 MB or smaller");
      return;
    }
    setBusy(true);
    try {
      const workbook = await read(await file.arrayBuffer());
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!worksheet) throw new Error("Spreadsheet has no worksheets");
      const headers: string[] = [];
      const sourceRows: SourceRow[] = [];
      worksheet.eachRow((excelRow, rowNumber) => {
        if (rowNumber === 1) {
          excelRow.eachCell((cell, colNumber) => {
            headers[colNumber - 1] = String(spreadsheetText(cell.value) ?? "").trim();
          });
          return;
        }
        const values: Record<string, unknown> = {};
        excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const header = headers[colNumber - 1];
          if (header) values[header] = spreadsheetText(cell.value);
        });
        if (Object.values(values).some((value) => value !== null && value !== undefined && String(value).trim())) {
          sourceRows.push({ rowNumber, values });
        }
      });
      const normalizedHeaders = headers.map((header) => header.toLowerCase().replace(/[ _-]+/g, ""));
      if (!normalizedHeaders.some((header) => header === "itemname" || header === "name")) {
        throw new Error("Missing Item Name column. Download the supplier template and keep its header row.");
      }
      if (!normalizedHeaders.includes("quantity") && !normalizedHeaders.includes("qty")) {
        throw new Error("Missing Quantity column");
      }
      if (!sourceRows.length) throw new Error("No stock rows found in the spreadsheet");
      if (sourceRows.length > RETAIL_SUPPLIER_IMPORT_LIMIT) {
        throw new Error(`Maximum ${RETAIL_SUPPLIER_IMPORT_LIMIT.toLocaleString()} rows per import`);
      }
      const parsed = parseRetailSupplierImportRows(sourceRows);
      setRows(parsed);
      setFileName(file.name);
      const invalid = parsed.filter((row) => row.errors.length).length;
      toast({
        title: invalid ? "Spreadsheet needs corrections" : "Spreadsheet preview ready",
        description: invalid
          ? `${invalid} row(s) have validation errors. No stock was changed.`
          : `${parsed.length} row(s) checked. No stock or ledger changes were made.`,
      });
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Could not read spreadsheet");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open && !receiptLabelsOpen && !historyOpen} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between gap-2">
              <DialogTitle className="flex items-center gap-2">
                <FileSpreadsheet className="h-5 w-5" />
                Supplier Stock Import
              </DialogTitle>
              <Button type="button" size="sm" variant="outline" onClick={() => setHistoryOpen(true)}>
                <History className="mr-2 h-4 w-4" />
                Import history
              </Button>
            </div>
          </DialogHeader>
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
            <strong>Supplier stock import.</strong> Confirming receives additional units, posts the inventory debit and
            supplier payable credit together, then opens the barcode label dialog with one label per unit received (in
            printable batches). The selected Retail company must have completed its inventory accounting opening before
            importing supplier purchases.
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="retail-import-supplier">Supplier *</Label>
              <select
                id="retail-import-supplier"
                value={supplierId}
                onChange={(event) => {
                  setSupplierId(event.target.value);
                  setPurchaseResult(null);
                  setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Select an existing supplier</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={String(supplier.id)}>
                    {supplier.legalName || supplier.name || supplier.code || `Supplier #${supplier.id}`}
                  </option>
                ))}
              </select>
              {suppliersFailed && <p className="text-xs text-destructive">Suppliers could not be loaded.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="retail-import-location">Receiving location *</Label>
              <select
                id="retail-import-location"
                value={locationId}
                onChange={(event) => {
                  setLocationId(event.target.value);
                  setPurchaseResult(null);
                  setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Select a stock location</option>
                {locations
                  .filter((location) => location.active !== false)
                  .map((location) => (
                    <option key={location.id} value={String(location.id)}>
                      {location.name} ({location.code})
                    </option>
                  ))}
              </select>
              {locationsFailed && <p className="text-xs text-destructive">Locations could not be loaded.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="retail-import-invoice">Supplier invoice / reference</Label>
              <Input
                id="retail-import-invoice"
                value={invoiceReference}
                onChange={(event) => {
                  setInvoiceReference(event.target.value);
                  setPurchaseResult(null);
                  setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                }}
                placeholder="INV-0001"
                maxLength={100}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="retail-import-date">Receipt date *</Label>
                <Input
                  id="retail-import-date"
                  type="date"
                  value={invoiceDate}
                  onChange={(event) => {
                    setInvoiceDate(event.target.value);
                    setPurchaseResult(null);
                    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="retail-import-currency">Invoice currency</Label>
                <select
                  id="retail-import-currency"
                  value={currency}
                  onChange={(event) => {
                    setCurrency(event.target.value);
                    setPurchaseResult(null);
                    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                  }}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {["USD", "EUR", "CDF", "CFA", "GBP", "AUD"].map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2 md:col-span-2">
              <label htmlFor="retail-supplier-partial" className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  id="retail-supplier-partial"
                  type="checkbox"
                  className="mt-1"
                  checked={partialReceipt}
                  onChange={(event) => {
                    setPartialReceipt(event.target.checked);
                    setDeliveryReference("");
                    setPurchaseResult(null);
                    setPostingError("");
                    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                  }}
                />
                <span>
                  <strong>Partial delivery against this supplier invoice</strong>
                  <span className="block text-xs text-muted-foreground">
                    Use only the actually received units in this Excel file. Each shipment needs a unique delivery
                    reference; earlier delivered stock and debt remain unchanged.
                  </span>
                </span>
              </label>
              {partialReceipt && (
                <div className="space-y-1">
                  <Label htmlFor="retail-supplier-delivery">Delivery / packing list reference *</Label>
                  <Input
                    id="retail-supplier-delivery"
                    value={deliveryReference}
                    maxLength={100}
                    placeholder="DELIVERY-001"
                    onChange={(event) => {
                      setDeliveryReference(event.target.value);
                      setPurchaseResult(null);
                      setPostingError("");
                      setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                    }}
                  />
                </div>
              )}
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="retail-supplier-invoice-file">Supplier invoice attachment (optional)</Label>
              <Input
                id="retail-supplier-invoice-file"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  const valid =
                    !file ||
                    (/\.(pdf|jpe?g|png)$/i.test(file.name) &&
                      ["application/pdf", "image/jpeg", "image/png"].includes(file.type) &&
                      file.size > 0 &&
                      file.size <= 10 * 1024 * 1024);
                  setInvoiceFile(valid ? file : null);
                  setInvoiceFileError(valid ? "" : "Use a PDF, JPG or PNG invoice, maximum 10 MB.");
                  uploadedInvoiceCache.current = null;
                  setPurchaseResult(null);
                  setPostingError("");
                  setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                }}
              />
              {invoiceFile && (
                <p className="text-xs text-muted-foreground">
                  <FileText className="mr-1 inline h-3 w-3" />
                  {invoiceFile.name} — saved with the receipt
                </p>
              )}
              {invoiceFileError && (
                <p role="alert" className="text-xs text-destructive">
                  {invoiceFileError}
                </p>
              )}
            </div>
            {needsRate && (
              <div className="space-y-1.5">
                <Label htmlFor="retail-supplier-exchange">Historical exchange rate *</Label>
                <Input
                  id="retail-supplier-exchange"
                  inputMode="decimal"
                  value={exchangeRate}
                  onChange={(event) => {
                    setExchangeRate(event.target.value);
                    setPurchaseResult(null);
                    setImportKey(`retail-supplier-${crypto.randomUUID()}`);
                  }}
                  placeholder="USD value of 1 unit of invoice currency"
                />
                <p className="text-xs text-muted-foreground">
                  Enter USD per 1 unit of invoice currency (e.g. 1 EUR = 1.18 USD, enter 1.18). The converted historical
                  rate is saved on the voucher.
                </p>
                {!validRate && <p className="text-xs text-destructive">A positive exchange rate is required.</p>}
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">1. Download the supplier Excel template</h3>
                <p className="text-xs text-muted-foreground">
                  One line per product color/size. Cost Price is in the supplier invoice currency; Selling Price is the
                  Retail POS price in USD. Keep SKU and Barcode columns formatted as Text to preserve leading zeros.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  downloadSupplierTemplate().catch((error) =>
                    toast({
                      title: "Template download failed",
                      description: error instanceof Error ? error.message : String(error),
                      variant: "destructive",
                    })
                  )
                }
              >
                <FileSpreadsheet className="mr-2 h-4 w-4" /> Download template
              </Button>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="retail-supplier-excel">2. Upload Excel / CSV *</Label>
                <Input
                  key={importKey}
                  id="retail-supplier-excel"
                  type="file"
                  accept=".xlsx,.csv"
                  onChange={(event) => void handleSpreadsheet(event.target.files?.[0])}
                  disabled={busy}
                />
                {fileName && <p className="text-xs text-muted-foreground">{fileName}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="retail-supplier-photos">3. Product image ZIP (optional)</Label>
                <Input
                  key={importKey}
                  id="retail-supplier-photos"
                  type="file"
                  accept=".zip"
                  disabled={photoBusy}
                  onChange={(event) => void handlePhotoArchive(event.target.files?.[0])}
                />
                <p className="text-xs text-muted-foreground">
                  <ImageIcon className="mr-1 inline h-3 w-3" />
                  {photoArchiveName
                    ? `${photoArchiveName} — ${photoArchive?.imageCount ?? 0} verified images`
                    : photoBusy
                      ? "Checking picture ZIP…"
                      : "Choose ZIP with JPG/PNG/WEBP/GIF files referenced by their filenames in Excel."}
                </p>
                {photoError && (
                  <p role="alert" className="text-xs text-destructive">
                    {photoError}
                  </p>
                )}
              </div>
            </div>
            {fileError && (
              <p role="alert" className="text-sm text-destructive">
                {fileError}
              </p>
            )}
          </div>

          {rows.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-md border px-2 py-1">
                  <Package className="mr-1 inline h-4 w-4" />
                  {summary.totalRows} lines
                </span>
                <span className="rounded-md border px-2 py-1">{summary.validRows} valid</span>
                <span className="rounded-md border px-2 py-1">{summary.totalUnits} valid units</span>
                <span className="rounded-md border px-2 py-1">
                  {currency}{" "}
                  {summary.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}{" "}
                  estimated cost (valid lines)
                </span>
                {summary.invalidRows > 0 && (
                  <span className="text-destructive">
                    <AlertTriangle className="mr-1 inline h-4 w-4" />
                    {summary.invalidRows} invalid lines
                  </span>
                )}
                <span className="rounded-md border px-2 py-1">{imageMatchedCount} images matched</span>
                {imageIssueCount > 0 && (
                  <span className="text-destructive">{imageIssueCount} rows missing/invalid pictures</span>
                )}
              </div>
              {catalogChecking && (
                <p className="text-xs text-muted-foreground">
                  Checking product / variant identities against this company's catalog…
                </p>
              )}
              {catalogFailed && (
                <p role="alert" className="text-xs text-destructive">
                  Catalog check failed; supplier import cannot be confirmed without reconciling existing items.
                </p>
              )}
              {catalogPreview && (
                <div className="space-y-1">
                  <p className="text-xs font-medium">
                    Catalog: {catalogPreview.summary.newProducts} new styles · {catalogPreview.summary.newVariants} new
                    variants · {catalogPreview.summary.existingVariants} existing variants ·{" "}
                    {catalogPreview.summary.conflicts} conflicts
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Barcodes: {catalogPreview.barcodePlans.filter((plan) => plan.action === "reuse").length} existing
                    retained · {catalogPreview.barcodePlans.filter((plan) => plan.action === "supplier").length}{" "}
                    supplier codes kept ·{" "}
                    {catalogPreview.barcodePlans.filter((plan) => plan.action === "generate").length} to generate on
                    confirmation
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Supplier: {knownSupplier?.legalName || knownSupplier?.name || "not selected"} · Location:{" "}
                {knownLocation?.name || "not selected"} · Reference: {invoiceReference || "not provided"} · Date:{" "}
                {invoiceDate || "not selected"}.
                {purchaseResult
                  ? "This purchase has been recorded."
                  : "This is a preview until you confirm the purchase."}
              </p>
              {issueRows.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-destructive">{issueRows.length} rows need corrections</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setShowProblemsOnly((value) => !value)}
                  >
                    {showProblemsOnly ? "Show all rows" : "Show only error rows"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={downloadImportErrors}>
                    Download all errors (CSV)
                  </Button>
                </div>
              )}
              <div className="max-h-72 overflow-auto rounded-md border">
                <table className="w-full min-w-[900px] text-left text-xs">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      {[
                        "Row",
                        "Picture",
                        "Item / Brand",
                        "Category",
                        "Variant",
                        "Qty",
                        "Unit cost",
                        "Sell price",
                        "Barcode",
                        "Catalog / Validation",
                      ].map((col) => (
                        <th className="whitespace-nowrap px-2 py-2 font-semibold" key={col}>
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.slice(0, 100).map((row) => (
                      <tr key={row.rowNumber} className="border-t align-top">
                        <td className="px-2 py-2">{row.rowNumber}</td>
                        <td className="px-2 py-2">
                          {photoPreviewUrls.get(row.rowNumber) ? (
                            <img
                              src={photoPreviewUrls.get(row.rowNumber)}
                              alt={row.name}
                              className="h-12 w-12 rounded border object-contain"
                            />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          <span className="whitespace-nowrap text-muted-foreground">
                            {imageMatches.get(row.rowNumber)?.files.length ?? 0} image(s)
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <strong>{row.name || "—"}</strong>
                          <div>{row.brand}</div>
                        </td>
                        <td className="px-2 py-2">{row.category || "—"}</td>
                        <td className="px-2 py-2">
                          {row.color} / {row.size || "Standard"}
                        </td>
                        <td className="px-2 py-2">{row.quantity}</td>
                        <td className="px-2 py-2">{row.costPrice.toFixed(2)}</td>
                        <td className="px-2 py-2">{row.sellingPrice.toFixed(2)}</td>
                        <td className="px-2 py-2">
                          {barcodeByRow.get(row.rowNumber)?.barcode || row.barcode || "Generate at confirmation"}
                          {barcodeByRow.get(row.rowNumber) && (
                            <div className="text-muted-foreground">
                              {barcodeByRow.get(row.rowNumber)?.action === "reuse"
                                ? "Existing · unchanged"
                                : barcodeByRow.get(row.rowNumber)?.action === "supplier"
                                  ? "Supplier code"
                                  : barcodeByRow.get(row.rowNumber)?.action === "conflict"
                                    ? "Barcode conflict"
                                    : "New EAN-13 (not reserved)"}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {row.errors.length ||
                          imageMatches.get(row.rowNumber)?.errors.length ||
                          catalogByRow.get(row.rowNumber)?.status === "conflict" ? (
                            <span className="text-destructive">
                              {[
                                ...row.errors,
                                ...(imageMatches.get(row.rowNumber)?.errors ?? []),
                                ...(catalogByRow.get(row.rowNumber)?.status === "conflict"
                                  ? (catalogByRow.get(row.rowNumber)?.messages ?? [])
                                  : []),
                              ].join("; ")}
                            </span>
                          ) : (
                            <span className="text-green-700 dark:text-green-400">
                              {catalogByRow.get(row.rowNumber)
                                ? catalogLabels[catalogByRow.get(row.rowNumber)!.status]
                                : "Local validation passed"}
                            </span>
                          )}
                          {catalogByRow.get(row.rowNumber)?.status !== "conflict" &&
                            catalogByRow.get(row.rowNumber)?.messages.map((msg, index) => (
                              <div key={index} className="text-muted-foreground">
                                {msg}
                              </div>
                            ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {previewRows.length > 100 && (
                <p className="text-xs text-muted-foreground">
                  Displaying first 100 of {previewRows.length} {showProblemsOnly ? "problem" : "total"} rows; all rows
                  were checked. Download errors for the complete list.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {readyForPosting
                  ? "Ready to receive the purchase and credit the selected supplier. Verify invoice-currency costs and USD retail selling prices before confirming."
                  : "Select a supplier/location/reference and resolve spreadsheet, image, rate and catalog conflicts before posting."}
              </p>
            </div>
          )}
          {uploadProgress && <p className="text-xs text-muted-foreground">{uploadProgress}</p>}
          {postingError && (
            <div role="alert" className="space-y-2 rounded-md border border-destructive/40 p-3 text-sm">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4" />
                <strong>
                  {purchaseResult ? "Posted receipt needs reconciliation" : "Supplier import needs attention"}
                </strong>
              </div>
              <p>{postingError}</p>
              {purchaseResult ? (
                <p className="text-xs text-muted-foreground">
                  The purchase is recorded. Do not re-import this invoice; review its stock movements and barcodes in
                  import history.
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Your Excel and uploaded pictures are retained for retry. Check whether the previous request posted
                    before retrying with the same invoice and request ID.
                  </p>
                  <Button type="button" size="sm" variant="outline" onClick={() => void checkPurchaseStatus()}>
                    <ShieldCheck className="mr-2 h-4 w-4" />
                    Check whether receipt was posted
                  </Button>
                </>
              )}
            </div>
          )}
          {purchaseResult && (
            <div className="rounded-md border p-3 text-sm">
              <strong>Purchase successfully recorded.</strong> Voucher #{purchaseResult.voucherId} ·{" "}
              {purchaseResult.items.length} variants · {purchaseResult.currency} {purchaseResult.purchaseTotal} credited
              to supplier.
              <p className="text-xs text-muted-foreground">
                Barcodes are saved. You can print or skip received-unit labels without affecting the posted stock or
                supplier balance.
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            {purchaseResult && (
              <Button type="button" variant="outline" onClick={startNextDelivery}>
                {partialReceipt ? "Start next delivery" : "New supplier import"}
              </Button>
            )}
            {purchaseResult && receiptLabelItems.length > 0 && (
              <Button type="button" variant="outline" onClick={() => setReceiptLabelsOpen(true)}>
                <Printer className="mr-2 h-4 w-4" />
                Print received labels
              </Button>
            )}
            <Button
              type="button"
              disabled={!readyForPosting || saveMutation.isPending || Boolean(purchaseResult)}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending
                ? "Processing…"
                : purchaseResult
                  ? "Purchase recorded"
                  : "Confirm supplier purchase"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <RetailSupplierImportHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        companyId={companyId}
        onReprint={(items) => {
          setReceiptLabelItems(items);
          setHistoryOpen(false);
          setReceiptLabelsOpen(true);
        }}
      />
      <RetailLabelPrintDialog
        open={receiptLabelsOpen}
        onOpenChange={setReceiptLabelsOpen}
        items={receiptLabelItems}
        currency="USD"
        purpose="supplier-receipt"
      />
    </>
  );
}
