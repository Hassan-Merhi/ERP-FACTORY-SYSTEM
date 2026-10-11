import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, FileSpreadsheet, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { formatNumber } from "@/lib/formatNumber";
import { cn } from "@/lib/utils";

/** Server amounts are exact 2-decimal strings; they are only formatted here. */
export function formatAmount(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return formatNumber(typeof value === "number" ? value : Number(value), 2);
}

export const amountCellClassName = "text-end font-mono tabular-nums whitespace-nowrap";

export function Amount({ value, className }: { value: string | number | null | undefined; className?: string }) {
  const negative = typeof value === "string" ? value.trim().startsWith("-") : typeof value === "number" && value < 0;
  return (
    <span className={cn(amountCellClassName, negative && "text-destructive", className)}>{formatAmount(value)}</span>
  );
}

/** Builds `path?key=value` from the defined, non-empty parameters. */
export function reportUrl(path: string, params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function useReport<T>(url: string, enabled = true) {
  return useQuery<T>({ queryKey: [url], enabled, retry: false, staleTime: 60_000 });
}

export interface FutureDated {
  businessDate: string;
  count: number;
  vouchers: Array<{ id: number; voucherNumber: string; voucherType: string; bookedOn: string }>;
}

export function FutureDatedNotice({ futureDated }: { futureDated?: FutureDated | null }) {
  if (!futureDated || futureDated.count === 0) return null;
  const { businessDate, count } = futureDated;
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
      data-testid="notice-future-dated"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p>{`Vouchers dated after the business date ${businessDate}: ${count}`}</p>
        <p className="wrap-break-word text-xs">
          {futureDated.vouchers.map((voucher) => `${voucher.voucherNumber} (${voucher.bookedOn})`).join(", ")}
        </p>
      </div>
    </div>
  );
}

export function DifferenceNotice({ difference, label }: { difference: string; label: string }) {
  if (Number(difference) === 0) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive"
      data-testid="notice-difference"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {label}: <Amount value={difference} />
      </span>
    </div>
  );
}

export function DateField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full min-w-0 sm:w-44"
        data-testid={`input-${id}`}
      />
    </div>
  );
}

export function ReportToolbar({ children, exportPath }: { children: ReactNode; exportPath?: string }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
      <div className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:flex sm:flex-wrap sm:items-end">
        {children}
      </div>
      {exportPath ? <ExportButtons exportPath={exportPath} /> : null}
    </div>
  );
}

async function download(url: string): Promise<void> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: "Export failed" }));
    throw new Error(body.message || "Export failed");
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = match ? match[1] : "report";
  link.click();
  URL.revokeObjectURL(objectUrl);
}

export function ExportButtons({ exportPath }: { exportPath: string }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"xlsx" | "pdf" | null>(null);
  const run = async (format: "xlsx" | "pdf") => {
    setBusy(format);
    try {
      const separator = exportPath.includes("?") ? "&" : "?";
      await download(`${exportPath}${separator}format=${format}`);
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => run("xlsx")} disabled={busy !== null} data-testid="button-export-xlsx">
        <FileSpreadsheet className="me-2 h-4 w-4" aria-hidden="true" />
        Excel
      </Button>
      <Button variant="outline" onClick={() => run("pdf")} disabled={busy !== null} data-testid="button-export-pdf">
        <FileText className="me-2 h-4 w-4" aria-hidden="true" />
        PDF
      </Button>
    </div>
  );
}

export function ReportState({
  isLoading,
  error,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  children: ReactNode;
}) {
  if (isLoading) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="report-loading">
        Loading report…
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-sm text-destructive" data-testid="report-error">
        {error instanceof Error ? error.message : "The report could not be loaded"}
      </p>
    );
  }
  return <>{children}</>;
}

export interface StatementLine {
  key: string;
  code?: string | null;
  name: string;
  amount: string | number | null;
  compare?: string | number | null;
  emphasis?: boolean;
}

/** A two- or three-column statement table (line, amount, optional comparative). */
export function StatementTable({
  title,
  lines,
  compareLabel,
  testId,
}: {
  title: string;
  lines: StatementLine[];
  compareLabel?: string | null;
  testId: string;
}) {
  return (
    <Card className="min-w-0" data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 p-0 sm:p-6 sm:pt-0">
        <Table mobileLayout="cards" scrollLabel={title}>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Line</TableHead>
              <TableHead className="text-end">Amount</TableHead>
              {compareLabel ? <TableHead className="text-end">{compareLabel}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={compareLabel ? 4 : 3} className="text-muted-foreground">
                  No lines
                </TableCell>
              </TableRow>
            ) : (
              lines.map((line) => (
                <TableRow key={line.key} className={cn(line.emphasis && "font-semibold")}>
                  <TableCell className="whitespace-nowrap">{line.code ?? ""}</TableCell>
                  <TableCell className="min-w-0 wrap-break-word">{line.name}</TableCell>
                  <TableCell className="text-end">
                    <Amount value={line.amount} />
                  </TableCell>
                  {compareLabel ? (
                    <TableCell className="text-end">
                      <Amount value={line.compare ?? null} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function MetricCard({ label, value, testId }: { label: string; value: ReactNode; testId: string }) {
  return (
    <Card className="min-w-0" data-testid={testId}>
      <CardContent className="flex min-w-0 flex-col gap-1 p-4">
        <span className="wrap-break-word text-xs text-muted-foreground">{label}</span>
        <span className="min-w-0 wrap-break-word text-lg font-semibold">{value}</span>
      </CardContent>
    </Card>
  );
}
