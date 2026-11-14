/**
 * The loading-session history of an invoice: every session ever opened against
 * it, with the exports for one session or for the whole invoice.
 *
 * It reads only the session rows and reports which row was acted on, so the
 * page keeps deciding what "resume" and "view" mean.
 *
 * Extracted from FactoryInvoiceLoadingScan.tsx during the god-file split.
 */
import { FileDown, FileSpreadsheet, List, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { StatusBadge } from "./StatusBadge";
import type { SessionSummary } from "../types";
import { fmtTime } from "../utils";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";

export function SessionHistoryCard({
  invoiceId,
  sessions,
  activeSessionId,
  onViewSession,
  onResumeSession,
}: {
  invoiceId: number | null;
  sessions: SessionSummary[];
  activeSessionId: number | null;
  onViewSession: (sessionId: number) => void;
  onResumeSession: (sessionId: number) => void;
}) {
  const { toast } = useToast();
  const downloadExport = async (url: string, fileName: string) => {
    try {
      await downloadFromUrl(url, { fileName });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">Loading Sessions</CardTitle>
          <div className="flex items-center gap-2">
            <ExportButton
              size="sm"
              label="Export Excel (Full Report)"
              onClick={() =>
                void downloadExport(
                  `/api/factory/invoices/${invoiceId}/loading-report/export/excel`,
                  exportFileName(`invoice ${invoiceId} loading report`, "xlsx")
                )
              }
              data-testid="button-export-report-excel"
            />
            <ExportButton
              kind="pdf"
              size="sm"
              label="Export PDF (Full Report)"
              onClick={() => window.open(`/api/factory/invoices/${invoiceId}/loading-report/export/pdf`, "_blank")}
              data-testid="button-export-report-pdf"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="table-responsive">
          <Table mobileLayout="cards">
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Truck / Driver</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead className="text-right">Bales</TableHead>
                <TableHead className="text-right w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow
                  key={s.id}
                  data-testid={`row-session-${s.id}`}
                  className={s.id === activeSessionId ? "bg-blue-50 dark:bg-blue-950/40" : ""}
                >
                  <TableCell className="font-mono text-sm">#{s.id}</TableCell>
                  <TableCell>
                    <StatusBadge status={s.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {s.truckNo || s.driverName ? [s.truckNo, s.driverName].filter(Boolean).join(" / ") : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {fmtTime(s.startedAt)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {fmtTime(s.completedAt)}
                  </TableCell>
                  <TableCell className="text-right font-medium">{s.totalBales}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {s.status !== "CANCELLED" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onViewSession(s.id)}
                          data-testid={`button-view-session-bales-${s.id}`}
                          title="View & manage bales"
                        >
                          <List className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {s.status === "OPEN" && s.id !== activeSessionId && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onResumeSession(s.id)}
                          data-testid={`button-resume-session-${s.id}`}
                          title="Resume this session"
                        >
                          <RotateCcw className="h-3.5 w-3.5 mr-1" />
                          Resume
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Export Excel (Session)"
                        aria-label="Export Excel (Session)"
                        onClick={() =>
                          void downloadExport(
                            `/api/factory/invoice-loading-sessions/${s.id}/export/excel`,
                            exportFileName(`loading session ${s.id}`, "xlsx")
                          )
                        }
                        data-testid={`button-session-excel-${s.id}`}
                      >
                        <FileSpreadsheet className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Export PDF (Session)"
                        aria-label="Export PDF (Session)"
                        onClick={() =>
                          window.open(`/api/factory/invoice-loading-sessions/${s.id}/export/pdf`, "_blank")
                        }
                        data-testid={`button-session-pdf-${s.id}`}
                      >
                        <FileDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
