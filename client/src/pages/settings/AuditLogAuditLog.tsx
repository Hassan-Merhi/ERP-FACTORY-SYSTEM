// Extracted from ./AuditLog.tsx to keep that module under the source-size cap.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, RefreshCw, X } from "lucide-react";
import { PaginationBar } from "@/components/PaginationBar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/page-state";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { ErpMobileRecordCard, ErpMobileRecordGroup, ErpMobileRecordList } from "@/components/ui/erp-mobile-records";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { apiRequest } from "@/lib/queryClient";
import { actionBadgeVariant, actionLabel, tableShortName } from "./AuditLogUtils";
import { AuditLogDialog } from "./AuditLogDialog";
import type { SettingsAuditLogRow } from "./settingsTypes";
import { ACTION_FILTER_OPTIONS, groupLogsByDay, type AuditLogProps } from "./AuditLogGroupLogsByDay";

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
  // ERP phones read activity as day-grouped cards; the six-column table needs a desktop width.
  const appMode = useAppMode();
  const erpPhone = useErpPhoneLayout() && appMode === "erp";

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

      {(() => {
        // One set of filter controls: an inline toolbar on tablet/desktop (and Factory), and the
        // shared filter sheet on ERP phones, where search stays visible beside the Filters button.
        const inline = !erpPhone;
        const searchControl = (
          <SearchField
            value={filterSearch}
            onValueChange={handleSearchChange}
            placeholder="Search user, module or action…"
            wrapperClassName={inline ? "flex-1 min-w-[180px]" : undefined}
            className={inline ? "h-8 text-sm" : "text-sm"}
            disabled={activityLoading}
            data-testid="input-activity-search"
          />
        );
        // The phone sheet labels the date fields; the inline toolbar keeps its compact inputs.
        const dateField = (label: string, input: React.ReactNode) =>
          inline ? (
            input
          ) : (
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              {label}
              {input}
            </label>
          );
        const filterControls = (
          <>
            <Select value={filterAction} onValueChange={setFilterAction} disabled={activityLoading}>
              <SelectTrigger className={inline ? "h-8 w-44 text-sm" : "text-sm"}>
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
              <SelectTrigger className={inline ? "h-8 w-36 text-sm" : "text-sm"}>
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

            {dateField(
              "From date",
              <Input
                type="date"
                value={filterDateFrom}
                onChange={(event) => setFilterDateFrom(event.target.value)}
                className={inline ? "h-8 w-36 text-sm" : "text-sm"}
                title="From date"
                aria-label="From date"
                disabled={activityLoading}
              />
            )}
            {dateField(
              "To date",
              <Input
                type="date"
                value={filterDateTo}
                onChange={(event) => setFilterDateTo(event.target.value)}
                className={inline ? "h-8 w-36 text-sm" : "text-sm"}
                title="To date"
                aria-label="To date"
                disabled={activityLoading}
              />
            )}
          </>
        );

        if (inline) {
          return (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card/70 p-3 shadow-xs">
              {searchControl}
              {filterControls}

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
          );
        }

        const activeFilterCount =
          (filterAction !== defaultActions ? 1 : 0) +
          (filterModule ? 1 : 0) +
          (filterDateFrom ? 1 : 0) +
          (filterDateTo ? 1 : 0);
        return (
          <ErpMobileFilters
            label="Activity filters"
            quick={searchControl}
            activeCount={activeFilterCount}
            onClear={handleReset}
            canClear={isDirty}
            data-testid="activity-filters"
          >
            {filterControls}
          </ErpMobileFilters>
        );
      })()}

      {selectedCompany && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">{selectedCompany.name}</span>
            {selectedCompany.code ? ` · ${selectedCompany.code}` : ""}
          </span>
          {total !== null && !activityLoading && (
            <span className="tabular-nums">
              {total === 0
                ? "No results"
                : `${total.toLocaleString()} activit${total === 1 ? "y" : "ies"}${
                    totalPages > 1 ? ` · Page ${page} of ${totalPages}` : ""
                  }`}
            </span>
          )}
        </div>
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
        <EmptyState
          title={`No activity found for ${selectedCompany?.name || "this company"}`}
          description="Try adjusting the filters or date range."
          className="py-12"
        />
      ) : erpPhone ? (
        <div className="space-y-3" data-testid="activity-cards">
          {groupedDays.map(({ dateKey, dateLabel, logs }) => (
            <ErpMobileRecordGroup key={`day-${dateKey}`} label={dateLabel} meta={logs.length}>
              <ErpMobileRecordList>
                {logs.map((log) => {
                  const time = new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  const moduleName = log.moduleLabel || tableShortName(log.tableName);
                  return (
                    <ErpMobileRecordCard
                      key={log.id}
                      data-testid={`activity-card-${log.id}`}
                      title={moduleName}
                      subtitle={
                        <>
                          <span className="font-mono tabular-nums">{time}</span>
                          {" · "}
                          {log.username || (log.userId ? `User #${String(log.userId).slice(0, 8)}` : "Unknown")}
                        </>
                      }
                      badges={
                        <Badge variant={actionBadgeVariant(log.action)} className="text-[11px] leading-tight">
                          {actionLabel(log.action)}
                        </Badge>
                      }
                      fields={[]}
                      onOpen={() => setSelectedLog(log)}
                      openLabel={`Open activity: ${actionLabel(log.action)} ${moduleName}`}
                    />
                  );
                })}
              </ErpMobileRecordList>
            </ErpMobileRecordGroup>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="w-[150px] h-10 pl-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Time
                </TableHead>
                <TableHead className="w-[220px] h-10 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  User
                </TableHead>
                <TableHead className="w-[170px] h-10 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Action
                </TableHead>
                <TableHead className="h-10 pr-5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Module
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupedDays.map(({ dateKey, dateLabel, logs }) => (
                <Fragment key={`day-${dateKey}`}>
                  <TableRow className="bg-muted/20 hover:bg-muted/20 pointer-events-none select-none border-y">
                    <TableCell colSpan={4} className="py-2.5 px-5 font-semibold text-sm text-foreground">
                      <span className="flex items-center gap-2">
                        <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        {dateLabel}
                        <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                          {logs.length} {logs.length === 1 ? "activity" : "activities"}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>

                  {logs.map((log) => (
                    <TableRow
                      key={log.id}
                      className="cursor-pointer border-b last:border-b-0 hover:bg-muted/30 transition-colors"
                      onClick={() => setSelectedLog(log)}
                      title="Open activity"
                    >
                      <TableCell className="py-3 pl-5 text-xs font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </TableCell>
                      <TableCell className="py-3 text-sm font-medium">
                        {log.username || (log.userId ? `User #${String(log.userId).slice(0, 8)}` : "Unknown")}
                      </TableCell>
                      <TableCell className="py-3">
                        <Badge
                          variant={actionBadgeVariant(log.action)}
                          className="text-[11px] min-h-5 max-w-[140px] whitespace-normal wrap-break-word leading-tight"
                        >
                          {actionLabel(log.action)}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-3 pr-5 text-sm text-muted-foreground">
                        {log.moduleLabel || tableShortName(log.tableName)}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {!activityLoading && !error && (
        <PaginationBar
          page={page}
          totalPages={totalPages}
          total={total ?? 0}
          pageSize={50}
          onPageChange={setPage}
          noun="items"
        />
      )}

      {selectedLog && <AuditLogDialog log={selectedLogDetail || selectedLog} onClose={() => setSelectedLog(null)} />}
    </div>
  );
}
