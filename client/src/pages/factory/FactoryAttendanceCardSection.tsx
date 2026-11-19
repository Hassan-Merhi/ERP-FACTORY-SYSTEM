// Extracted from ./FactoryAttendance.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarDays, Loader2, Save, Search } from "lucide-react";
import { formatDate } from "./factoryattendance/utils";
import { attendanceToday } from "./factoryattendance/attendanceEditPolicy";
import { useFactoryAttendanceState } from "./useFactoryAttendanceStatePart2";
import { SearchField } from "@/components/ui/search-field";
import { FactoryAttendanceCardSectionContent } from "./FactoryAttendanceCardSectionContent";

export function FactoryAttendanceCardSection({
  attendanceMap,
  attendancePct,
  counts,
  handleSave,
  isLoading,
  notesMap,
  recordChanges,
  saveMutation,
  selectedDate,
  setNotes,
  setStatus,
  setStatusFilter,
  setWorkerSearch,
  statusFilter,
  visibleWorkers,
  workerSearch,
  workers,
}: Pick<
  ReturnType<typeof useFactoryAttendanceState>,
  | "attendanceMap"
  | "attendancePct"
  | "counts"
  | "handleSave"
  | "isLoading"
  | "notesMap"
  | "recordChanges"
  | "saveMutation"
  | "selectedDate"
  | "setNotes"
  | "setStatus"
  | "setStatusFilter"
  | "setWorkerSearch"
  | "statusFilter"
  | "visibleWorkers"
  | "workerSearch"
  | "workers"
>) {
  return (
    <Card className="attendance-register overflow-hidden border-border/70 bg-card/75 shadow-none">
      <CardHeader className="attendance-register-header gap-3 border-b border-border/60 bg-muted/15 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarDays className="h-4 w-4 text-primary" />
              Workers
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">{formatDate(selectedDate)}</p>
          </div>
          {workers.length > 0 && (
            <div className="flex items-center gap-3">
              <div className="hidden text-right sm:block">
                <p className="text-sm font-semibold tabular-nums">{attendancePct}%</p>
                <p className="text-[11px] text-muted-foreground">present today</p>
              </div>
              <Badge variant="outline" className="rounded-full bg-background/60 px-3 py-1">
                {workers.length} worker{workers.length !== 1 ? "s" : ""}
              </Badge>
            </div>
          )}
        </div>

        {workers.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <SearchField
              value={workerSearch}
              onValueChange={setWorkerSearch}
              placeholder="Search worker, code, position…"
              wrapperClassName="w-full sm:max-w-sm"
              className="h-9 rounded-xl bg-background/70"
              data-testid="input-attendance-worker-search"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
                <SelectTrigger
                  className="h-9 w-[145px] rounded-xl bg-background/70"
                  data-testid="select-attendance-status-filter"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="present">Present</SelectItem>
                  <SelectItem value="absent">Absent</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-[11px] text-muted-foreground">
                Showing {visibleWorkers.length} of {workers.length}
              </span>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : workers.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No active workers found for this company.
          </div>
        ) : visibleWorkers.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
            <Search className="mb-2 h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-medium">No workers match these filters</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 rounded-xl"
              onClick={() => {
                setWorkerSearch("");
                setStatusFilter("all");
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : (
          <FactoryAttendanceCardSectionContent
            attendanceMap={attendanceMap}
            notesMap={notesMap}
            setNotes={setNotes}
            setStatus={setStatus}
            visibleWorkers={visibleWorkers}
            workers={workers}
          />
        )}

        {workers.length > 0 && (
          <div className="attendance-save-bar sticky bottom-0 z-20 flex flex-col gap-2 border-t border-border/70 bg-background/95 px-4 py-3 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                <strong className="text-foreground">{counts.present}</strong> present
              </span>
              <span>
                <strong className="text-foreground">{counts.absent}</strong> absent
              </span>
              {counts.other > 0 && (
                <span>
                  <strong className="text-foreground">{counts.other}</strong> other
                </span>
              )}
              <span>{attendancePct}% attendance</span>
            </div>
            <Button
              size="sm"
              className="rounded-xl shadow-xs sm:min-w-36"
              data-testid="button-save-attendance-sticky"
              onClick={handleSave}
              disabled={saveMutation.isPending || selectedDate > attendanceToday() || !recordChanges.allowed}
              title={recordChanges.reason ?? undefined}
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-4 w-4" />
              )}
              {saveMutation.isPending ? "Saving…" : "Save Attendance"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
