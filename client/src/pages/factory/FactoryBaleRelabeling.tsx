import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/PageHeader";
import {
  Upload,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Printer,
  Download,
  ChevronDown,
  ChevronUp,
  Tag,
  FileSpreadsheet,
  Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useDateFormat } from "@/contexts/DateFormatContext";
import {
  generateCombinedLabelsHtml,
  generateA5LabelsHtml,
  generateStickerLabelsHtml,
  prefetchBannersForPrint,
  type A4DesignColor,
  type LabelData,
} from "@/lib/labelHtml";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";

import type { ApplyItem, ParsedRow, Step, ValidationResult } from "./factorybalerelabeling/types";
import { downloadCsv, downloadExcelTemplate, parseExcelFile } from "./factorybalerelabeling/utils";
import { LabelPreviewCard } from "./factorybalerelabeling/components/LabelPreviewCard";

export default function FactoryBaleRelabeling() {
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [parseError, setParseError] = useState("");

  const [validationResults, setValidationResults] = useState<ValidationResult[]>([]);
  const [printFormats, setPrintFormats] = useState<Set<"A4" | "A5" | "STICKER">>(new Set(["A4"]));
  const [designColor, setDesignColor] = useState<A4DesignColor>("purple");
  const { colors } = useLabelDesignColors();

  const toggleFormat = (fmt: "A4" | "A5" | "STICKER") => {
    setPrintFormats((prev) => {
      const next = new Set(prev);
      if (next.has(fmt)) {
        if (next.size === 1) return prev;
        next.delete(fmt);
      } else {
        next.add(fmt);
      }
      return next;
    });
  };

  const printFormatLabel = Array.from(printFormats).join("+");

  const [applyResult, setApplyResult] = useState<{ sessionId: number; items: ApplyItem[] } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showLabelPreview, setShowLabelPreview] = useState(true);

  const validRows = validationResults.filter((r) => r.valid);
  const invalidRows = validationResults.filter((r) => !r.valid);

  const { data: sessions = [] } = useQuery<any[]>({
    queryKey: ["/api/factory/bales/relabel/sessions"],
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/factory/bales/relabel/sessions");
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const validateMutation = useMutation({
    mutationFn: async (rows: ParsedRow[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/bales/relabel/validate", {
        rows: rows.map((r) => ({ currentRef: r.currentRef })),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setValidationResults(data.results);
      setStep("validate");
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Validation failed", description: e.message, variant: "destructive" });
    },
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("POST", "/api/factory/bales/relabel/apply", {
        rows: validRows.map((r) => ({ currentRef: r.currentRef })),
        printFormat: printFormatLabel,
        designColor: printFormats.has("A4") ? designColor : undefined,
        filename: fileName,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/relabel/sessions"], refetchType: "active" });
      setApplyResult(data);
      setStep("done");
      toast({ title: "Relabeling applied", description: `${data.items.length} bales recoded successfully` });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Apply failed", description: e.message, variant: "destructive" });
    },
  });

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseError("");
    setParsedRows([]);
    try {
      const rows = await parseExcelFile(file);
      setParsedRows(rows);
    } catch (err) {
      setParseError(getErrorDetails(err).message);
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const handlePrint = () => {
    if (!applyResult) return;
    const labels: LabelData[] = applyResult.items.map((item) => ({
      referenceNumber: item.newRef,
      articleCode: item.articleCode || "",
      pieces: 1,
      approxWeightKg: item.weightKg || "0",
      productName: item.productName || "",
    }));

    prefetchBannersForPrint();
    let opened = 0;
    const formatsToOpen = Array.from(printFormats);
    for (const fmt of formatsToOpen) {
      let html: string;
      if (fmt === "A4") html = generateCombinedLabelsHtml(labels, designColor);
      else if (fmt === "A5") html = generateA5LabelsHtml(labels);
      else html = generateStickerLabelsHtml(labels);

      const win = window.open("", "_blank");
      if (!win) {
        toast({ title: "Popup blocked", description: "Allow popups to print labels", variant: "destructive" });
        return;
      }
      win.document.write(html);
      win.document.close();
      const delay = opened * 600;
      setTimeout(() => win.print(), 500 + delay);
      opened++;
    }
  };

  const handleReset = () => {
    setStep("upload");
    setFileName("");
    setParsedRows([]);
    setParseError("");
    setValidationResults([]);
    setApplyResult(null);
  };

  const [, navigate] = useLocation();

  return (
    <div className="flex h-full min-w-0 flex-col" data-testid="factory-bale-relabeling-page">
      {/* Sub-nav tabs */}
      <div className="flex-shrink-0 overflow-x-auto border-b px-3 pt-3 overscroll-x-contain sm:px-6 sm:pt-4">
        <div className="flex min-w-max items-center gap-1">
          <button
            className="shrink-0 rounded-t-md border-b-2 border-primary px-4 py-2 text-sm font-medium text-primary"
            data-testid="tab-relabeling"
          >
            Bale Relabeling
          </button>
          <button
            onClick={() => navigate("/factory/bale-relabeling/wipers-re-entry")}
            className="shrink-0 rounded-t-md px-4 py-2 text-sm font-medium text-muted-foreground hover-elevate"
            data-testid="tab-wipers-re-entry"
          >
            Wipers Re-Entry by Date
          </button>
        </div>
      </div>

      <div className="flex-1 min-w-0 space-y-4 overflow-y-auto p-3 sm:space-y-6 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <PageHeader
              title="Bale Relabeling"
              subtitle="Import bales from Excel and generate new reference codes with printable labels"
            />
          </div>
          {step !== "upload" && (
            <Button variant="outline" onClick={handleReset} className="w-full sm:w-auto" data-testid="button-start-over">
              <RefreshCw className="h-4 w-4 mr-2" /> Start Over
            </Button>
          )}
        </div>

        {/* Progress indicator */}
        <div className="-mx-1 overflow-x-auto px-1 pb-1 overscroll-x-contain" data-testid="relabeling-progress-strip">
          <div className="flex min-w-max items-center gap-2 text-sm">
            {(["upload", "validate", "done"] as Step[]).map((s, i) => (
              <div key={s} className="flex shrink-0 items-center gap-2">
                <div
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-medium ${step === s ? "bg-primary text-primary-foreground border-primary" : step > s || (step === "done" && s !== "done") ? "bg-muted text-muted-foreground border-muted" : "text-muted-foreground border-muted"}`}
                >
                  <span>{i + 1}</span>
                  <span>{s === "upload" ? "Upload" : s === "validate" ? "Validate" : "Apply & Print"}</span>
                </div>
                {i < 2 && <div className="h-px w-4 bg-muted-foreground/30" />}
              </div>
            ))}
          </div>
        </div>

        {/* ── STEP 1: Upload ── */}
        {step === "upload" && (
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2">
                <CardTitle className="flex items-center gap-2">
                  <Upload className="h-4 w-4" />
                  Upload Excel File
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadExcelTemplate}
                  className="w-full sm:w-auto"
                  data-testid="button-download-template"
                >
                  <FileSpreadsheet className="h-4 w-4 mr-2" />
                  Download Template
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="break-words text-sm text-muted-foreground">
                Upload a <code>.xlsx</code>, <code>.xls</code>, or <code>.csv</code> file with a column containing
                current bale reference codes. Accepted column names: <code>current_reference_code</code>,{" "}
                <code>reference_code</code>, <code>barcode</code>, <code>ref</code>, etc.
              </p>

              {/* Template hint */}
              <div className="flex items-start gap-2 rounded-md bg-muted/50 border p-3 text-sm text-muted-foreground">
                <FileSpreadsheet className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
                <span className="min-w-0 break-words">
                  Not sure of the format? Click <strong>Download Template</strong> above to get a pre-formatted Excel
                  file. Fill in your bale reference codes in the <code>current_reference_code</code> column and upload
                  it here.
                </span>
              </div>

              <div
                className="cursor-pointer rounded-md border-2 border-dashed p-5 text-center hover-elevate sm:p-8"
                onClick={() => fileRef.current?.click()}
                data-testid="drop-zone-upload"
              >
                <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                <p className="break-all text-sm font-medium">{fileName || "Click to select a file"}</p>
                {fileName && <p className="text-xs text-muted-foreground mt-1">{parsedRows.length} row(s) parsed</p>}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.csv"
                className="hidden"
                onChange={handleFileSelect}
                data-testid="input-file-upload"
              />

              {parseError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span className="min-w-0 break-words">{parseError}</span>
                </div>
              )}

              {parsedRows.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 text-sm text-muted-foreground sm:items-center">
                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-600 sm:mt-0" />
                    <span>{parsedRows.length} reference code(s) found in file</span>
                  </div>
                  <div className="max-h-48 overflow-auto rounded-md border">
                    <Table>
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead className="w-16">Row</TableHead>
                          <TableHead>Current Reference Code</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {parsedRows.slice(0, 20).map((r) => (
                          <TableRow key={r.rowNum} data-testid={`row-preview-${r.rowNum}`}>
                            <TableCell className="text-muted-foreground text-xs">{r.rowNum}</TableCell>
                            <TableCell className="font-mono text-sm">{r.currentRef}</TableCell>
                          </TableRow>
                        ))}
                        {parsedRows.length > 20 && (
                          <TableRow>
                            <TableCell colSpan={2} className="text-center text-xs text-muted-foreground py-2">
                              +{parsedRows.length - 20} more rows
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  <Button
                    onClick={() => validateMutation.mutate(parsedRows)}
                    disabled={validateMutation.isPending}
                    className="w-full sm:w-auto"
                    data-testid="button-validate"
                  >
                    {validateMutation.isPending ? "Validating..." : "Validate References"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── STEP 2: Validate ── */}
        {step === "validate" && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-4">
              {[
                { label: "Total Rows", value: validationResults.length, color: "" },
                { label: "Valid", value: validRows.length, color: "text-green-600" },
                {
                  label: "Invalid",
                  value: invalidRows.length,
                  color: invalidRows.length > 0 ? "text-destructive" : "",
                },
                { label: "File", value: fileName, color: "text-muted-foreground" },
              ].map(({ label, value, color }) => (
                <Card key={label}>
                  <CardContent className="pt-4 pb-3">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className={`truncate text-lg font-bold ${color}`} title={String(value)}>
                      {value}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Validation table */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Validation Results</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-h-80 overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Current Reference</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead>Weight (kg)</TableHead>
                        <TableHead>Stock Status</TableHead>
                        <TableHead>Valid</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {validationResults.map((r, i) => (
                        <TableRow
                          key={i}
                          className={r.valid ? "" : "bg-destructive/5"}
                          data-testid={`row-validation-${i}`}
                        >
                          <TableCell className="font-mono text-sm">{r.currentRef}</TableCell>
                          <TableCell className="text-sm">
                            {r.productName || <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-sm">
                            {r.weightKg ? parseFloat(r.weightKg).toFixed(1) : "—"}
                          </TableCell>
                          <TableCell>
                            {r.status ? (
                              <Badge variant={r.status === "IN_STOCK" ? "secondary" : "outline"} className="text-xs">
                                {r.status}
                              </Badge>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell>
                            {r.valid ? (
                              <CheckCircle className="h-4 w-4 text-green-600" />
                            ) : (
                              <div className="flex items-center gap-1 text-destructive text-xs">
                                <AlertCircle className="h-3.5 w-3.5" />
                                {r.error}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            {/* Print format */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Printer className="h-4 w-4" />
                  Label Format
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label className="text-sm font-medium mb-2 block">Print Formats (select one or more)</Label>
                  <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:flex sm:flex-wrap sm:gap-4">
                    {(["A4", "A5", "STICKER"] as const).map((fmt) => (
                      <label
                        key={fmt}
                        className="flex cursor-pointer select-none items-center gap-2"
                        data-testid={`checkbox-format-${fmt}`}
                      >
                        <Checkbox checked={printFormats.has(fmt)} onCheckedChange={() => toggleFormat(fmt)} />
                        <span className="text-sm font-medium">
                          {fmt === "A4" ? "A4 (Full Page)" : fmt === "A5" ? "A5 (Half Page)" : 'Sticker (3"×2")'}
                        </span>
                      </label>
                    ))}
                  </div>
                  {printFormats.size > 1 && (
                    <p className="text-xs text-muted-foreground mt-2">
                      {printFormats.size} formats selected — each will open in a separate print window.
                    </p>
                  )}
                </div>
                {printFormats.has("A4") && (
                  <div className="space-y-1.5">
                    <Label>A4 Label Design</Label>
                    <Select
                      value={designColor}
                      onValueChange={(v) => setDesignColor(v as A4DesignColor)}
                      data-testid="select-design-color"
                    >
                      <SelectTrigger className="w-full sm:max-w-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {colors.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            <div className="flex items-center gap-2">
                              <div className="h-3 w-3 rounded-full border" style={{ backgroundColor: opt.color }} />
                              {opt.label}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </CardContent>
            </Card>

            {validRows.length === 0 && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive sm:items-center">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 sm:mt-0" />
                No valid rows found. Please fix your file and start over.
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button
                onClick={() => applyMutation.mutate()}
                disabled={validRows.length === 0 || applyMutation.isPending}
                className="w-full sm:w-auto"
                data-testid="button-apply"
              >
                {applyMutation.isPending ? "Applying..." : `Generate New Codes & Apply (${validRows.length} bales)`}
              </Button>
              <Button variant="outline" onClick={handleReset} className="w-full sm:w-auto" data-testid="button-cancel">
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* ── STEP 3: Done ── */}
        {step === "done" && applyResult && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-green-600/30 bg-green-600/10 p-4 text-sm text-green-700 dark:text-green-400 sm:items-center">
              <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 sm:mt-0" />
              <span className="font-medium">{applyResult.items.length} bales successfully relabeled.</span>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-3">
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground">Bales Relabeled</p>
                  <p className="text-2xl font-bold">{applyResult.items.length}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground">Format</p>
                  <p className="break-all text-2xl font-bold">{printFormatLabel}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-xs text-muted-foreground">Session ID</p>
                  <p className="text-2xl font-bold">#{applyResult.sessionId}</p>
                </CardContent>
              </Card>
            </div>

            {/* Action buttons */}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button onClick={handlePrint} className="w-full sm:w-auto" data-testid="button-print-labels">
                <Printer className="h-4 w-4 mr-2" /> Print Labels ({printFormatLabel})
              </Button>
              <Button
                variant="outline"
                onClick={() => downloadCsv(applyResult.items, `relabeling-${applyResult.sessionId}.csv`)}
                className="w-full sm:w-auto"
                data-testid="button-export-csv"
              >
                <Download className="h-4 w-4 mr-2" /> Export Result CSV
              </Button>
            </div>

            {/* ── Label Preview ── */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Eye className="h-4 w-4" />
                    Label Preview
                    <Badge variant="secondary" className="text-xs font-normal">
                      {printFormatLabel}
                    </Badge>
                  </CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowLabelPreview((v) => !v)}
                    data-testid="button-toggle-preview"
                  >
                    {showLabelPreview ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    {showLabelPreview ? "Hide" : "Show"}
                  </Button>
                </div>
              </CardHeader>
              {showLabelPreview && (
                <CardContent className="space-y-4">
                  {Array.from(printFormats).map((fmt) => (
                    <div key={fmt}>
                      {printFormats.size > 1 && (
                        <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                          {fmt === "A4" ? "A4 (Full Page)" : fmt === "A5" ? "A5 (Half Page)" : 'Sticker (3"×2")'}
                        </p>
                      )}
                      <div className="flex max-w-full gap-4 overflow-x-auto pb-2 overscroll-x-contain">
                        {applyResult.items.slice(0, 4).map((item, i) => (
                          <LabelPreviewCard key={i} item={item} designColor={designColor} printFormat={fmt} />
                        ))}
                      </div>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Showing up to 4 per format — {applyResult.items.length} total bales will print. Click{" "}
                    <strong>Print Labels</strong> above to print all.
                  </p>
                </CardContent>
              )}
            </Card>

            {/* Mapping table */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Tag className="h-4 w-4" />
                  Old → New Reference Mapping
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-h-80 overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Old Reference</TableHead>
                        <TableHead>New Reference</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead>Weight (kg)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {applyResult.items.map((item, i) => (
                        <TableRow key={i} data-testid={`row-result-${i}`}>
                          <TableCell className="font-mono text-sm text-muted-foreground line-through">
                            {item.oldRef}
                          </TableCell>
                          <TableCell className="font-mono text-sm font-medium">{item.newRef}</TableCell>
                          <TableCell className="text-sm">{item.productName}</TableCell>
                          <TableCell className="text-sm">{parseFloat(item.weightKg).toFixed(1)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── History panel ── */}
        <div className="overflow-hidden rounded-md border">
          <button
            type="button"
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover-elevate"
            onClick={() => setShowHistory((v) => !v)}
            data-testid="button-toggle-history"
          >
            <span>Recent Relabeling Sessions</span>
            {showHistory ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {showHistory && (
            <div className="border-t px-3 pb-4 pt-2 sm:px-4">
              {sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No sessions yet</p>
              ) : (
                <div className="max-w-full overflow-x-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>File</TableHead>
                        <TableHead>Format</TableHead>
                        <TableHead>Total</TableHead>
                        <TableHead>Valid</TableHead>
                        <TableHead>Invalid</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sessions.map((s) => (
                        <TableRow key={s.id} data-testid={`row-session-${s.id}`}>
                          <TableCell className="text-sm">{formatDisplayDate(s.createdAt?.split("T")[0] || "")}</TableCell>
                          <TableCell className="text-sm text-muted-foreground truncate max-w-40">
                            {s.uploadedFilename || "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="text-xs">
                              {s.printFormat}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">{s.totalRows}</TableCell>
                          <TableCell className="text-sm text-green-600">{s.validRows}</TableCell>
                          <TableCell className="text-sm text-destructive">{s.invalidRows}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
