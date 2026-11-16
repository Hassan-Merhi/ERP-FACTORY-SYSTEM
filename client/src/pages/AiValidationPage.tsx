import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle2, XCircle, Lightbulb, Download, BarChart3 } from "lucide-react";
import {
  FileDropZone,
  SummaryCard,
  VALIDATION_TYPES,
  type SummaryCardProps,
  type ValidationResult,
} from "./AiValidationPageFileDropZone";

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AiValidationPage() {
  const { toast } = useToast();
  const [file1, setFile1] = useState<File | null>(null);
  const [file2, setFile2] = useState<File | null>(null);
  const [validationType, setValidationType] = useState<string>("");
  const [result, setResult] = useState<ValidationResult | null>(null);

  const selectedType = VALIDATION_TYPES.find((t) => t.value === validationType);
  const needsTwoFiles = selectedType?.twoFiles ?? false;

  const runMutation = useMutation({
    mutationFn: async () => {
      if (!file1) throw new Error("Please upload a file");
      if (!validationType) throw new Error("Please select a validation type");

      // Fetch CSRF token before multipart upload
      const csrfRes = await fetch("/api/csrf-token", { credentials: "include" });
      const csrfData = await csrfRes.json().catch(() => ({}));
      const csrfToken = typeof csrfData?.csrfToken === "string" ? csrfData.csrfToken : null;

      const form = new FormData();
      form.append("file1", file1);
      if (file2 && needsTwoFiles) form.append("file2", file2);
      form.append("validationType", validationType);

      const res = await fetch("/api/ai-validation/run", {
        method: "POST",
        body: form,
        credentials: "include",
        headers: {
          ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Validation failed" }));
        throw new Error(err.message || "Validation failed");
      }
      return res.json() as Promise<ValidationResult>;
    },
    onSuccess: (data) => {
      setResult(data);
    },
    onError: (err: Error) => {
      toast({ title: "Validation failed", description: err.message, variant: "destructive" });
    },
  });

  const downloadCleaned = () => {
    if (!result?.cleanedExcel) return;
    const bytes = Uint8Array.from(atob(result.cleanedExcel), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `validation_${result.validationType}_${Date.now()}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Build summary cards for the result
  const summaryCards = (): SummaryCardProps[] => {
    if (!result) return [];
    const s = result.summary;
    const cards: SummaryCardProps[] = [];

    if (typeof s.totalChecked === "number") cards.push({ label: "Total Rows", value: s.totalChecked });
    if (typeof s.found === "number")
      cards.push({ label: "Found", value: s.found, variant: s.found > 0 ? "good" : "default" });
    if (typeof s.missing === "number")
      cards.push({ label: "Missing", value: s.missing, variant: s.missing > 0 ? "bad" : "good" });
    if (typeof s.duplicateInFile === "number")
      cards.push({
        label: "Duplicates (file)",
        value: s.duplicateInFile,
        variant: s.duplicateInFile > 0 ? "bad" : "good",
      });
    if (typeof s.closeMatches === "number")
      cards.push({ label: "Close Matches", value: s.closeMatches, variant: s.closeMatches > 0 ? "warn" : "good" });
    if (typeof s.duplicateGroups === "number")
      cards.push({
        label: "Duplicate Groups",
        value: s.duplicateGroups,
        variant: s.duplicateGroups > 0 ? "warn" : "good",
      });
    if (typeof s.duplicateItems === "number")
      cards.push({ label: "Affected Rows", value: s.duplicateItems, variant: s.duplicateItems > 0 ? "warn" : "good" });

    return cards;
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="AI Validation Center" />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:p-4 lg:flex-row lg:overflow-hidden">
        {/* ── Left column: config ─────────────────────────────────────── */}
        <div className="flex w-full flex-none flex-col gap-4 lg:w-72">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Validation Setup</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {/* Validation type */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Validation Type
                </label>
                <Select value={validationType} onValueChange={setValidationType} data-testid="select-validation-type">
                  <SelectTrigger data-testid="select-validation-type-trigger">
                    <SelectValue placeholder="Select type…" />
                  </SelectTrigger>
                  <SelectContent>
                    {VALIDATION_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value} data-testid={`option-${t.value}`}>
                        <span>{t.label}</span>
                        {!t.implemented && <span className="ml-2 text-xs text-muted-foreground">(soon)</span>}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* File 1 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {needsTwoFiles ? "File 1" : "File"}
                </label>
                <FileDropZone label="Drop or click to upload" file={file1} onFile={setFile1} testId="dropzone-file1" />
              </div>

              {/* File 2 — only for two-file types */}
              {needsTwoFiles && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">File 2</label>
                  <FileDropZone
                    label="Drop or click to upload"
                    file={file2}
                    onFile={setFile2}
                    testId="dropzone-file2"
                  />
                </div>
              )}

              <Button
                onClick={() => runMutation.mutate()}
                disabled={!file1 || !validationType || runMutation.isPending}
                data-testid="button-run-validation"
                className="w-full"
              >
                {runMutation.isPending ? "Validating…" : "Run Validation"}
              </Button>
            </CardContent>
          </Card>

          {/* Info card */}
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Upload an Excel or CSV file and select a validation type. Results will appear on the right. A cleaned
                Excel file can be downloaded after validation.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* ── Right column: results ───────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-visible lg:overflow-y-auto">
          {!result && !runMutation.isPending && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
              <BarChart3 className="w-12 h-12 opacity-30" />
              <p className="text-sm">Upload a file and run a validation to see results here.</p>
            </div>
          )}

          {runMutation.isPending && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm">Validating…</p>
            </div>
          )}

          {result && !runMutation.isPending && (
            <>
              {/* Summary bar */}
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="text-sm font-semibold">{result.summary.message}</p>
                  {result.summary.codeColumn && (
                    <p className="text-xs text-muted-foreground">
                      Code column: <span className="font-mono">{result.summary.codeColumn}</span>
                    </p>
                  )}
                  {result.summary.nameColumn && (
                    <p className="text-xs text-muted-foreground">
                      Name column: <span className="font-mono">{result.summary.nameColumn}</span>
                    </p>
                  )}
                </div>
                {result.cleanedExcel && (
                  <Button size="sm" variant="outline" onClick={downloadCleaned} data-testid="button-download-cleaned">
                    <Download className="w-4 h-4 mr-2" />
                    Download Cleaned Excel
                  </Button>
                )}
              </div>

              {/* Summary cards */}
              {summaryCards().length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {summaryCards().map((card) => (
                    <SummaryCard key={card.label} {...card} />
                  ))}
                </div>
              )}

              {/* Errors */}
              {result.errors.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <XCircle className="w-4 h-4 text-destructive" />
                      Errors
                      <Badge variant="destructive" data-testid="badge-error-count">
                        {result.errors.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-16">Row</TableHead>
                          <TableHead className="w-36">Value</TableHead>
                          <TableHead>Message</TableHead>
                          <TableHead>Detail</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.errors.map((e, i) => (
                          <TableRow key={i} data-testid={`row-error-${i}`}>
                            <TableCell className="text-muted-foreground">{e.row ?? "—"}</TableCell>
                            <TableCell className="font-mono text-xs">{e.value ?? "—"}</TableCell>
                            <TableCell className="text-sm">{e.message}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{e.detail ?? "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}

              {/* Warnings */}
              {result.warnings.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-500" />
                      Warnings
                      <Badge
                        className="bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                        data-testid="badge-warning-count"
                      >
                        {result.warnings.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-16">Row</TableHead>
                          <TableHead className="w-36">Value</TableHead>
                          <TableHead>Message</TableHead>
                          <TableHead>Detail</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.warnings.map((w, i) => (
                          <TableRow key={i} data-testid={`row-warning-${i}`}>
                            <TableCell className="text-muted-foreground">{w.row ?? "—"}</TableCell>
                            <TableCell className="font-mono text-xs">{w.value ?? "—"}</TableCell>
                            <TableCell className="text-sm">{w.message}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{w.detail ?? "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}

              {/* Suggested fixes */}
              {result.suggestedFixes.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Lightbulb className="w-4 h-4 text-primary" />
                      Suggested Fixes
                      <Badge variant="outline" data-testid="badge-fix-count">
                        {result.suggestedFixes.length}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Original</TableHead>
                          <TableHead>Suggested</TableHead>
                          <TableHead>Reason</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {result.suggestedFixes.map((f, i) => (
                          <TableRow key={i} data-testid={`row-fix-${i}`}>
                            <TableCell className="font-mono text-xs">{f.original}</TableCell>
                            <TableCell className="font-mono text-xs text-primary">{f.suggested}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{f.reason}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}

              {/* All clear */}
              {result.errors.length === 0 && result.warnings.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
                  <CheckCircle2 className="w-10 h-10 text-green-500" />
                  <p className="text-sm font-medium">No issues found</p>
                  <p className="text-xs">{result.summary.message}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
