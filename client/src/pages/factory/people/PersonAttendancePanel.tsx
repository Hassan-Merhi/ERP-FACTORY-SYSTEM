/**
 * Read-only attendance history for one worker or employee, shown as a tab on
 * both detail pages, with the same Excel / PDF / Print export. Each page
 * passes its own existing per-person endpoint; marking attendance stays on
 * the hub's Attendance tab.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/page-state";
import { PeriodFilter, getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { ReportExportMenu } from "@/components/export/ReportExportMenu";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { STATUS_COLORS, STATUS_OPTIONS } from "../factoryattendance/utils";
import { exportPeopleTableExcel, exportPeopleTablePdf, printPeopleTable, type PeopleExportSpec } from "./peopleExport";

export interface PersonAttendanceRecord {
  id: number;
  attendanceDate: string;
  status: string;
  notes: string | null;
}

export interface PersonAttendancePanelProps {
  /** Existing per-person endpoint without query string, e.g. `/api/factory/attendance/worker/12`. */
  endpoint: string;
  personName: string;
  /** "worker" / "employee": used in the export title and file name. */
  kind: "worker" | "employee";
  formatDate: (value: string) => string;
}

export function PersonAttendancePanel({ endpoint, personName, kind, formatDate }: PersonAttendancePanelProps) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [period, setPeriod] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("this_month"));
  const [busy, setBusy] = useState(false);
  const from = period.fromDate;
  const to = period.toDate;
  const ready = Boolean(selectedCompany?.id && from && to);

  const { data, isLoading, isError, refetch } = useQuery<PersonAttendanceRecord[]>({
    queryKey: companyQueryKey(endpoint, selectedCompany?.id, from, to),
    enabled: ready,
    queryFn: async () => {
      const params = new URLSearchParams({ startDate: from, endDate: to });
      const res = await fetch(`${endpoint}?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load attendance");
      return res.json();
    },
  });
  const records = data ?? [];
  const counts = STATUS_OPTIONS.map((status) => ({
    status,
    count: records.filter((record) => record.status === status).length,
  }));

  const title = kind === "worker" ? "Worker Attendance" : "Employee Attendance";
  const spec = (): PeopleExportSpec<PersonAttendanceRecord> => ({
    title,
    fileStem: `${personName} attendance`,
    subtitle: personName,
    period: { from, to },
    columns: [
      { header: "#", type: "integer", width: 6, value: (_record, index) => index + 1 },
      { header: "Date", width: 16, value: (record) => formatDate(record.attendanceDate) },
      { header: "Status", width: 14, value: (record) => record.status },
      { header: "Notes", width: 40, value: (record) => record.notes ?? "" },
    ],
    rows: records,
    footer: [null, "", counts.map(({ status, count }) => `${status}: ${count}`).join(", "), ""],
  });

  const run = async (format: "excel" | "pdf") => {
    setBusy(true);
    try {
      if (format === "excel") await exportPeopleTableExcel(spec());
      else await exportPeopleTablePdf(spec());
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };
  const print = () => {
    if (!printPeopleTable(spec())) {
      toast({ title: "Print failed", description: "Allow pop-ups to print.", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4" data-testid="person-attendance-panel">
      <div className="flex flex-wrap items-center gap-3">
        <PeriodFilter value={period} onChange={setPeriod} data-testid="filter-person-attendance-period" />
        <div className="ml-auto">
          <ReportExportMenu
            busy={busy}
            disabled={!records.length}
            data-testid="button-person-attendance-export"
            options={[
              { id: "excel", label: "Excel", kind: "excel", onSelect: () => run("excel") },
              { id: "pdf", label: "PDF", kind: "pdf", onSelect: () => run("pdf") },
              { id: "print", label: "Print", kind: "print", onSelect: print },
            ]}
          />
        </div>
      </div>

      {ready && records.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="person-attendance-counts">
          {counts.map(({ status, count }) => (
            <Badge key={status} variant="outline" className={`gap-1 ${STATUS_COLORS[status] ?? ""}`}>
              {status}
              <span className="font-semibold tabular-nums">{count}</span>
            </Badge>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {!ready ? (
            <EmptyState title="Choose a start and end date" className="border-0" />
          ) : isLoading ? (
            <LoadingState className="border-0" />
          ) : isError ? (
            <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="border-0" />
          ) : records.length === 0 ? (
            <EmptyState title="No attendance recorded for this period" className="border-0" />
          ) : (
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow key={record.id} data-testid={`row-person-attendance-${record.id}`}>
                    <TableCell className="whitespace-nowrap text-sm">{formatDate(record.attendanceDate)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_COLORS[record.status] ?? ""}>
                        {record.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{record.notes || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
