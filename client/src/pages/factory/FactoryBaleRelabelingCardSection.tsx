// Extracted from ./FactoryBaleRelabeling.tsx to keep that module under the source-size cap.
import { AlertCircle, CheckCircle, FileSpreadsheet, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { downloadExcelTemplate } from "./factorybalerelabeling/utils";
import { useFactoryBaleRelabelingState } from "./useFactoryBaleRelabelingState";

export function FactoryBaleRelabelingCardSection({
  fileName,
  fileRef,
  handleFileSelect,
  parseError,
  parsedRows,
  validateMutation,
}: Pick<
  ReturnType<typeof useFactoryBaleRelabelingState>,
  "fileName" | "fileRef" | "handleFileSelect" | "parseError" | "parsedRows" | "validateMutation"
>) {
  return (
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
        <p className="wrap-break-word text-sm text-muted-foreground">
          Upload a <code>.xlsx</code>, <code>.xls</code>, or <code>.csv</code> file with a column containing current
          bale reference codes. Accepted column names: <code>current_reference_code</code>, <code>reference_code</code>,{" "}
          <code>barcode</code>, <code>ref</code>, etc.
        </p>

        {/* Template hint */}
        <div className="flex items-start gap-2 rounded-md bg-muted/50 border p-3 text-sm text-muted-foreground">
          <FileSpreadsheet className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
          <span className="min-w-0 wrap-break-word">
            Not sure of the format? Click <strong>Download Template</strong> above to get a pre-formatted Excel file.
            Fill in your bale reference codes in the <code>current_reference_code</code> column and upload it here.
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
            <span className="min-w-0 wrap-break-word">{parseError}</span>
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
  );
}
