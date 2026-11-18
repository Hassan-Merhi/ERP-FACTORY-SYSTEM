// Extracted from ./FactoryBaleRelabeling.tsx to keep that module under the source-size cap.
import { AlertCircle, CheckCircle, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { A4DesignColor } from "@/lib/labelHtml";
import { useFactoryBaleRelabelingState2 } from "./useFactoryBaleRelabelingState2";

export function FactoryBaleRelabelingSection({
  applyMutation,
  colors,
  designColor,
  fileName,
  handleReset,
  invalidRows,
  printFormats,
  setDesignColor,
  toggleFormat,
  validRows,
  validationResults,
}: Pick<
  ReturnType<typeof useFactoryBaleRelabelingState2>,
  | "applyMutation"
  | "colors"
  | "designColor"
  | "fileName"
  | "handleReset"
  | "invalidRows"
  | "printFormats"
  | "setDesignColor"
  | "toggleFormat"
  | "validRows"
  | "validationResults"
>) {
  return (
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
                  <TableRow key={i} className={r.valid ? "" : "bg-destructive/5"} data-testid={`row-validation-${i}`}>
                    <TableCell className="font-mono text-sm">{r.currentRef}</TableCell>
                    <TableCell className="text-sm">
                      {r.productName || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-sm">{r.weightKg ? parseFloat(r.weightKg).toFixed(1) : "—"}</TableCell>
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
  );
}
