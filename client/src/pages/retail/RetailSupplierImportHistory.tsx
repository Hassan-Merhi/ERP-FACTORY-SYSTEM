
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, FileText, Printer, RefreshCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getJson } from "./retailInventoryTypes";
import {
  buildRetailSupplierReceiptLabelItems,
  type RetailSupplierReceiptLabelItem,
} from "./retailSupplierReceiptLabels";

export interface RetailSupplierPurchaseHistoryEntry {
  operationId: number;
  invoiceReference: string;
  deliveryReference: string | null;
  partialReceipt: boolean;
  invoiceDate: string;
  supplierId: number;
  supplierName: string;
  locationId: number;
  locationName: string;
  currency: string;
  purchaseTotal: string;
  baseTotal: string;
  voucherId: number;
  variantCount: number;
  unitsReceived: number;
  invoiceFileId: number | null;
  createdAt: string;
  createdBy: string;
}

export interface RetailSupplierPurchaseDetail {
  operationId: number;
  invoiceReference: string;
  deliveryReference: string | null;
  partialReceipt: boolean;
  invoiceDate: string;
  createdAt: string;
  createdBy: string;
  supplierId: number;
  supplierName: string;
  locationId: number;
  locationName: string;
  currency: string;
  exchangeRate: string;
  purchaseTotal: string;
  baseTotal: string;
  voucherId: number;
  items: Array<{
    rowNumber: number;
    variantId: number;
    barcode: string;
    quantity: number;
    name?: string;
    brand?: string;
    color?: string;
    size?: string;
    unitCost?: string;
    sellingPrice?: string;
  }>;
  totalUnits: number;
  movementsMatch: boolean;
  barcodesMatch: boolean;
  reprintAllowed: boolean;
  invoiceFile: null | {
    id: number;
    fileName: string;
    fileType: string;
    fileSize: number;
    downloadUrl: string;
  };
}

interface RetailSupplierHistoryPage {
  rows: RetailSupplierPurchaseHistoryEntry[];
  nextOffset: number | null;
}

