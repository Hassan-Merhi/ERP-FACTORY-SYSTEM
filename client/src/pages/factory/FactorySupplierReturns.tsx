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

interface Candidate {
  offloadItemId: number;
  offloadId: number;
  containerId: number;
  containerNumber: string;
  supplierId: number | null;
  supplierName: string | null;
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
}
interface PreviewRow {
  row: number;
  code: string;
  quantity: string;
  status: string;
  suggestedOffloadItemId: number | null;
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
function isEligible(item: Candidate, qty: string) {
  return (
    item.supplierCount === 1 &&
    item.currencyCount === 1 &&
    item.currency === "USD" &&
    new Decimal(item.remainingQty).gte(qty) &&
    new Decimal(item.availableQty).gte(qty)
  );
}
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
  const suppliers = useQuery<{ rows: Array<{ id: number; name: string }> }>({
    queryKey: ["/api/erp/supplier-returns/suppliers", selectedCompany?.id],
    enabled: !!selectedCompany,
    queryFn: async () => (await apiRequest("GET", "/api/erp/supplier-returns/suppliers")).json(),
  });
  // Retry the same financial operation after a network error, never create a second posting.
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [rawRows, setRawRows] = useState<Array<{ code: string; quantity: string }>>([]);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [chosen, setChosen] = useState<Record<number, number>>({});
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
  const [detailRows, setDetailRows] = useState<
    Array<{
      id: number;
      articleCode: string;
      itemName: string;
      quantity: string;
      containerNumber: string;
      offloadId: number;
      supplier: string;
      supplierCreditUsd: string;
      inventoryReductionUsd: string;
      voucherNumber: string | null;
    }>
  >([]);
  useEffect(() => {
    setSourceFile("");
    setManualCode("");
    setManualQty("1");
    setSupplierId(null);
    setPreviewSupplierId(null);
    setRawRows([]);
    setPreview([]);
    setChosen({});
    setConfirm(false);
    setReceipt(null);
    setRequestKey(crypto.randomUUID());
  }, [selectedCompany?.id]);

  const history = useQuery<{ rows: HistoryRow[] }>({
    queryKey: ["/api/erp/supplier-returns/history", selectedCompany?.id],
    enabled: !!selectedCompany,
    queryFn: async () => (await apiRequest("GET", "/api/erp/supplier-returns/history")).json(),
  });

  const resolved = useMemo(
    () =>
      preview.map((row) => {
        const selected = chosen[row.row] ?? row.suggestedOffloadItemId;
        const candidate = row.candidates.find((c) => c.offloadItemId === selected);
        return { row, candidate, selected, valid: !!candidate && isEligible(candidate, row.quantity) };
      }),
    [preview, chosen]
  );
  const combinedValid = useMemo(() => {
    const totals = new Map<number, Decimal>();
    for (const entry of resolved) {
      if (!entry.valid || !entry.candidate) return false;
      const id = entry.candidate.offloadItemId;
      totals.set(id, (totals.get(id) ?? new Decimal(0)).add(entry.row.quantity));
    }
    return resolved.every((entry) =>
      !!entry.candidate &&
      totals.get(entry.candidate.offloadItemId)!.lte(entry.candidate.remainingQty) &&
      totals.get(entry.candidate.offloadItemId)!.lte(entry.candidate.availableQty)
    );
  }, [resolved]);
  const ready = preview.length > 0 && previewSupplierId === supplierId && combinedValid;
  const totalBales = resolved.reduce((s, x) => s.add(x.row.quantity), new Decimal(0)).toFixed(3);

