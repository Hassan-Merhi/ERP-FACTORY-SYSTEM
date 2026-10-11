import { useState, type ChangeEvent } from "react";
import { Loader2, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { apiRequestPrivileged } from "@/lib/queryClient";
import type { ClientErrorLike } from "@/lib/clientError";

import {
  classifyRateRows,
  countByStatus,
  parseRateFile,
  type ClassifiedRateRow,
  type RateFileError,
  type RateFileKind,
  type RecordedRate,
} from "./rateFileImport";

interface RateFileImportPanelProps {
  kind: RateFileKind;
  recorded: RecordedRate[];
  importUrl: string;
  today: string;
  onSaved: () => void;
}

const ERROR_TEXT: Record<RateFileError["reason"], string> = {
  columns: "The file header is not a rates file. Use currency,date,rate_to_usd or the prepared ECB table.",
  currency: "Invalid currency",
  date: "Invalid date (YYYY-MM-DD)",
  future: "Dated after today: refused",
  rate: "Invalid rate (a positive number)",
  duplicate: "Same currency and date twice",
};

const STATUS_TEXT: Record<ClassifiedRateRow["status"], string> = {
  new: "New",
  identical: "Same as recorded",
  conflict: "Differs from recorded",
};

const STATUS_VARIANT: Record<ClassifiedRateRow["status"], "default" | "secondary" | "destructive"> = {
  new: "default",
  identical: "secondary",
  conflict: "destructive",
};

/** The body the import route takes for a set of reviewed rows. */
export function rateImportBody(kind: RateFileKind, rows: ClassifiedRateRow[], replaceConflicts: boolean) {
  const selected = rows.filter((row) => row.status === "new" || (replaceConflicts && row.status === "conflict"));
  return {
    replaceConflicts,
    rows: selected.map((row) =>
      kind === "factory"
        ? { currencyCode: row.fromCurrency, effectiveDate: row.effectiveDate, rateToUsd: row.rate }
        : {
            fromCurrency: row.fromCurrency,
            toCurrency: row.toCurrency,
            effectiveDate: row.effectiveDate,
            rate: row.rate,
          }
    ),
  };
}

/** "Import rates file": read, preview (new / same / differs), then save through the audited import route. */
export function RateFileImportPanel({ kind, recorded, importUrl, today, onSaved }: RateFileImportPanelProps) {
  const { toast } = useToast();
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ClassifiedRateRow[]>([]);
  const [errors, setErrors] = useState<RateFileError[]>([]);
  const [replaceConflicts, setReplaceConflicts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const counts = countByStatus(rows);
  const toSave = counts.new + (replaceConflicts ? counts.conflict : 0);

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const parsed = parseRateFile(await file.text(), kind, today);
    setFileName(file.name);
    setRows(classifyRateRows(parsed.rows, recorded));
    setErrors(parsed.errors);
    setReplaceConflicts(false);
    setRefusal(null);
  };

  const save = async () => {
    setSaving(true);
    setRefusal(null);
    try {
      const response = await apiRequestPrivileged("POST", importUrl, rateImportBody(kind, rows, replaceConflicts));
      const result = (await response.json()) as { inserted?: unknown[]; identical?: unknown[] };
      toast({ title: `Rates saved: ${result.inserted?.length ?? 0}` });
      setRows([]);
      setErrors([]);
      setFileName(null);
      onSaved();
    } catch (error) {
      const failure = error as ClientErrorLike & { status?: number };
      setRefusal(
        failure.code === "RATE_IMPORT_CONFLICT"
          ? "A recorded rate changed since the preview. Read the file again."
          : (failure.message ?? "The rates were not saved.")
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid={`rate-import-${kind}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Label htmlFor={`rate-file-${kind}`} className="flex items-center gap-2 font-medium">
          <Upload className="h-4 w-4" aria-hidden="true" />
          Import rates file
        </Label>
        <Input
          id={`rate-file-${kind}`}
          type="file"
          accept=".csv,text/csv"
          onChange={readFile}
          className="w-full sm:w-auto"
          data-testid={`input-rate-file-${kind}`}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {kind === "factory"
          ? "CSV with the columns currency,date,rate_to_usd (USD per 1 unit), or the prepared ECB table. Rates dated after today are refused."
          : "CSV with the columns from_currency,to_currency,date,rate, or currency,date,rate_to_usd (currency to USD), or the prepared ECB table. Rates dated after today are refused."}
      </p>
      {fileName && (
        <div className="space-y-2" data-testid={`rate-import-preview-${kind}`}>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="default" data-testid={`count-rate-new-${kind}`}>{`New: ${counts.new}`}</Badge>
            <Badge variant="secondary" data-testid={`count-rate-identical-${kind}`}>
              {`Same as recorded: ${counts.identical}`}
            </Badge>
            <Badge variant="destructive" data-testid={`count-rate-conflict-${kind}`}>
              {`Differs from recorded: ${counts.conflict}`}
            </Badge>
            {errors.length > 0 && (
              <Badge variant="destructive" data-testid={`count-rate-errors-${kind}`}>
                {`Rows refused: ${errors.length}`}
              </Badge>
            )}
          </div>
          {errors.length > 0 && (
            <ul className="space-y-1 text-sm text-destructive" data-testid={`rate-import-errors-${kind}`}>
              {errors.slice(0, 20).map((error) => (
                <li key={`${error.line}-${error.reason}`} className="flex gap-1">
                  <span>{`Line ${error.line}:`}</span>
                  <span>{ERROR_TEXT[error.reason]}</span>
                </li>
              ))}
            </ul>
          )}
          {rows.length > 0 && (
            <Table maxHeight="20rem" scrollLabel="Rates file preview">
              <TableHeader>
                <TableRow>
                  <TableHead>Currency</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-end">Rate</TableHead>
                  <TableHead className="text-end">Recorded</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={`${row.fromCurrency}-${row.toCurrency}-${row.effectiveDate}`}
                    data-testid={`row-rate-import-${row.fromCurrency}-${row.effectiveDate}`}
                  >
                    <TableCell className="font-mono">
                      {kind === "factory" ? row.fromCurrency : `${row.fromCurrency} → ${row.toCurrency}`}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{row.effectiveDate}</TableCell>
                    <TableCell className="text-end font-mono tabular-nums">{row.rate}</TableCell>
                    <TableCell className="text-end font-mono tabular-nums">{row.recorded ?? "—"}</TableCell>
                    <TableCell data-i18n-ui>
                      <Badge variant={STATUS_VARIANT[row.status]}>{STATUS_TEXT[row.status]}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {counts.conflict > 0 && (
            <div className="flex items-start gap-2">
              <Checkbox
                id={`rate-replace-${kind}`}
                checked={replaceConflicts}
                onCheckedChange={(value) => setReplaceConflicts(value === true)}
                data-testid={`checkbox-rate-replace-${kind}`}
              />
              <Label htmlFor={`rate-replace-${kind}`} className="text-sm leading-snug">
                {`Replace the recorded rate on ${counts.conflict} differing rows (otherwise they are skipped)`}
              </Label>
            </div>
          )}
          {refusal && (
            <p className="text-sm text-destructive" role="alert" data-testid={`rate-import-refusal-${kind}`}>
              {refusal}
            </p>
          )}
          <Button
            onClick={save}
            disabled={saving || toSave === 0 || errors.length > 0}
            className="w-full sm:w-auto"
            data-testid={`button-save-rate-file-${kind}`}
          >
            {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {`Save ${toSave} rates`}
          </Button>
          {errors.length > 0 && (
            <p className="text-xs text-muted-foreground">Correct the refused rows in the file and read it again.</p>
          )}
        </div>
      )}
    </div>
  );
}
