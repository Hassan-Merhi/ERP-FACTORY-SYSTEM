import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest } from "@/lib/queryClient";
import {
  actionBadgeVariant,
  actionLabel,
  fmtDate,
  getDetailsSentence,
  getRecordLabel,
  tableShortName,
} from "./AuditLogUtils";
import { AuditLogDialog } from "./AuditLogDialog";
import type { SettingsAuditLogRow } from "./settingsTypes";

export { fmtDate, getDetailsSentence, getRecordLabel, tableShortName };

const ACTION_FILTER_OPTIONS: { label: string; value: string }[] = [
  { label: "All Activity", value: "all" },
  { label: "Created", value: "create" },
  { label: "Edited", value: "update" },
  { label: "Deleted", value: "delete" },
  { label: "Restored", value: "restore" },
  { label: "Reversed / Voided", value: "reverse,void" },
  { label: "Recalculated / Repaired", value: "recalculate,repair" },
  { label: "Imports", value: "import" },
  { label: "Exports", value: "export" },
  { label: "Sent to WhatsApp / Email", value: "send_whatsapp,send_email" },
  { label: "Approvals / Cancellations", value: "approve,cancel" },
  { label: "Transfers / Adjustments", value: "transfer,adjust,offload" },
  { label: "Settings / Permissions", value: "settings_change,permission_change" },
  { label: "Updates & Deletes", value: "update,delete" },
];

type DayGroup = {
  dateKey: string;
  dateLabel: string;
  logs: SettingsAuditLogRow[];
};

function groupLogsByDay(logs: SettingsAuditLogRow[]): DayGroup[] {
  const dayMap = new Map<string, SettingsAuditLogRow[]>();

  for (const log of logs) {
    const date = new Date(log.createdAt);
    const dateKey = date.toLocaleDateString("en-CA");
    if (!dayMap.has(dateKey)) dayMap.set(dateKey, []);
    dayMap.get(dateKey)!.push(log);
  }

  return [...dayMap.entries()].map(([dateKey, dayLogs]) => {
    const [year, month, day] = dateKey.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return {
      dateKey,
      dateLabel: date.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      logs: dayLogs,
    };
  });
}

export interface AuditLogProps {
  /** Initial action filter value. "all" = no action restriction. Default: "update,delete" */
  defaultActions?: string;
  /** "settings" = original compact view; "daybook" = full activity view. Default: "settings" */
  context?: "settings" | "daybook";
  /** Whether to show the Card heading. Default: false */
  showHeading?: boolean;
}

