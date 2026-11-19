// Extracted from ./SilentProductionDialog.tsx
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/formatNumber";
import { FileDown, Loader2, TrendingDown, TrendingUp } from "lucide-react";
import { useSilentProductionDialogState } from "./useSilentProductionDialogState";

export function SilentProductionDialogContent({
  applySilentImport,
  exportSilentExcel,
  exportSilentPDF,
  setSilentImportPreview,
  setSilentProdOpen,
  silentImportFileRef,
  silentImportPreview,
  silentProdApplying,
  silentProdLocId,
}: Pick<
  ReturnType<typeof useSilentProductionDialogState>,
  | "applySilentImport"
  | "exportSilentExcel"
  | "exportSilentPDF"
  | "setSilentImportPreview"
  | "setSilentProdOpen"
  | "silentImportFileRef"
  | "silentImportPreview"
  | "silentProdApplying"
  | "silentProdLocId"
>) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-3 text-xs font-medium">
          <span className="text-emerald-600 dark:text-emerald-400">
            {silentImportPreview.filter((row) => row.change > 0 && row.status !== "not_found").length} production
          </span>
          <span className="text-destructive">
            {silentImportPreview.filter((row) => row.change < 0 && row.status !== "not_found").length} consumption
          </span>
          {silentImportPreview.filter((row) => row.status === "not_found").length > 0 && (
            <span className="text-muted-foreground">
              {silentImportPreview.filter((row) => row.status === "not_found").length} unmatched
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportSilentExcel} data-testid="button-export-silent-excel">
            <FileDown className="h-3 w-3 mr-1" />
            Excel
          </Button>
          <Button variant="outline" size="sm" onClick={exportSilentPDF} data-testid="button-export-silent-pdf">
            <FileDown className="h-3 w-3 mr-1" />
            PDF
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSilentImportPreview([]);
              if (silentImportFileRef.current) silentImportFileRef.current.value = "";
            }}
            data-testid="button-clear-silent-import"
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="border rounded-md overflow-hidden text-sm">
        <div className="max-h-[280px] overflow-y-auto">
          <table className="w-full">
            <thead className="bg-muted sticky top-0">
              <tr>
                <th className="text-left p-2 font-medium">Item</th>
                <th className="text-right p-2 font-medium">Current</th>
                <th className="text-right p-2 font-medium">Change</th>
                <th className="text-right p-2 font-medium">New Qty</th>
              </tr>
            </thead>
            <tbody>
              {silentImportPreview.map((row, index) => (
                <tr key={index} className={`border-t ${row.status === "not_found" ? "opacity-50" : ""}`}>
                  <td className="p-2">
                    <p className="font-medium truncate max-w-[220px]">{row.stockItemName}</p>
                    {row.status === "not_found" && <p className="text-xs text-destructive">Not found — skipped</p>}
                    {row.status === "to_zero" && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">Will reach 0</p>
                    )}
                  </td>
                  <td className="p-2 text-right font-mono text-muted-foreground">{formatNumber(row.currentQty, 0)}</td>
                  <td
                    className={`p-2 text-right font-mono font-semibold ${
                      row.change > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                    }`}
                  >
                    <span className="inline-flex items-center gap-0.5 justify-end">
                      {row.change > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      {row.change > 0 ? "+" : ""}
                      {formatNumber(row.change, 0)}
                    </span>
                  </td>
                  <td className="p-2 text-right font-mono font-semibold">
                    {row.status !== "not_found" ? formatNumber(row.newQty, 0) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setSilentProdOpen(false)} data-testid="button-silent-import-cancel">
          Cancel
        </Button>
        <Button
          onClick={applySilentImport}
          disabled={
            silentProdApplying || silentImportPreview.every((row) => row.status === "not_found") || !silentProdLocId
          }
          data-testid="button-silent-import-apply"
        >
          {silentProdApplying ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Applying…
            </>
          ) : (
            "Apply Adjustments"
          )}
        </Button>
      </div>
    </div>
  );
}
