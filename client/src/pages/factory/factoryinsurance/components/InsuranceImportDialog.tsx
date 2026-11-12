import { useRef, useState } from "react";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ClientErrorLike } from "@/lib/clientError";
import type { InsuranceImportPreview } from "../types";

interface InsuranceImportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function InsuranceImportDialog({ open, onClose }: InsuranceImportDialogProps) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<InsuranceImportPreview | null>(null);
  const [workbookYear, setWorkbookYear] = useState(new Date().getFullYear());

  const reset = () => {
    setFile(null);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const close = () => {
    if (previewMutation.isPending || applyMutation.isPending) return;
    reset();
    onClose();
  };

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose an .xlsx workbook first");
      const formData = new FormData();
      formData.append("file", file);
      formData.append("year", String(workbookYear));
      const response = await fetch("/api/insurance/import/preview", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || `Preview failed (${response.status})`);
      return body as InsuranceImportPreview;
    },
    onSuccess: setPreview,
    onError: (error: ClientErrorLike) =>
      toast({ title: "Workbook preview failed", description: error.message, variant: "destructive" }),
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!preview || preview.errors.length > 0 || preview.rows.length === 0) {
        throw new Error("Fix workbook errors before importing");
      }
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const response = await apiRequest("POST", "/api/insurance/import/apply", { rows: preview.rows });
      return response.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/insurance/members"] });
      toast({
        title: "Insurance workbook imported",
        description: `${result.createdMembers} member(s) created, ${result.updatedMembers} updated, ${result.monthlyAmountsUpserted} monthly amount(s) saved.`,
      });
      reset();
      onClose();
    },
    onError: (error: ClientErrorLike) =>
      toast({ title: "Import failed", description: error.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Import Insurance Excel
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">Workbook format</p>
              <Button asChild variant="outline" size="sm" data-testid="button-download-insurance-template">
                <a href="/api/insurance/import/template" download="Insurance_Import_Template.xlsx">
                  <Download className="h-4 w-4" />
                  Download Template
                </a>
              </Button>
            </div>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Name sheets “January”, “February”, etc. The selected year below is used for plain month names.</li>
              <li>Sheet names such as “January 2026” or “2026-01” keep their own year.</li>
              <li>Each sheet needs columns named “Name” and “Monthly Amount”.</li>
              <li>Optional columns: Start Date, Insurance Number, Nationality, Position, Date of Birth, Notes.</li>
              <li>Existing names are updated without replacing their saved personal details.</li>
            </ul>
          </div>

          <div className="grid gap-3 sm:grid-cols-[140px_1fr_auto] sm:items-end">
            <div className="space-y-1">
              <label htmlFor="insurance-import-year" className="text-sm font-medium">
                Workbook year
              </label>
              <Input
                id="insurance-import-year"
                type="number"
                min={2000}
                max={2100}
                value={workbookYear}
                onChange={(event) => {
                  setWorkbookYear(Number(event.target.value));
                  setPreview(null);
                }}
                data-testid="input-insurance-import-year"
              />
            </div>
            <Input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setPreview(null);
              }}
              data-testid="input-insurance-import-file"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => previewMutation.mutate()}
              disabled={
                !file ||
                previewMutation.isPending ||
                !Number.isInteger(workbookYear) ||
                workbookYear < 2000 ||
                workbookYear > 2100
              }
              data-testid="button-preview-insurance-import"
            >
              {previewMutation.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-1 h-4 w-4" />
              )}
              Preview
            </Button>
          </div>

          {preview && (
            <div className="space-y-3" data-testid="insurance-import-preview">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{preview.recognizedSheets.length} month sheet(s)</Badge>
                <Badge variant="secondary">{preview.rows.length} valid row(s)</Badge>
                {preview.errors.length > 0 && <Badge variant="destructive">{preview.errors.length} error(s)</Badge>}
                {preview.warnings.length > 0 && <Badge variant="outline">{preview.warnings.length} warning(s)</Badge>}
              </div>

              {preview.recognizedSheets.length > 0 && (
                <div className="rounded-md border p-3">
                  <p className="text-sm font-medium">Recognized months</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {preview.recognizedSheets.map((sheet) => (
                      <Badge key={sheet.sheetName} variant="outline">
                        {sheet.sheetName}: {sheet.rowCount}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {preview.errors.length > 0 && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Workbook errors</AlertTitle>
                  <AlertDescription>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {preview.errors.slice(0, 20).map((issue, index) => (
                        <li key={`${issue.sheetName}-${issue.row}-${index}`}>
                          {issue.sheetName || "Workbook"}
                          {issue.row ? ` row ${issue.row}` : ""}: {issue.message}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {preview.warnings.length > 0 && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Warnings</AlertTitle>
                  <AlertDescription>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {preview.warnings.slice(0, 20).map((issue, index) => (
                        <li key={`${issue.sheetName}-${index}`}>
                          {issue.sheetName || "Workbook"}: {issue.message}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {preview.errors.length === 0 && preview.rows.length > 0 && (
                <Alert className="border-green-500/50 text-green-700 dark:text-green-300">
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>Ready to import</AlertTitle>
                  <AlertDescription>
                    The workbook is valid. Importing saves each amount for its worksheet month.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={previewMutation.isPending || applyMutation.isPending}>
            Cancel
          </Button>
          {recordChanges.allowed && (
            <Button
              onClick={() => applyMutation.mutate()}
              disabled={!preview || preview.errors.length > 0 || preview.rows.length === 0 || applyMutation.isPending}
              data-testid="button-apply-insurance-import"
            >
              {applyMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Import {preview?.rows.length ?? 0} Rows
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