  function addManual() {
    const code = manualCode.trim();
    const qty = manualQty.trim();
    if (
      !code ||
      code.length > 50 ||
      !/^(?:0|[1-9]\\d*)(?:\\.\\d{1,3})?$/.test(qty) ||
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
    setChosen({});
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
        entries: resolved.map((entry) => ({
          row: entry.row.row,
          code: entry.row.code,
          quantity: entry.row.quantity,
          status: entry.row.status,
          candidate: entry.candidate,
          valid: entry.valid && combinedValid,
        })),
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
    setChosen({});
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
        if (!code || !/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(quantity) || Number(quantity) <= 0)
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
      setChosen({});
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
  async function post() {
    if (!ready || !confirm || busy) return;
    setBusy(true);
    try {
      const totals = new Map<number, Decimal>();
      for (const entry of resolved) {
        const itemId = entry.candidate!.offloadItemId;
        totals.set(itemId, (totals.get(itemId) ?? new Decimal(0)).add(entry.row.quantity));
      }
      for (const [id, qty] of totals) {
        const source = resolved.find((x) => x.candidate?.offloadItemId === id)!.candidate!;
        if (qty.gt(source.remainingQty) || qty.gt(source.availableQty))
          throw new Error([copy.combinedQtyInvalid, source.code].join(" "));
      }
      const lines = [...totals].map(([offloadItemId, qty]) => ({ offloadItemId, quantity: qty.toFixed(3) }));
      const response = (await (
        await apiRequest("POST", "/api/erp/supplier-returns/commit", {
          lines,
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
                setChosen({});
                setPreviewSupplierId(null);
                setConfirm(false);
                setRequestKey(crypto.randomUUID());
              }}
            >
              <option value="">{copy.allSuppliers}</option>
              {(suppliers.data?.rows ?? []).map((supplier) => (
                <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
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
              <span>{rawRows.length} {copy.lines} {copy.staged}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !!receipt}
                onClick={() => {
                  setRawRows([]);
                  setPreview([]);
                  setChosen({});
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
              {copy.mapping}: {resolved.filter((x) => x.valid).length}/{preview.length} {copy.validRows}
            </strong>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm">
                {copy.totalRequested}: <strong>{totalBales}</strong>
              </span>
              <Button type="button" size="sm" variant="outline" onClick={() => void exportPreview()}
                disabled={busy || exporting || previewSupplierId !== supplierId}>
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
                {resolved.map(({ row, candidate, selected, valid }) => {
                  const candidates = row.candidates.filter(
                    (x) => x.supplierCount === 1 && x.currencyCount === 1 && x.currency === "USD"
                  );
                  return (
                    <tr key={row.row} className="border-t align-top">
                      <td className="p-2">{row.row}</td>
                      <td className="p-2">
                        <strong>{row.code}</strong>
                        <div className="text-muted-foreground">{candidate?.name}</div>
                      </td>
                      <td className="p-2 font-mono">{row.quantity}</td>
                      <td className="p-2 min-w-52">
                        <select
                          aria-label={`Source container for row ${row.row}`}
                          className="max-w-full rounded border bg-background px-2 py-1"
                          value={selected ?? ""}
                          onChange={(e) => {
                            setChosen((s) => ({ ...s, [row.row]: Number(e.target.value) || 0 }));
                            setConfirm(false);
                          }}
                        >
                          <option value="">{copy.chooseSource}</option>
                          {candidates.map((c) => (
                            <option key={c.offloadItemId} value={c.offloadItemId}>
                              {c.containerNumber} — {c.supplierName ?? copy.supplierUnknown} ({copy.available}{" "}
                              {c.remainingQty})
                            </option>
                          ))}
                        </select>
                        {candidate && (
                          <div className="text-muted-foreground text-xs mt-1">
                            Offload #{candidate.offloadId} · {candidate.supplierName}
                          </div>
                        )}
                      </td>
                      <td className="p-2 font-mono">{candidate?.originalQty ?? "—"}</td>
                      <td className="p-2 font-mono">{candidate?.returnedQty ?? "—"}</td>
                      <td className="p-2 font-mono">{candidate?.remainingQty ?? "—"}</td>
                      <td className="p-2 font-mono">{candidate?.availableQty ?? "—"}</td>
                      <td className="p-2 font-mono">
                        {candidate ? `${money(candidate.unitPurchaseCost)} / ${money(candidate.unitLandedCost)}` : "—"}
                      </td>
                      <td className="p-2">
                        {valid ? (
                          <span className="text-green-600 inline-flex gap-1 items-center">
                            <CheckCircle2 className="h-4 w-4" />
                            {copy.ready}
                          </span>
                        ) : (
                          <span className="text-amber-600 inline-flex gap-1 items-center">
                            <AlertTriangle className="h-4 w-4" />
                            {!row.candidates.length
                              ? copy.notFound
                              : !candidate
                                ? copy.selectContainer
                                : copy.reviewQty}
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
