import Decimal from "decimal.js";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { getSupplierReturnsCopy } from "@/i18n/supplierReturnsTranslations";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, PackageMinus, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
const money = (v: string | number) =>
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
export default function FactorySupplierReturns() {
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
  return (
    <div className="space-y-5 max-w-full" data-testid="factory-supplier-returns">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <PackageMinus className="h-5 w-5" />
            {copy.header}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">{copy.intro}</p>
        </div>
        <Button variant="outline" onClick={() => void downloadTemplate()}>
          <Download className="h-4 w-4 mr-2" />
          {copy.template}
        </Button>
      </div>
      <div className="rounded-lg border p-4 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="cursor-pointer inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium">
            <Upload className="h-4 w-4" />
            {copy.upload}
            <input
              type="file"
              accept=".xlsx,.xls"
              className="sr-only"
              onChange={(event) => void upload(event.currentTarget.files?.[0])}
            />
          </label>
          <span className="text-sm text-muted-foreground">{sourceFile || copy.manualEntry}</span>
          <Button onClick={() => void mapRows()} disabled={busy || !rawRows.length}>
            <RefreshCw className="h-4 w-4 mr-2" />
            {copy.map}
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="text-sm space-y-1 sm:col-span-3">
            <span>{copy.filterSupplier}</span>
            <select
              className="flex h-10 w-full max-w-lg rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={supplierId ?? ""}
              disabled={busy || !!receipt}
              onChange={(event) => {
                setSupplierId(Number(event.target.value) || null);
                setPreview([]);
                setAllocations({});
                setPreviewSupplierId(null);
                setConfirm(false);
                setRequestKey(crypto.randomUUID());
              }}
            >
              <option value="">{copy.allSuppliers}</option>
              {(suppliers.data?.rows ?? []).map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
            {suppliers.isError && <span className="text-destructive">{copy.supplierListError}</span>}
          </label>
          <div className="sm:col-span-3 flex flex-wrap items-end gap-3 rounded-md bg-muted/30 p-3">
            <label className="text-sm space-y-1 min-w-52 flex-1">
              <span>{copy.manualArticle}</span>
              <Input
                value={manualCode}
                maxLength={50}
                onChange={(event) => setManualCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addManual();
                  }
                }}
                placeholder={copy.manualArticlePlaceholder}
              />
            </label>
            <label className="text-sm space-y-1 w-28">
              <span>{copy.qty}</span>
              <Input value={manualQty} onChange={(event) => setManualQty(event.target.value)} />
            </label>
            <Button variant="outline" type="button" onClick={addManual} disabled={busy || !!receipt}>
              {copy.addArticle}
            </Button>
          </div>
          {rawRows.length > 0 && (
            <div className="sm:col-span-3 flex flex-wrap gap-2 items-center text-sm">
              <span>
                {rawRows.length} {copy.lines} {copy.staged}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !!receipt}
                onClick={() => {
                  setRawRows([]);
                  setPreview([]);
                  setAllocations({});
                  setConfirm(false);
                  setSourceFile("");
                  setPreviewSupplierId(null);
                  setRequestKey(crypto.randomUUID());
                }}
              >
                {copy.clearRows}
              </Button>
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="text-sm space-y-1">
            <span>{copy.date}</span>
            <Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
          </label>
          <label className="text-sm space-y-1 sm:col-span-2">
            <span>{copy.reason}</span>
            <Input
              placeholder={copy.reasonPlaceholder}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">{copy.warning}</p>
      </div>
      {preview.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="px-4 py-3 border-b flex flex-wrap gap-3 justify-between">
            <strong>
              {copy.mapping}: {combined.entries.filter((entry) => entry.valid).length}/{preview.length} {copy.validRows}
            </strong>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm">
                {copy.totalRequested}: <strong>{totalBales}</strong>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void exportPreview()}
                disabled={busy || exporting || previewSupplierId !== supplierId}
              >
                <Download className="h-4 w-4 mr-1" />
                {exporting ? copy.exporting : copy.exportPreview}
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  {[
                    copy.row,
                    copy.article,
                    copy.qty,
                    copy.source,
                    copy.offloaded,
                    copy.returned,
                    copy.remaining,
                    copy.stock,
                    copy.costs,
                    copy.status,
                  ].map((h) => (
                    <th key={h} className="text-left p-2 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {combined.entries.map((entry) => {
                  const row = preview.find((item) => item.row === entry.row.row)!;
                  const first = entry.lines.find((line) => line.candidate)?.candidate;
                  const overLimit = entry.lines.some(({ candidate }) => candidate &&
                    (combined.overSources.has(candidate.offloadItemId) ||
                     combined.overStock.has(candidate.locationId + ":" + candidate.stockItemId)));
                  const valid = entry.valid && !overLimit;
                  const sourceOptions = row.candidates.filter((x) =>
                    x.supplierCount === 1 && x.supplierId !== null &&
                    x.currencyCount === 1 && x.currency === "USD"
                  );
                  const rowSupplier = entry.lines.find((line) => line.candidate)?.candidate?.supplierId;
                  return (
                    <tr key={row.row} className="border-t align-top">
                      <td className="p-2">{row.row}</td>
                      <td className="p-2"><strong>{row.code}</strong>
                        <div className="text-muted-foreground">{first?.name}</div>
                      </td>
                      <td className="p-2 font-mono">{row.quantity}</td>
                      <td className="p-2 min-w-80 space-y-2">
                        {entry.lines.map(({ allocation, candidate }, index) => (
                          <div key={index} className="rounded border p-2 space-y-1">
                            <div className="flex flex-wrap gap-1 items-center">
                              <select
                                aria-label={`Container for row ${row.row} allocation ${index + 1}`}
                                disabled={busy || !!receipt}
                                className="flex-1 min-w-40 max-w-full rounded border bg-background px-2 py-1"
                                value={allocation.offloadItemId || ""}
                                onChange={(e) => changeAllocation(row.row, index, {
                                  offloadItemId: Number(e.target.value) || 0,
                                })}
                              >
                                <option value="">Choose container</option>
                                {sourceOptions.filter((source) =>
                                  (rowSupplier == null || source.supplierId === rowSupplier ||
                                   source.offloadItemId === allocation.offloadItemId) &&
                                  (!entry.lines.some((line, at) => at !== index &&
                                    line.allocation.offloadItemId === source.offloadItemId) ||
                                   source.offloadItemId === allocation.offloadItemId)
                                ).map((source) => (
                                  <option key={source.offloadItemId} value={source.offloadItemId}>
                                    {source.containerNumber} (remaining {source.remainingQty})
                                  </option>
                                ))}
                              </select>
                              <Input
                                aria-label={`Quantity for row ${row.row} allocation ${index + 1}`}
                                className="w-24 font-mono"
                                inputMode="decimal"
                                value={allocation.quantity}
                                disabled={busy || !!receipt}
                                onChange={(e) => changeAllocation(row.row, index, { quantity: e.target.value })}
                              />
                              <Button type="button" size="sm" variant="ghost"
                                disabled={busy || !!receipt}
                                onClick={() => removeAllocation(row.row, index)}
                                aria-label={`Remove allocation ${index + 1} from row ${row.row}`}>
                                Remove
                              </Button>
                            </div>
                            {candidate && (
                              <div className="text-xs text-muted-foreground">
                                Offload #{candidate.offloadId} · {candidate.supplierName} ·
                                remaining {candidate.remainingQty} · stock {candidate.availableQty} ·
                                purchase {money(candidate.unitPurchaseCost)} / landed {money(candidate.unitLandedCost)} · avg stock/bale {money(candidate.averageCost)}
                              </div>
                            )}
                          </div>
                        ))}
                        <Button type="button" variant="outline" size="sm"
                          disabled={busy || !!receipt || entry.lines.length >= sourceOptions.length}
                          onClick={() => addAllocation(row.row)}>+ Add container</Button>
                        <div className="text-xs font-mono">
                          Allocated {entry.allocatedQty} / {row.quantity} ·
                          Unallocated {entry.unallocatedQty}
                        </div>
                      </td>
                      <td className="p-2 font-mono">{entry.lines.map((line) => line.candidate?.originalQty ?? "—").join(" / ") || "—"}</td>
                      <td className="p-2 font-mono">{entry.lines.map((line) => line.candidate?.returnedQty ?? "—").join(" / ") || "—"}</td>
                      <td className="p-2 font-mono">{entry.lines.map((line) => line.candidate?.remainingQty ?? "—").join(" / ") || "—"}</td>
                      <td className="p-2 font-mono">{entry.lines.map((line) => line.candidate?.availableQty ?? "—").join(" / ") || "—"}</td>
                      <td className="p-2 font-mono">
                        {entry.lines.map((line) => line.candidate ? `${money(line.candidate.unitPurchaseCost)} / ${money(line.candidate.unitLandedCost)}` : "—").join("; ") || "—"}
                      </td>
                      <td className="p-2">
                        {valid ? (
                          <span className="text-green-600 inline-flex gap-1 items-center">
                            <CheckCircle2 className="h-4 w-4" />{copy.ready}
                          </span>
                        ) : (
                          <span className="text-amber-600 inline-flex gap-1 items-center">
                            <AlertTriangle className="h-4 w-4" />
                            {!row.candidates.length ? copy.notFound :
                              overLimit ? copy.reviewQty :
                              entry.lines.length === 0 ? copy.selectContainer : copy.reviewQty}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {preview.length > 0 && (
        <div className="rounded-lg border p-4 flex flex-wrap gap-4 items-center justify-between">
          <label className="flex gap-2 items-start text-sm">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
              disabled={!ready || !!receipt}
              className="mt-1"
            />
            {copy.confirmation}
          </label>
          <Button disabled={!ready || !confirm || busy || !!receipt} onClick={() => void post()}>
            {busy ? copy.processing : copy.confirmButton}
          </Button>
        </div>
      )}
      {receipt && (
        <div className="border rounded-lg p-4 text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4 inline mr-2" />
          {copy.batch} #{receipt.id}: {copy.successBody}
        </div>
      )}
      <div className="rounded-lg border overflow-hidden">
        <div className="p-4 flex items-center justify-between">
          <strong>{copy.history}</strong>
          <Button variant="outline" size="sm" onClick={() => void history.refetch()}>
            {copy.refresh}
          </Button>
        </div>
        {history.isLoading ? (
          <p className="p-4 text-sm">{copy.loadingHistory}</p>
        ) : history.isError ? (
          <p className="p-4 text-sm text-destructive">{copy.unavailable}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  {[
                    copy.batch,
                    copy.date,
                    copy.fileReference,
                    copy.by,
                    copy.lines,
                    copy.balesRemoved,
                    copy.supplierCredit,
                    copy.inventoryReduction,
                    copy.exportPreview,
                  ].map((x) => (
                    <th key={x} className="p-2 text-left">
                      {x}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.data?.rows?.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-2">
                      <Button size="sm" variant="ghost" onClick={() => void openBatch(r.id)}>
                        #{r.id} {selectedBatch === r.id ? `(${copy.hide})` : `(${copy.view})`}
                      </Button>
                    </td>
                    <td className="p-2">{r.returnDate}</td>
                    <td className="p-2">
                      {r.fileName || copy.manual}
                      <div className="text-muted-foreground text-xs">{r.reason}</div>
                    </td>
                    <td className="p-2">{r.createdBy}</td>
                    <td className="p-2">{r.lineCount}</td>
                    <td className="p-2 font-mono">{r.totalQty}</td>
                    <td className="p-2 font-mono">{money(r.supplierCreditUsd)}</td>
                    <td className="p-2 font-mono">{money(r.inventoryReductionUsd)}</td>
                    <td className="p-2">
                      <Button variant="outline" size="sm"
                        disabled={busy || exportingBatch !== null}
                        onClick={() => void exportPostedBatch(r)}>
                        <Download className="h-4 w-4 mr-1" />
                        {exportingBatch === r.id ? copy.exporting : "Posted Excel"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {selectedBatch !== null && (
          <div className="border-t p-4 space-y-2">
            <strong>
              {copy.batch} #{selectedBatch} — {copy.breakdown}
            </strong>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    {[
                      copy.article,
                      copy.itemName,
                      copy.container,
                      copy.originalOffload,
                      copy.supplier,
                      copy.qtyRemoved,
                      copy.supplierCredit,
                      copy.stockCost,
                      copy.voucher,
                      "Excel rows",
                      "Purchase / Bale",
                      "Inventory / Bale",
                      "Variance",
                    ].map((x) => (
                      <th key={x} className="p-2 text-left">
                        {x}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="p-2 font-mono">{r.articleCode}</td>
                      <td className="p-2">{r.itemName}</td>
                      <td className="p-2">{r.containerNumber}</td>
                      <td className="p-2">#{r.offloadId}</td>
                      <td className="p-2">{r.supplier}</td>
                      <td className="p-2 font-mono">{r.quantity}</td>
                      <td className="p-2">{money(r.supplierCreditUsd)}</td>
                      <td className="p-2">{money(r.inventoryReductionUsd)}</td>
                      <td className="p-2">{r.voucherNumber}</td>
                      <td className="p-2 text-xs">
                        {r.requestedRows?.map((a) =>
                          `#${a.inputRow}: ${a.allocatedQuantity}/${a.requestedQuantity}`
                        ).join(", ") || "—"}
                      </td>
                      <td className="p-2 font-mono">
                        {r.sourcePurchaseRate == null ? "—" : money(r.sourcePurchaseRate)}
                      </td>
                      <td className="p-2 font-mono">
                        {new Decimal(r.quantity).gt(0)
                          ? money(new Decimal(r.inventoryReductionUsd).div(r.quantity).toFixed(7)) : "—"}
                      </td>
                      <td className="p-2 font-mono">
                        {money(new Decimal(r.inventoryReductionUsd).minus(r.supplierCreditUsd).toFixed(2))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
