import { useState, useCallback, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  Upload,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Lightbulb,
  Download,
  X,
  BarChart3,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ValidationItem {
  row?: number;
  value?: string;
  message: string;
  detail?: string;
}

interface SuggestedFix {
  original: string;
  suggested: string;
  reason: string;
}

interface ValidationSummary {
  message?: string;
  codeColumn?: string;
  nameColumn?: string;
  totalChecked?: number;
  found?: number;
  missing?: number;
  duplicateInFile?: number;
  closeMatches?: number;
  duplicateGroups?: number;
  duplicateItems?: number;
}

interface ValidationResult {
  validationType: string;
  file1Name: string | null;
  file2Name: string | null;
  summary: ValidationSummary;
  errors: ValidationItem[];
  warnings: ValidationItem[];
  suggestedFixes: SuggestedFix[];
  cleanedExcel: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VALIDATION_TYPES = [
  { value: "item_code_check", label: "Item Code Check", twoFiles: false, implemented: true },
  { value: "duplicate_name_check", label: "Duplicate Name Check", twoFiles: false, implemented: true },
  { value: "statement_compare", label: "Statement Compare", twoFiles: true, implemented: false },
  { value: "po_compare", label: "PO Compare", twoFiles: true, implemented: false },
  { value: "amount_total_check", label: "Amount Total Check", twoFiles: false, implemented: false },
  { value: "currency_conversion_check", label: "Currency Conversion Check", twoFiles: false, implemented: false },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

interface FileDropZoneProps {
  label: string;
  file: File | null;
  onFile: (f: File | null) => void;
  testId: string;
}

function FileDropZone({ label, file, onFile, testId }: FileDropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) onFile(f);
    },
    [onFile]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onFile(f);
    e.target.value = "";
  };

  return (
    <div
      data-testid={testId}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      className={[
        "flex flex-col items-center justify-center gap-2 p-6 rounded-md border-2 border-dashed cursor-pointer transition-colors",
        dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
      ].join(" ")}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={handleChange}
        data-testid={`${testId}-input`}
      />
      {file ? (
        <div className="flex items-center gap-2 w-full">
          <FileSpreadsheet className="w-5 h-5 text-primary flex-shrink-0" />
          <span className="text-sm font-medium truncate flex-1">{file.name}</span>
          <Button
            size="icon"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onFile(null);
            }}
            data-testid={`${testId}-clear`}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      ) : (
        <>
          <Upload className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">.xlsx, .xls, .csv</p>
        </>
      )}
    </div>
  );
}

interface SummaryCardProps {
  label: string;
  value: number | string;
  variant?: "default" | "good" | "bad" | "warn";
}

function SummaryCard({ label, value, variant = "default" }: SummaryCardProps) {
  const colors: Record<string, string> = {
    default: "text-foreground",
    good: "text-green-600 dark:text-green-400",
    bad: "text-destructive",
    warn: "text-amber-600 dark:text-amber-400",
  };
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-card p-4">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-bold ${colors[variant]}`}>{value}</span>
    </div>
  );
}

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

      <div className="flex flex-1 overflow-hidden gap-4 p-4">
        {/* ── Left column: config ─────────────────────────────────────── */}
        <div className="w-72 flex-shrink-0 flex flex-col gap-4">
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
        <div className="flex-1 overflow-y-auto flex flex-col gap-4">
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
