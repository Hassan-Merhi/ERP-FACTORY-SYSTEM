import { useRef, useState } from "react";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";

export type FactoryArabicImportMode = "fill-missing" | "replace-existing";

type PreviewStatus = "update" | "unchanged" | "unknown" | "duplicate" | "invalid" | "category-conflict" | "ambiguous";

interface TranslationPreviewRow {
  rowNumber: number;
  articleCode: string;
  status: PreviewStatus;
  reasons: string[];
}

interface TranslationPreview {
  totalRows: number;
  matchedProducts: number;
  unchangedRows: number;
  rowsToApply: number;
  productsToUpdate: number;
  categoriesToUpdate: number;
  unknownArticleCodes: string[];
  duplicateArticleCodes: string[];
  ambiguousArticleCodes: string[];
  blankOrInvalidArabicNames: number;
  categoryConflicts: number;
  blocked: boolean;
  previewToken: string;
  rows: TranslationPreviewRow[];
}

interface FactoryArabicTranslationActionsProps {
  className?: string;
}

async function permissionProbe(path: string): Promise<boolean> {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) throw new Error("Permission check failed");
  return true;
}

async function downloadResponse(response: Response, fallbackName: string): Promise<void> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || "Download failed");
  }
  const blob = await response.blob();
  if (blob.size === 0) throw new Error("The server returned an empty workbook");
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const fileName = match ? decodeURIComponent(match[1].replace(/"/g, "")) : fallbackName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function createFormData(file: File, mode: FactoryArabicImportMode, previewToken?: string): FormData {
  const form = new FormData();
  form.append("file", file);
  form.append("mode", mode);
  if (previewToken) form.append("previewToken", previewToken);
  return form;
}

function CodeList({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  const displayed = values.slice(0, 20);
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2">
      <p className="font-medium text-destructive">
        {label} ({values.length})
      </p>
      <p className="mt-1 wrap-break-word font-mono text-xs">
        {displayed.join(", ")}
        {values.length > displayed.length ? ` … and ${values.length - displayed.length} more` : ""}
      </p>
    </div>
  );
}

export function FactoryArabicTranslationActions({ className }: FactoryArabicTranslationActionsProps) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<FactoryArabicImportMode>("fill-missing");
  const [preview, setPreview] = useState<TranslationPreview | null>(null);
  const [exporting, setExporting] = useState(false);

  const { data: canImport = false } = useQuery({
    queryKey: ["/api/factory/bale-products/arabic-import/capabilities/import"],
    queryFn: () => permissionProbe("/api/factory/bale-products/arabic-import/capabilities/import"),
    retry: false,
    staleTime: 60_000,
  });
  const { data: canExport = false } = useQuery({
    queryKey: ["/api/factory/bale-products/arabic-import/capabilities/export"],
    queryFn: () => permissionProbe("/api/factory/bale-products/arabic-import/capabilities/export"),
    retry: false,
    staleTime: 60_000,
  });

  const resetSelection = () => {
    setFile(null);
    setPreview(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose an .xlsx workbook first");
      const response = await fetch("/api/factory/bale-products/arabic-import/preview", {
        method: "POST",
        credentials: "include",
        body: createFormData(file, mode),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "Preview failed");
      return payload as TranslationPreview;
    },
    onSuccess: setPreview,
    onError: (error: Error) =>
      toast({
        title: "Preview failed",
        description: error.message,
        variant: "destructive",
      }),
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!file || !preview) {
        throw new Error("Preview the workbook before applying it");
      }
      if (preview.blocked) {
        throw new Error("Resolve duplicate article codes, ambiguous catalog codes, and category conflicts first");
      }
      const response = await fetch("/api/factory/bale-products/arabic-import/apply", {
        method: "POST",
        credentials: "include",
        body: createFormData(file, mode, preview.previewToken),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (payload.preview?.previewToken) {
          setPreview(payload.preview as TranslationPreview);
        }
        throw new Error(payload.message || "Import failed");
      }
      return payload;
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["/api/factory/bale-products"],
          exact: false,
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/factory/categories"],
          exact: false,
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/factory/bale-products/lookup"],
          exact: false,
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/bale-products"],
          exact: false,
          refetchType: "active",
        }),
      ]);
      toast({
        title: "Arabic translations updated",
        description: `${result.changedProductIds?.length || 0} products and ${result.changedCategoryIds?.length || 0} categories changed.`,
      });
      setOpen(false);
      resetSelection();
    },
    onError: (error: Error) =>
      toast({
        title: "Import failed",
        description: error.message,
        variant: "destructive",
      }),
  });

  const exportTemplate = async () => {
    setExporting(true);
    try {
      await downloadResponse(
        await fetch("/api/factory/bale-products/arabic-template", {
          credentials: "include",
          cache: "no-store",
        }),
        "factory-arabic-names-template.xlsx"
      );
    } catch (error) {
      toast({
        title: "Export failed",
        description: (error as Error).message,
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const downloadErrors = async () => {
    if (!file) return;
    try {
      await downloadResponse(
        await fetch("/api/factory/bale-products/arabic-import/errors", {
          method: "POST",
          credentials: "include",
          body: createFormData(file, mode),
        }),
        "factory-arabic-import-errors.xlsx"
      );
    } catch (error) {
      toast({
        title: "Error workbook failed",
        description: (error as Error).message,
        variant: "destructive",
      });
    }
  };

  if (!canImport && !canExport) return null;

  const rejectedRows = preview?.rows.filter((row) => !["update", "unchanged"].includes(row.status));

  return (
    <>
      <div className={`flex flex-wrap gap-2 ${className || ""}`} data-testid="factory-arabic-actions">
        {canExport && (
          <Button
            variant="outline"
            size="sm"
            onClick={exportTemplate}
            disabled={exporting}
            data-testid="button-export-arabic-template"
          >
            <Download className="mr-2 h-4 w-4" />
            {exporting ? "Exporting…" : "Export Arabic Names Template"}
          </Button>
        )}
        {canImport && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="button-import-arabic-names">
            <Upload className="mr-2 h-4 w-4" /> Import Arabic Names
          </Button>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen && !applyMutation.isPending) resetSelection();
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import Arabic product and category names</DialogTitle>
            <DialogDescription>
              Products are matched only by the normalized exact article code/barcode in the current Factory company.
              English names, article codes, prices, weights, quantities, stock, costing and accounting records are never
              changed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="factory-arabic-workbook">Arabic translation workbook (.xlsx)</Label>
              <input
                ref={inputRef}
                id="factory-arabic-workbook"
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                data-testid="input-arabic-translation-workbook"
                onChange={(event) => {
                  const selected = event.target.files?.[0] || null;
                  if (selected && !selected.name.toLowerCase().endsWith(".xlsx")) {
                    toast({
                      title: "Unsupported file",
                      description: "Choose the .xlsx template exported from Bale Explorer.",
                      variant: "destructive",
                    });
                    event.target.value = "";
                    setFile(null);
                    setPreview(null);
                    return;
                  }
                  setFile(selected);
                  setPreview(null);
                }}
              />
              {file && <p className="text-xs text-muted-foreground">Selected: {file.name}</p>}
            </div>

            <div className="space-y-2">
              <Label>Update mode</Label>
              <Select
                value={mode}
                onValueChange={(value) => {
                  setMode(value as FactoryArabicImportMode);
                  setPreview(null);
                }}
              >
                <SelectTrigger data-testid="select-arabic-import-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fill-missing">Fill missing Arabic names only</SelectItem>
                  <SelectItem value="replace-existing">Replace existing Arabic names</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {preview && (
              <div className="space-y-3 rounded-md border p-4 text-sm" data-testid="arabic-import-preview">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <span>Total rows: {preview.totalRows}</span>
                  <span>Matched products: {preview.matchedProducts}</span>
                  <span>Rows to apply: {preview.rowsToApply}</span>
                  <span>Unchanged rows: {preview.unchangedRows}</span>
                  <span>Products to update: {preview.productsToUpdate}</span>
                  <span>Categories to update: {preview.categoriesToUpdate}</span>
                  <span>Unknown codes: {preview.unknownArticleCodes.length}</span>
                  <span>Invalid rows: {preview.blankOrInvalidArabicNames}</span>
                </div>

                <CodeList label="Unknown article codes" values={preview.unknownArticleCodes} />
                <CodeList label="Duplicate article codes in workbook" values={preview.duplicateArticleCodes} />
                <CodeList label="Ambiguous article codes in catalog" values={preview.ambiguousArticleCodes} />

                {preview.categoryConflicts > 0 && (
                  <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 font-medium text-destructive">
                    {preview.categoryConflicts} categor
                    {preview.categoryConflicts === 1 ? "y has" : "ies have"} conflicting Arabic translations in this
                    workbook.
                  </p>
                )}

                {preview.blocked && (
                  <p className="font-medium text-destructive">
                    Apply is blocked until duplicate or ambiguous article codes and category conflicts are corrected.
                  </p>
                )}

                {rejectedRows && rejectedRows.length > 0 && (
                  <div className="max-h-44 overflow-auto rounded-md border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-background">
                        <tr className="border-b">
                          <th className="p-2 text-left">Row</th>
                          <th className="p-2 text-left">Article code</th>
                          <th className="p-2 text-left">Status</th>
                          <th className="p-2 text-left">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rejectedRows.slice(0, 50).map((row) => (
                          <tr key={`${row.rowNumber}-${row.articleCode}`} className="border-b last:border-0">
                            <td className="p-2">{row.rowNumber}</td>
                            <td className="p-2 font-mono">{row.articleCode || "—"}</td>
                            <td className="p-2">{row.status}</td>
                            <td className="p-2">{row.reasons.join("; ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter className="flex-wrap gap-2">
            {canExport && rejectedRows && rejectedRows.length > 0 && (
              <Button variant="outline" onClick={downloadErrors}>
                <FileSpreadsheet className="mr-2 h-4 w-4" /> Download error workbook
              </Button>
            )}
            <Button
              variant="outline"
              disabled={!file || previewMutation.isPending || applyMutation.isPending}
              onClick={() => previewMutation.mutate()}
              data-testid="button-preview-arabic-import"
            >
              {previewMutation.isPending ? "Previewing…" : "Preview"}
            </Button>
            <Button
              disabled={!preview || preview.blocked || applyMutation.isPending || previewMutation.isPending}
              onClick={() => applyMutation.mutate()}
              data-testid="button-apply-arabic-import"
            >
              {applyMutation.isPending ? "Applying…" : "Apply Arabic translations"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
