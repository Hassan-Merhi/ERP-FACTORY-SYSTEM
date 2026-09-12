/**
 * Validation-error list and parsed-file preview table for the POS Import page.
 *
 * Split out of POSImport.tsx unchanged: the error card still carries the ref
 * the validate mutation scrolls to, and the preview still shows rates in the
 * selected sale currency with the USD conversion note.
 */
import { AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";
import type { PosImportItem } from "./types";
import type { PosImportModel } from "./usePosImportModel";

export function PosImportValidationErrors({ model }: { model: PosImportModel }) {
  const { validationResult } = model;
  if (!validationResult?.errors || validationResult.errors.length === 0) return null;
  return (
    <Card className="border-destructive" ref={model.errorsRef}>
      <CardHeader className="pb-3">
        <CardTitle className="text-destructive flex items-center gap-2">
          <XCircle className="h-5 w-5" />
          Validation Errors
          <span className="ml-auto text-sm font-normal bg-destructive text-destructive-foreground rounded-full px-2 py-0.5">
            {validationResult.errors.length} error{validationResult.errors.length !== 1 ? "s" : ""}
          </span>
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Fix these barcodes or remove the rows from your Excel file before importing.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
          {validationResult.errors.map((error: string, index: number) => (
            <li
              key={index}
              className="flex items-start gap-2 text-sm text-destructive bg-destructive/5 rounded px-2 py-1"
            >
              <span className="font-mono text-xs text-muted-foreground shrink-0 mt-0.5 w-6 text-right">
                {index + 1}.
              </span>
              {error}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RowStatus({ validation }: { validation: PosImportItem | undefined }) {
  if (!validation) return <span className="text-sm text-muted-foreground">Not validated</span>;
  if (validation.error) {
    return (
      <div className="flex items-center gap-1 text-destructive">
        <XCircle className="h-4 w-4" />
        <span className="text-sm">{validation.error}</span>
      </div>
    );
  }
  if (validation.warning) {
    return (
      <div className="flex items-center gap-1 text-amber-600">
        <AlertTriangle className="h-4 w-4" />
        <span className="text-sm">{validation.warning}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-green-600">
      <CheckCircle className="h-4 w-4" />
      <span className="text-sm">OK</span>
    </div>
  );
}

export function PosImportPreview({ model }: { model: PosImportModel }) {
  const { preview, validationResult, saleCurrency, exchangeRate } = model;
  if (!preview) return null;
  const prefix = saleCurrency === "CFA" ? "CFA " : "$";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview ({preview.items.length} items)</CardTitle>
        <CardDescription>
          Total Sales Value: {prefix}
          {formatNumber(preview.totalValue)}
          {saleCurrency === "CFA" && exchangeRate && (
            <span className="ml-2 text-muted-foreground">
              (≈ ${formatNumber(preview.totalValue / exchangeRate)} USD after conversion)
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Barcode</TableHead>
                <TableHead>Item Name</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">Rate ({saleCurrency})</TableHead>
                <TableHead className="text-right">Total ({saleCurrency})</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.items.map((item, index: number) => {
                const validation = validationResult?.validatedItems?.[index];
                const hasError = validation?.error;

                return (
                  <TableRow key={index} className={hasError ? "bg-destructive/10" : ""}>
                    <TableCell className="font-mono">{item.barcode}</TableCell>
                    <TableCell>
                      {validation?.stockItemName || <span className="text-muted-foreground italic">Unknown</span>}
                    </TableCell>
                    <TableCell className="text-right">{item.quantity}</TableCell>
                    <TableCell className="text-right">
                      {prefix}
                      {formatNumber(Number(item.rate))}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {prefix}
                      {formatNumber(Number(item.quantity) * Number(item.rate))}
                    </TableCell>
                    <TableCell>
                      <RowStatus validation={validation} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
