import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { Redirect } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import { CheckCircle, RefreshCw, Printer, Download, ChevronDown, ChevronUp, Tag, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import type { Step } from "./factorybalerelabeling/types";
import { downloadCsv } from "./factorybalerelabeling/utils";
import { LabelPreviewCard } from "./factorybalerelabeling/components/LabelPreviewCard";
import { useFactoryBaleRelabelingState } from "./useFactoryBaleRelabelingState";
import { FactoryBaleRelabelingSection } from "./FactoryBaleRelabelingSection";
import { FactoryBaleRelabelingCardSection } from "./FactoryBaleRelabelingCardSection";

export default function FactoryBaleRelabeling() {
  const {
    applyMutation,
    applyResult,
    colors,
    designColor,
    fileName,
    fileRef,
    formatDisplayDate,
    handleFileSelect,
    handlePrint,
    handleReset,
    invalidRows,
    navigate,
    parseError,
    parsedRows,
    printFormatLabel,
    printFormats,
    sessions,
    setDesignColor,
    setShowHistory,
    setShowLabelPreview,
    showHistory,
    showLabelPreview,
    showRelabeling,
    showWipersReEntry,
    step,
    toggleFormat,
    validRows,
    validateMutation,
    validationResults,
  } = useFactoryBaleRelabelingState();

  if (!showRelabeling && showWipersReEntry) {
    return <Redirect to="/factory/bale-relabeling/wipers-re-entry" />;
  }
  if (!showRelabeling) {
    return (
      <div className="p-6 text-sm text-muted-foreground">No Bale Relabeling tabs are available for this user.</div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col" data-testid="factory-bale-relabeling-page">
      {/* Sub-nav tabs */}
      <div className="erp-mobile-scroll-tabs shrink-0 px-3 pt-3 pb-1 sm:px-6 sm:pt-4">
        <TabsList aria-label="Bale relabeling sections" className="w-max min-w-full sm:min-w-0 sm:w-fit">
          <PillTabButton selected data-testid="tab-relabeling">
            Bale Relabeling
          </PillTabButton>
          {showWipersReEntry && (
            <PillTabButton
              selected={false}
              onClick={() => navigate("/factory/bale-relabeling/wipers-re-entry")}
              data-testid="tab-wipers-re-entry"
            >
              Wipers Re-Entry by Date
            </PillTabButton>
          )}
        </TabsList>
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
            <Button
              variant="outline"
              onClick={handleReset}
              className="w-full sm:w-auto"
              data-testid="button-start-over"
            >
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
          <FactoryBaleRelabelingCardSection
            fileName={fileName}
            fileRef={fileRef}
            handleFileSelect={handleFileSelect}
            parseError={parseError}
            parsedRows={parsedRows}
            validateMutation={validateMutation}
          />
        )}

        {/* ── STEP 2: Validate ── */}
        {step === "validate" && (
          <FactoryBaleRelabelingSection
            applyMutation={applyMutation}
            colors={colors}
            designColor={designColor}
            fileName={fileName}
            handleReset={handleReset}
            invalidRows={invalidRows}
            printFormats={printFormats}
            setDesignColor={setDesignColor}
            toggleFormat={toggleFormat}
            validRows={validRows}
            validationResults={validationResults}
          />
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
                          <TableCell className="text-sm">
                            {formatDisplayDate(s.createdAt?.split("T")[0] || "")}
                          </TableCell>
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
