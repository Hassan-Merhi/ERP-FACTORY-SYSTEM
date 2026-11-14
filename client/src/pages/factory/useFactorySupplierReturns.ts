import Decimal from "decimal.js";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { getSupplierReturnsCopy } from "@/i18n/supplierReturnsTranslations";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { read, utils, writeFile } from "@/lib/excelHelper";
import { buildErpSupplierReturnMatchWorkbook } from "./erpSupplierReturnMatchWorkbook";
import { buildPostedSupplierReturnWorkbook, type PostedSupplierReturnRow } from "./erpSupplierReturnPostedWorkbook";
import { isValidSupplierReturnQuantity } from "./supplierReturnQuantityValidation";
import { validateSupplierReturnAllocations, type EditableAllocation } from "./supplierReturnAllocationReview";

interface Candidate {
  offloadItemId: number;
  offloadId: number;
  containerId: number;
  containerNumber: string;
  supplierId: number | null;
  supplierName: string | null;
  stockItemId: number;
  locationId: number;
  supplierCount: number;
  currencyCount: number;
  currency: string | null;
  code: string;
  name: string;
  originalQty: string;
  returnedQty: string;
  remainingQty: string;
  availableQty: string;
  unitPurchaseCost: string;
  unitLandedCost: string;
  averageCost: string;
}
interface PreviewRow {
  row: number;
  code: string;
  quantity: string;
  status: string;
  suggestedOffloadItemId: number | null;
  allocations?: EditableAllocation[];
  allocatedQty?: string;
  unallocatedQty?: string;
  candidates: Candidate[];
}
interface HistoryRow {
  id: number;
  returnDate: string;
  fileName: string | null;
  reason: string | null;
  createdBy: string | null;
  totalQty: string;
  supplierCreditUsd: string;
  inventoryReductionUsd: string;
  lineCount: number;
}
export const money = (v: string | number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(v));
function excelCode(row: Record<string, unknown>, names: string[]) {
  const entry = Object.entries(row).find(([key]) =>
    names.includes(
      key
        .toLowerCase()
        .trim()
        .replace(/[ _-]+/g, "")
    )
  );
  return entry?.[1];
}
export function useFactorySupplierReturns() {
  const { selectedCompany } = useCompany();
  const { language } = useApplicationLanguage();
  const copy = getSupplierReturnsCopy(language);
  const { toast } = useToast();
  const [sourceFile, setSourceFile] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [manualQty, setManualQty] = useState("1");
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [previewSupplierId, setPreviewSupplierId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportingBatch, setExportingBatch] = useState<number | null>(null);
  const suppliers = useQuery<{ rows: Array<{ id: number; name: string }> }>({
    queryKey: ["/api/erp/supplier-returns/suppliers", selectedCompany?.id],
    enabled: !!selectedCompany,
    queryFn: async () => (await apiRequest("GET", "/api/erp/supplier-returns/suppliers")).json(),
  });
  // Retry the same financial operation after a network error, never create a second posting.
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [rawRows, setRawRows] = useState<Array<{ code: string; quantity: string }>>([]);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [allocations, setAllocations] = useState<Record<number, EditableAllocation[]>>({});
  const [reason, setReason] = useState("");
  const [returnDate, setReturnDate] = useState(() => {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
  });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ id: number; totalQty?: string; replayed?: boolean } | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<number | null>(null);
  const [detailRows, setDetailRows] = useState<PostedSupplierReturnRow[]>([]);
  useEffect(() => {
    setSourceFile("");
    setManualCode("");
    setManualQty("1");
    setSupplierId(null);
    setPreviewSupplierId(null);
    setRawRows([]);
    setPreview([]);
    setAllocations({});
    setConfirm(false);
    setReceipt(null);
    setRequestKey(crypto.randomUUID());
  }, [selectedCompany?.id]);

  const history = useQuery<{ rows: HistoryRow[] }>({
    queryKey: ["/api/erp/supplier-returns/history", selectedCompany?.id],
    enabled: !!selectedCompany,
    queryFn: async () => (await apiRequest("GET", "/api/erp/supplier-returns/history")).json(),
  });

  const combined = useMemo(
    () => validateSupplierReturnAllocations(preview, allocations),
    [preview, allocations]
  );
  const ready = preview.length > 0 && previewSupplierId === supplierId && combined.valid;
  const totalBales = preview.reduce((total, row) => total.plus(row.quantity), new Decimal(0)).toFixed(3);
  function changeAllocation(row: number, index: number, change: Partial<EditableAllocation>) {
    setAllocations((current) => ({
      ...current,
      [row]: (current[row] ?? []).map((line, at) => at === index ? { ...line, ...change } : line),
    }));
    setConfirm(false);
  }
  function addAllocation(row: number) {
    setAllocations((current) => ({
      ...current,
      [row]: [...(current[row] ?? []), { offloadItemId: 0, quantity: "" }],
    }));
    setConfirm(false);
  }
  function removeAllocation(row: number, index: number) {
    setAllocations((current) => ({
      ...current,
      [row]: (current[row] ?? []).filter((_, at) => at !== index),
    }));
    setConfirm(false);
  }
  function addManual() {
    const code = manualCode.trim();
    const qty = manualQty.trim();
    if (
      !code ||
      code.length > 50 ||
      !isValidSupplierReturnQuantity(qty) ||
      Number(qty) <= 0 ||
      rawRows.length >= 1000
    ) {
      toast({ title: copy.invalidManual, variant: "destructive" });
      return;
    }
    setRawRows((current) => [...current, { code, quantity: qty }]);
    setManualCode("");
    setManualQty("1");
    setSourceFile("");
    setPreview([]);
    setPreviewSupplierId(null);
    setAllocations({});
    setReceipt(null);
    setConfirm(false);
    setRequestKey(crypto.randomUUID());
  }

  async function exportPreview() {
    if (!preview.length || busy || exporting || previewSupplierId !== supplierId) return;
    setExporting(true);
    try {
      const wb = utils.book_new();
      buildErpSupplierReturnMatchWorkbook(wb, {
        supplierName: suppliers.data?.rows.find((x) => x.id === supplierId)?.name,
        fileName: sourceFile || undefined,
        language,
        entries: combined.entries.flatMap((entry) => {
          const lines = entry.lines.map((line) => ({
            row: entry.row.row,
            code: preview.find((p) => p.row === entry.row.row)?.code ?? "",
            quantity: line.allocation.quantity,
            requestedQuantity: entry.row.quantity,
            status: entry.valid && combined.valid ? "matched" : "review-allocation",
            candidate: line.candidate,
            valid: entry.valid && line.valid &&
              !!line.candidate &&
              !combined.overSources.has(line.candidate.offloadItemId) &&
              !combined.overStock.has(line.candidate.locationId + ":" + line.candidate.stockItemId),
          }));
          return lines.length ? lines : [{
            row: entry.row.row,
            code: preview.find((p) => p.row === entry.row.row)?.code ?? "",
            quantity: entry.row.quantity,
            requestedQuantity: entry.row.quantity,
            status: "unallocated",
            candidate: undefined,
            valid: false,
          }];
        }),
      });
      await writeFile(wb, "ERP_Supplier_Return_Container_Matches.xlsx");
      toast({ title: copy.exported, description: copy.exportPreviewNote });
    } catch (e) {
      toast({ title: copy.exportFailed, description: (e as Error).message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  async function downloadTemplate() {
    const wb = utils.book_new();
    utils.book_append_sheet(
      wb,
      utils.json_to_sheet([
        { article_code: "ITEM001", qty: 2 },
        { article_code: "ITEM002", qty: 1 },
      ]),
      "Supplier Returns"
    );
    await writeFile(wb, "supplier_return_template.xlsx");
  }
  async function upload(file?: File) {
    if (!file) return;
    setPreview([]);
    setPreviewSupplierId(null);
    setAllocations({});
    setConfirm(false);
    setReceipt(null);
    setRawRows([]);
    setSourceFile(file.name);
    setRequestKey(crypto.randomUUID());
    try {
      const wb = await read(await file.arrayBuffer());
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error(copy.workbookMissing);
      const rows = utils.sheet_to_json(sheet) as Record<string, unknown>[];
      if (!rows.length || rows.length > 1000) throw new Error(copy.workbookRows);
      const parsed = rows.map((row, index) => {
        const code = String(excelCode(row, ["articlecode", "code", "itemcode", "barcode"]) ?? "").trim();
        const quantity = String(excelCode(row, ["qty", "quantity", "bales"]) ?? "").trim();
        if (!code || !isValidSupplierReturnQuantity(quantity) || Number(quantity) <= 0)
          throw new Error([copy.rowInvalid, index + 2].join(" "));
        return { code, quantity };
      });
      setRawRows(parsed);
      toast({
        title: copy.readTitle,
        description: [parsed.length, copy.readBody].join(" "),
      });
    } catch (e) {
      toast({ title: copy.invalidExcel, description: (e as Error).message, variant: "destructive" });
    }
  }
  async function mapRows() {
    setBusy(true);
    setConfirm(false);
    setReceipt(null);
    setPreview([]);
    setPreviewSupplierId(null);
    try {
      const result = (await (
        await apiRequest("POST", "/api/erp/supplier-returns/preview", { rows: rawRows, supplierId })
      ).json()) as { rows: PreviewRow[]; supplierId: number | null };
      setPreview(result.rows);
      setPreviewSupplierId(result.supplierId);
      setAllocations(Object.fromEntries(result.rows.map((row) => [
        row.row, row.allocations ?? (row.suggestedOffloadItemId
          ? [{ offloadItemId: row.suggestedOffloadItemId, quantity: row.quantity }]
          : []),
      ])));
      toast({
        title: copy.mappedTitle,
        description: copy.mappedBody,
      });
    } catch (e) {
      toast({ title: copy.mapFailed, description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  async function openBatch(id: number) {
    if (selectedBatch === id) {
      setSelectedBatch(null);
      return;
    }
    try {
      const detail = (await (await apiRequest("GET", `/api/erp/supplier-returns/history/${id}`)).json()) as {
        rows: typeof detailRows;
      };
      setDetailRows(detail.rows);
      setSelectedBatch(id);
    } catch (e) {
      toast({ title: copy.historyFailed, description: (e as Error).message, variant: "destructive" });
    }
  }
  async function exportPostedBatch(batch: HistoryRow) {
    if (exportingBatch !== null || busy) return;
    setExportingBatch(batch.id);
    try {
      const details = (await (
        await apiRequest("GET", `/api/erp/supplier-returns/history/${batch.id}`)
      ).json()) as { rows: PostedSupplierReturnRow[] };
      const wb = utils.book_new();
      buildPostedSupplierReturnWorkbook(wb, {
        id: batch.id,
        returnDate: batch.returnDate,
        fileName: batch.fileName,
        reason: batch.reason,
        totalQty: batch.totalQty,
        supplierCreditUsd: batch.supplierCreditUsd,
        inventoryReductionUsd: batch.inventoryReductionUsd,
      }, details.rows, language);
      await writeFile(wb, `ERP_Supplier_Return_Batch_${batch.id}.xlsx`);
      toast({ title: copy.exported });
    } catch (e) {
      toast({ title: copy.exportFailed, description: (e as Error).message, variant: "destructive" });
    } finally {
      setExportingBatch(null);
    }
  }
  async function post() {
    if (!ready || !confirm || busy) return;
    setBusy(true);
    try {
      const totals = new Map<number, Decimal>();
      for (const entry of combined.entries) {
        for (const { allocation } of entry.lines) {
          totals.set(allocation.offloadItemId,
            (totals.get(allocation.offloadItemId) ?? new Decimal(0)).plus(allocation.quantity));
        }
      }
      const lines = [...totals].map(([offloadItemId, qty]) => ({ offloadItemId, quantity: qty.toFixed(3) }));
      const response = (await (
        await apiRequest("POST", "/api/erp/supplier-returns/commit", {
          lines,
          requestedRows: combined.entries.map((entry) => ({
            code: preview.find((row) => row.row === entry.row.row)?.code ?? "",
            quantity: entry.row.quantity,
            allocations: entry.lines.map(({ allocation }) => ({
              offloadItemId: allocation.offloadItemId,
              quantity: allocation.quantity,
            })),
          })),
          supplierId,
          requestKey,
          returnDate,
          reason,
          fileName: sourceFile,
        })
      ).json()) as { id: number; totalQty: string; replayed: boolean };
      setReceipt(response);
      setConfirm(false);
      setRequestKey(crypto.randomUUID());
      await queryClient.invalidateQueries();
      toast({
        title: copy.success,
        description: [copy.batch, `#${response.id}:`, response.totalQty, copy.balesPosted].join(" "),
      });
    } catch (e) {
      toast({ title: copy.postFailed, description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }
  return {
    copy,
    downloadTemplate,
    sourceFile,
    upload,
    mapRows,
    busy,
    rawRows,
    suppliers,
    supplierId,
    receipt,
    setSupplierId,
    setPreview,
    setAllocations,
    setPreviewSupplierId,
    setConfirm,
    setRequestKey,
    manualCode,
    setManualCode,
    addManual,
    manualQty,
    setManualQty,
    setRawRows,
    setSourceFile,
    returnDate,
    setReturnDate,
    reason,
    setReason,
    preview,
    combined,
    totalBales,
    exporting,
    exportPreview,
    previewSupplierId,
    changeAllocation,
    removeAllocation,
    addAllocation,
    ready,
    confirm,
    post,
    history,
    selectedBatch,
    openBatch,
    exportingBatch,
    exportPostedBatch,
    detailRows,
  };
}
