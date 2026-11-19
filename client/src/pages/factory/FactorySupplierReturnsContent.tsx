// Extracted from ./FactorySupplierReturns.tsx
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money } from "./useFactorySupplierReturns";
import { useFactorySupplierReturnsState } from "./useFactorySupplierReturnsState";

export function FactorySupplierReturnsContent({
  addAllocation,
  busy,
  changeAllocation,
  combined,
  copy,
  preview,
  receipt,
  removeAllocation,
}: Pick<
  ReturnType<typeof useFactorySupplierReturnsState>,
  "addAllocation" | "busy" | "changeAllocation" | "combined" | "copy" | "preview" | "receipt" | "removeAllocation"
>) {
  return (
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
          const overLimit = entry.lines.some(
            ({ candidate }) =>
              candidate &&
              (combined.overSources.has(candidate.offloadItemId) ||
                combined.overStock.has(candidate.locationId + ":" + candidate.stockItemId))
          );
          const valid = entry.valid && !overLimit;
          const sourceOptions = row.candidates.filter(
            (x) => x.supplierCount === 1 && x.supplierId !== null && x.currencyCount === 1 && x.currency === "USD"
          );
          const rowSupplier = entry.lines.find((line) => line.candidate)?.candidate?.supplierId;
          return (
            <tr key={row.row} className="border-t align-top">
              <td className="p-2">{row.row}</td>
              <td className="p-2">
                <strong>{row.code}</strong>
                <div className="text-muted-foreground">{first?.name}</div>
              </td>
              <td className="p-2 font-mono">{row.quantity}</td>
              <td className="p-2 min-w-80 space-y-2">
                {entry.lines.map(({ allocation, candidate }, index) => (
                  <div key={index} className="rounded border p-2 space-y-1">
                    <div className="flex flex-wrap gap-1 items-center">
                      <select
                        aria-label={`${copy.allocationContainer} ${row.row} ${copy.allocation} ${index + 1}`}
                        disabled={busy || !!receipt}
                        className="flex-1 min-w-40 max-w-full rounded border bg-background px-2 py-1"
                        value={allocation.offloadItemId || ""}
                        onChange={(e) =>
                          changeAllocation(row.row, index, {
                            offloadItemId: Number(e.target.value) || 0,
                          })
                        }
                      >
                        <option value="">{copy.chooseContainer}</option>
                        {sourceOptions
                          .filter(
                            (source) =>
                              (rowSupplier == null ||
                                source.supplierId === rowSupplier ||
                                source.offloadItemId === allocation.offloadItemId) &&
                              (!entry.lines.some(
                                (line, at) => at !== index && line.allocation.offloadItemId === source.offloadItemId
                              ) ||
                                source.offloadItemId === allocation.offloadItemId)
                          )
                          .map((source) => (
                            <option key={source.offloadItemId} value={source.offloadItemId}>
                              {source.containerNumber} ({copy.remainingLabel} {source.remainingQty})
                            </option>
                          ))}
                      </select>
                      <Input
                        aria-label={`${copy.allocationQuantity} ${row.row} ${copy.allocation} ${index + 1}`}
                        className="w-24 font-mono"
                        inputMode="decimal"
                        value={allocation.quantity}
                        disabled={busy || !!receipt}
                        onChange={(e) => changeAllocation(row.row, index, { quantity: e.target.value })}
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy || !!receipt}
                        onClick={() => removeAllocation(row.row, index)}
                        aria-label={`${copy.removeAllocation} ${index + 1} ${copy.fromRow} ${row.row}`}
                      >
                        {copy.remove}
                      </Button>
                    </div>
                    {candidate && (
                      <div className="text-xs text-muted-foreground">
                        {copy.offloadId} #{candidate.offloadId} · {candidate.supplierName} ·{copy.remainingLabel}{" "}
                        {candidate.remainingQty} · {copy.stockLabel} {candidate.availableQty} ·{copy.purchaseLabel}{" "}
                        {money(candidate.unitPurchaseCost)} / {copy.landedLabel} {money(candidate.unitLandedCost)} ·{" "}
                        {copy.averagePerBale} {money(candidate.averageCost)}
                      </div>
                    )}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || !!receipt || entry.lines.length >= sourceOptions.length}
                  onClick={() => addAllocation(row.row)}
                >
                  + {copy.addContainer}
                </Button>
                <div className="text-xs font-mono">
                  {copy.allocatedLabel} {entry.allocatedQty} / {row.quantity} ·{copy.unallocatedLabel}{" "}
                  {entry.unallocatedQty}
                </div>
              </td>
              <td className="p-2 font-mono">
                {entry.lines.map((line) => line.candidate?.originalQty ?? "—").join(" / ") || "—"}
              </td>
              <td className="p-2 font-mono">
                {entry.lines.map((line) => line.candidate?.returnedQty ?? "—").join(" / ") || "—"}
              </td>
              <td className="p-2 font-mono">
                {entry.lines.map((line) => line.candidate?.remainingQty ?? "—").join(" / ") || "—"}
              </td>
              <td className="p-2 font-mono">
                {entry.lines.map((line) => line.candidate?.availableQty ?? "—").join(" / ") || "—"}
              </td>
              <td className="p-2 font-mono">
                {entry.lines
                  .map((line) =>
                    line.candidate
                      ? `${money(line.candidate.unitPurchaseCost)} / ${money(line.candidate.unitLandedCost)}`
                      : "—"
                  )
                  .join("; ") || "—"}
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
                      : overLimit
                        ? copy.reviewQty
                        : entry.lines.length === 0
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
  );
}