export function RetailSupplierImportHistory({
  open,
  onOpenChange,
  companyId,
  onReprint,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: number;
  onReprint: (items: RetailSupplierReceiptLabelItem[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const limit = 25;
  const { data, isLoading, isError, refetch, isFetching } = useQuery<RetailSupplierHistoryPage>({
    queryKey: ["retail-supplier-import-history", companyId, query, offset],
    queryFn: () => getJson(
      `/api/retail/supplier-import/history?limit=${limit}&offset=${offset}&query=${encodeURIComponent(query.trim())}`
    ),
    enabled: open && companyId > 0,
    retry: false,
  });
  const { data: receipt, isLoading: loadingReceipt, isError: detailError } = useQuery<RetailSupplierPurchaseDetail>({
    queryKey: ["retail-supplier-import-detail", companyId, selectedId],
    queryFn: () => getJson(`/api/retail/supplier-import/history/${selectedId}`),
    enabled: open && companyId > 0 && selectedId !== null,
    retry: false,
  });
  const handleReprint = () => {
    if (!receipt || !receipt.reprintAllowed) return;
    const lines = buildRetailSupplierReceiptLabelItems(receipt.items, receipt.items.map(item => ({
      rowNumber: item.rowNumber,
      name: item.name ?? item.barcode,
      brand: item.brand ?? "Other / No Brand",
      color: item.color ?? "Default",
      size: item.size ?? "One Size",
    })));
    onReprint(lines);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Supplier stock import history</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9" value={query} placeholder="Find supplier invoice / reference"
              onChange={event => { setQuery(event.target.value); setOffset(0); setSelectedId(null); }} />
          </div>
          <Button type="button" variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
            <RefreshCcw className="mr-2 h-4 w-4" />Refresh
          </Button>
        </div>
        {isLoading && <p className="text-sm text-muted-foreground">Loading supplier purchases…</p>}
        {isError && <p role="alert" className="text-sm text-destructive">
          Import history could not be loaded. No purchase data was changed.
        </p>}
        {data && (
          <div className="space-y-2">
            <div className="max-h-64 overflow-auto rounded-md border">
              <table className="w-full min-w-[800px] text-left text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    {["Received", "Supplier / Invoice", "Location", "Units", "Payable", "Voucher", "Details"].map(name => (
                      <th key={name} className="whitespace-nowrap p-2">{name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(entry => (
                    <tr key={entry.operationId} className="border-t">
                      <td className="whitespace-nowrap p-2">{entry.invoiceDate}</td>
                      <td className="p-2">
                        <div className="font-medium">{entry.supplierName}</div>
                        <div>{entry.invoiceReference}</div>
                        {entry.partialReceipt && <div className="text-muted-foreground">
                          Partial · {entry.deliveryReference}
                        </div>}
                      </td>
                      <td className="p-2">{entry.locationName}</td>
                      <td className="p-2 tabular-nums">{entry.unitsReceived.toLocaleString()}</td>
                      <td className="whitespace-nowrap p-2 tabular-nums">
                        {entry.currency} {entry.purchaseTotal}
                      </td>
                      <td className="p-2">#{entry.voucherId}</td>
                      <td className="p-2">
                        <Button type="button" variant={selectedId === entry.operationId ? "secondary" : "outline"}
                          size="sm" onClick={() => setSelectedId(entry.operationId)}>View</Button>
                      </td>
                    </tr>
                  ))}
                  {!data.rows.length && (
                    <tr><td colSpan={7} className="p-5 text-center text-muted-foreground">
                      No supplier imports match this search.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Showing {data.rows.length ? offset + 1 : 0}–{offset + data.rows.length} of matching records
                {data.nextOffset !== null ? " (more available)" : ""}
              </span>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline"
                  disabled={offset === 0}
                  onClick={() => { setOffset(Math.max(0, offset - limit)); setSelectedId(null); }}>Previous</Button>
                <Button type="button" size="sm" variant="outline"
                  disabled={data.nextOffset === null}
                  onClick={() => { setOffset(data.nextOffset ?? offset); setSelectedId(null); }}>Next</Button>
              </div>
            </div>
          </div>
        )}

        {loadingReceipt && selectedId && <p className="text-sm text-muted-foreground">Loading receipt details…</p>}
        {detailError && <p role="alert" className="text-sm text-destructive">Receipt details could not be loaded.</p>}
        {receipt && selectedId === receipt.operationId && (
          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex flex-wrap justify-between gap-2">
              <div>
                <h3 className="font-medium">Receipt #{receipt.operationId} — {receipt.invoiceReference}</h3>
                <p className="text-xs text-muted-foreground">
                  {receipt.supplierName} · {receipt.locationName} · Voucher #{receipt.voucherId} ·
                  {receipt.currency} {receipt.purchaseTotal} (base {receipt.baseTotal})
                </p>
                {receipt.partialReceipt && <p className="text-xs">
                  Partial delivery reference: {receipt.deliveryReference}
                </p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {receipt.invoiceFile && (
                  <a href={receipt.invoiceFile.downloadUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-muted">
                    <FileText className="h-4 w-4" />Invoice attachment
                  </a>
                )}
                <Button type="button" variant="outline" disabled={!receipt.reprintAllowed}
                  onClick={handleReprint}>
                  <Printer className="mr-2 h-4 w-4" />Reprint received labels
                </Button>
              </div>
            </div>
            {!receipt.movementsMatch && (
              <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Stock movements do not reconcile with this receipt; printing is blocked pending investigation.
              </div>
            )}
            {!receipt.barcodesMatch && (
              <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                One or more variant barcodes have changed since this receipt.
                Reprinting is blocked to prevent printing a different item identity.
              </div>
            )}
            <div className="max-h-64 overflow-auto rounded-md border">
              <table className="w-full min-w-[790px] text-left text-xs">
                <thead className="bg-muted">
                  <tr>
                    {["Excel row", "Product / Variant", "Barcode", "Received", "Unit cost", "Selling price"].map(title => (
                      <th key={title} className="p-2">{title}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {receipt.items.map(item => (
                    <tr key={item.rowNumber} className="border-t">
                      <td className="p-2">{item.rowNumber}</td>
                      <td className="p-2">
                        <strong>{item.brand} · {item.name || `Variant #${item.variantId}`}</strong>
                        <div>{item.color} / {item.size}</div>
                      </td>
                      <td className="p-2 font-mono">{item.barcode}</td>
                      <td className="p-2 tabular-nums">{item.quantity}</td>
                      <td className="p-2 tabular-nums">{receipt.currency} {item.unitCost ?? "—"}</td>
                      <td className="p-2 tabular-nums">{item.sellingPrice ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              These quantities and prices are saved receipt snapshots; they are not recalculated
              from today's warehouse stock. Reprints require the currently stored barcode
              to match the barcode originally saved on this receipt.
            </p>
          </div>
        )}
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close history</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