export function AuditLog({
  defaultActions = "update,delete",
  context = "settings",
  showHeading = false,
}: AuditLogProps = {}) {
  const { selectedCompany, isLoading: isCompanyLoading } = useCompany();
  const activeCompanyId = selectedCompany?.id ?? null;

  const [filterAction, setFilterAction] = useState(defaultActions);
  const [filterModule, setFilterModule] = useState("");
  const [filterSearch, setFilterSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [selectedLog, setSelectedLog] = useState<SettingsAuditLogRow | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = useCallback((value: string) => {
    setFilterSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
    }, 350);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useEffect(() => {
    setPage(1);
  }, [filterAction, filterModule, debouncedSearch, filterDateFrom, filterDateTo, activeCompanyId]);

  useEffect(() => {
    // A dialog opened under one company must disappear immediately when the
    // company changes, even while the new company history is still loading.
    setSelectedLog(null);
  }, [activeCompanyId, isCompanyLoading]);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: [
      "/api/audit-log",
      activeCompanyId,
      {
        action: filterAction === "all" ? "" : filterAction,
        module: filterModule,
        search: debouncedSearch,
        from: filterDateFrom,
        to: filterDateTo,
        page,
      },
    ],
    enabled: activeCompanyId !== null && !isCompanyLoading,
    queryFn: async () => {
      const params = new URLSearchParams({
        action: filterAction === "all" ? "all" : filterAction,
        module: filterModule,
        search: debouncedSearch,
        from: filterDateFrom,
        to: filterDateTo,
        page: page.toString(),
        limit: "50",
        profile: "summary",
      });
      const res = await apiRequest("GET", `/api/audit-log?${params.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        const requestError = new Error(payload?.message || "Failed to fetch activity history") as Error & {
          status?: number;
          code?: string;
        };
        requestError.status = res.status;
        requestError.code = payload?.code;
        throw requestError;
      }
      return res.json();
    },
  });

  const selectedLogId = selectedLog?.id ?? null;
  const { data: selectedLogDetail } = useQuery({
    queryKey: ["/api/audit-log/detail", activeCompanyId, selectedLogId],
    enabled: activeCompanyId !== null && selectedLogId !== null,
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/audit-log?detailId=${selectedLogId}`);
      if (!response.ok) throw new Error("Failed to load activity details");
      return response.json();
    },
  });

  const activityLoading = isCompanyLoading || activeCompanyId === null || isLoading;
  const rawAuditLogs: SettingsAuditLogRow[] = useMemo(() => data?.logs || [], [data?.logs]);

  // Defence in depth: the API is company-scoped, but the browser also rejects
  // any unexpected row so a stale cache or future backend regression cannot
  // display another company's activity.
  const auditLogs = useMemo(
    () => rawAuditLogs.filter((log) => Number(log.companyId) === activeCompanyId),
    [rawAuditLogs, activeCompanyId]
  );

  const totalPages = data?.totalPages || 1;
  const total = data?.total ?? null;
  const knownModules: string[] = data?.knownModules || [];
  const groupedDays = useMemo(() => groupLogsByDay(auditLogs), [auditLogs]);

  const isDirty =
    filterAction !== defaultActions ||
    filterModule !== "" ||
    filterSearch !== "" ||
    filterDateFrom !== "" ||
    filterDateTo !== "";

  const handleReset = () => {
    setFilterAction(defaultActions);
    setFilterModule("");
    setFilterSearch("");
    setDebouncedSearch("");
    setFilterDateFrom("");
    setFilterDateTo("");
    setPage(1);
  };

  const errorStatus = (error as unknown as (Error | null) & { status: unknown })?.status;
  const errorCode = (error as unknown as (Error | null) & { code: unknown })?.code;
  const isPermissionError =
    errorStatus === 403 ||
    String(error?.message || "")
      .toLowerCase()
      .includes("access denied") ||
    String(error?.message || "")
      .toLowerCase()
      .includes("permission");
  const isCompanyError = errorStatus === 409 || errorCode === "AUDIT_COMPANY_REQUIRED";

  return (
    <div className="space-y-4">
      {showHeading && (
        <div>
          <h3 className="text-base font-semibold">{context === "daybook" ? "Edits & Activity" : "Activity History"}</h3>
          <p className="text-xs text-muted-foreground">
            {selectedCompany ? `Showing activity for ${selectedCompany.name} only.` : "Selecting company…"}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search user, module, action, record…"
            value={filterSearch}
            onChange={(event) => handleSearchChange(event.target.value)}
            className="pl-9 h-8 text-sm"
            disabled={activityLoading}
          />
        </div>

        <Select value={filterAction} onValueChange={setFilterAction} disabled={activityLoading}>
          <SelectTrigger className="h-8 w-44 text-sm">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            {ACTION_FILTER_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filterModule || "all"}
          onValueChange={(value) => setFilterModule(value === "all" ? "" : value)}
          disabled={activityLoading}
        >
          <SelectTrigger className="h-8 w-36 text-sm">
            <SelectValue placeholder="Module" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All modules</SelectItem>
            {knownModules.map((moduleName) => (
              <SelectItem key={moduleName} value={moduleName}>
                {tableShortName(moduleName)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={filterDateFrom}
          onChange={(event) => setFilterDateFrom(event.target.value)}
          className="h-8 w-36 text-sm"
          title="From date"
          disabled={activityLoading}
        />
        <Input
          type="date"
          value={filterDateTo}
          onChange={(event) => setFilterDateTo(event.target.value)}
          className="h-8 w-36 text-sm"
          title="To date"
          disabled={activityLoading}
        />

        {isDirty && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-muted-foreground"
            onClick={handleReset}
            disabled={activityLoading}
          >
            <X className="h-3 w-3 mr-1" /> Reset
          </Button>
        )}

        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => refetch()}
          disabled={activityLoading || isFetching}
          title="Refresh"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {selectedCompany && (
        <p className="text-xs text-muted-foreground">
          Company: <span className="font-medium text-foreground">{selectedCompany.name}</span>
          {selectedCompany.code ? ` (${selectedCompany.code})` : ""}
          {total !== null && !activityLoading
            ? total === 0
              ? " — no results"
              : ` — ${total.toLocaleString()} record${total !== 1 ? "s" : ""}${
                  totalPages > 1 ? ` — page ${page} of ${totalPages}` : ""
                }`
            : ""}
        </p>
      )}

      {activityLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((item) => (
            <Skeleton key={item} className="h-12 w-full" />
          ))}
        </div>
      ) : error ? (
        isPermissionError ? (
          <div className="flex flex-col items-center gap-3 p-8 text-muted-foreground border rounded-md bg-muted/20">
            <p className="text-sm font-medium">You do not have permission to view activity history.</p>
            <p className="text-xs">Contact your administrator to request access.</p>
          </div>
        ) : isCompanyError ? (
          <div className="flex flex-col items-center gap-3 p-8 text-muted-foreground border rounded-md bg-muted/20">
            <p className="text-sm font-medium">The selected company is still being confirmed.</p>
            <p className="text-xs">Select the company again, then refresh this page.</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 p-6 text-destructive bg-destructive/10 rounded-md">
            <p className="text-sm font-medium">Error loading activity history.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        )
      ) : auditLogs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground border rounded-md bg-muted/20">
          <p className="text-sm font-medium">No activity found for {selectedCompany?.name || "this company"}</p>
          <p className="text-xs mt-1">Try adjusting the filters or date range.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[160px] whitespace-nowrap">Date & Time</TableHead>
                <TableHead className="w-[130px]">User</TableHead>
                <TableHead className="w-[125px]">Action</TableHead>
                <TableHead className="w-[150px]">Module</TableHead>
                <TableHead className="w-[180px]">Record</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupedDays.map(({ dateKey, dateLabel, logs }) => (
                <Fragment key={`day-${dateKey}`}>
                  <TableRow className="bg-muted/60 hover:bg-muted/60 pointer-events-none select-none">
                    <TableCell colSpan={6} className="py-2 px-4 font-semibold text-sm text-foreground">
                      <span className="flex items-center gap-2">
                        <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        {dateLabel}
                      </span>
                    </TableCell>
                  </TableRow>

                  {logs.map((log) => (
                    <TableRow
                      key={log.id}
                      className="group cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => setSelectedLog(log)}
                    >
                      <TableCell className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                        {fmtDate(log.createdAt)}
                      </TableCell>
                      <TableCell className="text-sm font-medium truncate max-w-[130px]">
                        {log.username || (log.userId ? `User #${String(log.userId).slice(0, 8)}` : "Unknown")}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={actionBadgeVariant(log.action)}
                          className="text-[10px] min-h-5 max-w-[120px] whitespace-normal break-words leading-tight"
                        >
                          {actionLabel(log.action)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {log.moduleLabel || tableShortName(log.tableName)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[180px]">
                        <span className="truncate block" title={getRecordLabel(log)}>
                          {getRecordLabel(log)}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[420px]">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="truncate min-w-0" title={log.changeSummary || getDetailsSentence(log)}>
                            {log.changeSummary || getDetailsSentence(log)}
                          </span>
                          <ExternalLink className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-50" />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {!activityLoading && !error && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page === 1 || isFetching}
          >
            <ChevronLeft className="h-4 w-4 mr-1" /> Previous
          </Button>
          <span className="text-sm font-medium px-4">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={page === totalPages || isFetching}
          >
            Next <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      )}

      {selectedLog && <AuditLogDialog log={selectedLogDetail || selectedLog} onClose={() => setSelectedLog(null)} />}
    </div>
  );
}
