import { downloadBlob } from "@/lib/downloadBlob";
import { useMemo } from "react";
import { AlertTriangle, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Location } from "./retailInventoryTypes";
import type { matchRetailSupplierImages } from "./retailSupplierImageZip";
import type { RetailSupplierImportRow, summarizeRetailSupplierImport } from "./retailSupplierImportDraft";
import { catalogLabels, type CatalogPreview, type SupplierOption } from "./retailSupplierImportTypes";

interface RetailSupplierImportPreviewProps {
  rows: RetailSupplierImportRow[];
  summary: ReturnType<typeof summarizeRetailSupplierImport>;
  currency: string;
  imageMatches: ReturnType<typeof matchRetailSupplierImages>;
  imageMatchedCount: number;
  imageIssueCount: number;
  catalogPreview: CatalogPreview | undefined;
  catalogChecking: boolean;
  catalogFailed: boolean;
  knownSupplier: SupplierOption | undefined;
  knownLocation: Location | undefined;
  invoiceReference: string;
  invoiceDate: string;
  purchaseRecorded: boolean;
  showProblemsOnly: boolean;
  onToggleProblemsOnly: () => void;
  photoPreviewUrls: Map<number, string>;
  readyForPosting: boolean;
}

/**
 * Validation summary, catalog reconciliation counts and the first-100-rows
 * preview table of the supplier stock import (split out of
 * RetailSupplierImportDialog.tsx). Purely presentational: the dialog owns the
 * rows, the image matches and the catalog preview query.
 */
export function RetailSupplierImportPreview({
  rows,
  summary,
  currency,
  imageMatches,
  imageMatchedCount,
  imageIssueCount,
  catalogPreview,
  catalogChecking,
  catalogFailed,
  knownSupplier,
  knownLocation,
  invoiceReference,
  invoiceDate,
  purchaseRecorded,
  showProblemsOnly,
  onToggleProblemsOnly,
  photoPreviewUrls,
  readyForPosting,
}: RetailSupplierImportPreviewProps) {
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
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "retail_supplier_import_errors.csv");
  };

  return (
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
            Catalog: {catalogPreview.summary.newProducts} new styles · {catalogPreview.summary.newVariants} new variants
            · {catalogPreview.summary.existingVariants} existing variants · {catalogPreview.summary.conflicts} conflicts
          </p>
          <p className="text-xs text-muted-foreground">
            Barcodes: {catalogPreview.barcodePlans.filter((plan) => plan.action === "reuse").length} existing retained ·{" "}
            {catalogPreview.barcodePlans.filter((plan) => plan.action === "supplier").length} supplier codes kept ·{" "}
            {catalogPreview.barcodePlans.filter((plan) => plan.action === "generate").length} to generate on
            confirmation
          </p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Supplier: {knownSupplier?.legalName || knownSupplier?.name || "not selected"} · Location:{" "}
        {knownLocation?.name || "not selected"} · Reference: {invoiceReference || "not provided"} · Date:{" "}
        {invoiceDate || "not selected"}.
        {purchaseRecorded ? "This purchase has been recorded." : "This is a preview until you confirm the purchase."}
      </p>
      {issueRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-destructive">{issueRows.length} rows need corrections</span>
          <Button type="button" size="sm" variant="outline" onClick={onToggleProblemsOnly}>
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
          Displaying first 100 of {previewRows.length} {showProblemsOnly ? "problem" : "total"} rows; all rows were
          checked. Download errors for the complete list.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {readyForPosting
          ? "Ready to receive the purchase and credit the selected supplier. Verify invoice-currency costs and USD retail selling prices before confirming."
          : "Select a supplier/location/reference and resolve spreadsheet, image, rate and catalog conflicts before posting."}
      </p>
    </div>
  );
}
