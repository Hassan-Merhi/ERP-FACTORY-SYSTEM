// Extracted from ./FactorySupplierReturns.tsx to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { money } from "./useFactorySupplierReturns";
import { useFactorySupplierReturnsState } from "./useFactorySupplierReturnsState";

export function FactorySupplierReturnsSection({
  busy,
  copy,
  detailRows,
  exportPostedBatch,
  exportingBatch,
  history,
  openBatch,
  selectedBatch,
}: Pick<
  ReturnType<typeof useFactorySupplierReturnsState>,
  "busy" | "copy" | "detailRows" | "exportPostedBatch" | "exportingBatch" | "history" | "openBatch" | "selectedBatch"
>) {
  return (
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
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || exportingBatch !== null}
                      onClick={() => void exportPostedBatch(r)}
                    >
                      <Download className="h-4 w-4 mr-1" />
                      {exportingBatch === r.id ? copy.exporting : copy.postedExcel}
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
                    copy.inputRows,
                    copy.purchasePerBale,
                    copy.inventoryPerBale,
                    copy.variance,
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
                      {r.requestedRows
                        ?.map((a) => `#${a.inputRow}: ${a.allocatedQuantity}/${a.requestedQuantity}`)
                        .join(", ") || "—"}
                    </td>
                    <td className="p-2 font-mono">
                      {r.sourcePurchaseRate == null ? "—" : money(r.sourcePurchaseRate)}
                    </td>
                    <td className="p-2 font-mono">
                      {new Decimal(r.quantity).gt(0)
                        ? money(new Decimal(r.inventoryReductionUsd).div(r.quantity).toFixed(7))
                        : "—"}
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
  );
}
