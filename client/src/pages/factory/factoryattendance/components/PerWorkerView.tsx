import type { ClientErrorLike } from "@/lib/clientError";
/**
 * PerWorkerView — extracted sub-component.
 *
 * Extracted from FactoryAttendance.tsx during the Phase 4 god-file split.
 */
import {useState, useEffect} from "react";
import {useQuery, useMutation} from "@tanstack/react-query";
import {queryClient, apiRequest} from "@/lib/queryClient";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {Badge} from "@/components/ui/badge";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Checkbox} from "@/components/ui/checkbox";
import {Skeleton} from "@/components/ui/skeleton";
import {Popover, PopoverContent, PopoverTrigger} from "@/components/ui/popover";
import {Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList} from "@/components/ui/command";
import {useToast} from "@/hooks/use-toast";
import {CalendarDays, CheckCircle, XCircle, Save, UserCheck, UserX, User, ChevronsUpDown, Check} from "lucide-react";

import type {AttendanceRecord, WorkerRow} from "../types";
import {generateDateRange, todayStr} from "../utils";
import {SummaryCard} from "./SummaryCard";

export function PerWorkerView() {
  const { toast } = useToast();
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>("");
  const [workerComboOpen, setWorkerComboOpen] = useState(false);
  const [startDate, setStartDate] = useState<string>(todayStr());
  const [endDate, setEndDate] = useState<string>(todayStr());
  const [checkedDates, setCheckedDates] = useState<Record<string, boolean>>({});

  const { data: workersList, isLoading: loadingWorkers } = useQuery<WorkerRow[]>({
    queryKey: ["/api/factory/workers?active=true"],
  });

  const workerIdNum = selectedWorkerId ? parseInt(selectedWorkerId) : null;

  const { data: attendanceRecords, isLoading: loadingAttendance } = useQuery<AttendanceRecord[]>({
    queryKey: ["/api/factory/attendance/worker", workerIdNum, startDate, endDate],
    queryFn: async () => {
      if (!workerIdNum) return [];
      const res = await fetch(
        `/api/factory/attendance/worker/${workerIdNum}?startDate=${startDate}&endDate=${endDate}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to load attendance");
      return res.json();
    },
    enabled: !!workerIdNum && !!startDate && !!endDate,
  });

  // Pre-fill checkboxes from DB whenever records or date range changes.
  useEffect(() => {
    const dates = generateDateRange(startDate, endDate);
    const next: Record<string, boolean> = {};
    for (const d of dates) {
      // Sunday (getDay() === 0) defaults to Present; all other days default to Absent
      const isSunday = new Date(d + "T00:00:00").getDay() === 0;
      next[d] = isSunday;
    }
    if (attendanceRecords) {
      for (const r of attendanceRecords) {
        // Any status other than Absent counts as "present" (checked):
        // Present, Late, Half Day, Leave all = checked
        next[r.attendanceDate] = r.status !== "Absent";
      }
    }
    setCheckedDates(next);
  }, [attendanceRecords, startDate, endDate]);

  const dates = generateDateRange(startDate, endDate);
  const presentCount = Object.values(checkedDates).filter(Boolean).length;
  const absentCount = dates.length - presentCount;

  const toggleDate = (date: string) => {
    setCheckedDates((prev) => ({ ...prev, [date]: !prev[date] }));
  };

  const selectAll = () => {
    const next: Record<string, boolean> = {};
    for (const d of dates) next[d] = true;
    setCheckedDates(next);
  };

  const deselectAll = () => {
    const next: Record<string, boolean> = {};
    for (const d of dates) next[d] = false;
    setCheckedDates(next);
  };

  const saveMutation = useMutation({
    mutationFn: (records: unknown[]) => apiRequest("POST", "/api/factory/attendance/bulk", { records }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/factory/attendance/worker", workerIdNum, startDate, endDate],
      });
      toast({ title: "Attendance saved", description: `${dates.length} days saved for this worker.` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    if (!workerIdNum) return;
    // Build a map of existing DB statuses so we can preserve granular statuses
    // (Late, Half Day, Leave) for dates that are checked but not newly toggled.
    const existingStatusMap: Record<string, string> = {};
    if (attendanceRecords) {
      for (const r of attendanceRecords) {
        existingStatusMap[r.attendanceDate] = r.status;
      }
    }
    const records = dates.map((d) => {
      if (checkedDates[d]) {
        // Preserve existing granular status (Late, Half Day, Leave) if the date
        // is checked; fall back to "Present" for new/previously-absent dates.
        const existing = existingStatusMap[d];
        const status = existing && existing !== "Absent" ? existing : "Present";
        return { workerId: workerIdNum, attendanceDate: d, status };
      }
      return { workerId: workerIdNum, attendanceDate: d, status: "Absent" };
    });
    saveMutation.mutate(records);
  };

  const selectedWorker = (workersList ?? []).find((w) => w.id === workerIdNum);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <Card className="overflow-hidden border-border/70 bg-card/75 shadow-none">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1 min-w-[200px]">
              <Label className="text-xs text-muted-foreground">Worker</Label>
              <Popover open={workerComboOpen} onOpenChange={setWorkerComboOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={workerComboOpen}
                    data-testid="select-worker"
                    className="w-56 justify-between rounded-xl bg-background/70 font-normal"
                  >
                    <span className="truncate" dir="auto">
                      {selectedWorker
                        ? `${selectedWorker.fullName}${selectedWorker.employeeCode ? ` (${selectedWorker.employeeCode})` : ""}`
                        : loadingWorkers
                          ? "Loading…"
                          : "Select worker"}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search worker…" data-testid="input-worker-search" />
                    <CommandList>
                      <CommandEmpty>No workers found.</CommandEmpty>
                      <CommandGroup>
                        {(workersList ?? []).map((w) => (
                          <CommandItem
                            key={w.id}
                            value={`${w.fullName} ${w.employeeCode ?? ""}`}
                            onSelect={() => {
                              setSelectedWorkerId(String(w.id));
                              setWorkerComboOpen(false);
                            }}
                          >
                            <Check
                              className={`mr-2 h-4 w-4 shrink-0 ${selectedWorkerId === String(w.id) ? "opacity-100" : "opacity-0"}`}
                            />
                            <span dir="auto" className="truncate">
                              {w.fullName}
                              {w.employeeCode ? ` (${w.employeeCode})` : ""}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input
                type="date"
                data-testid="input-start-date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-40 rounded-xl bg-background/70"
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input
                type="date"
                data-testid="input-end-date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-40 rounded-xl bg-background/70"
              />
            </div>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="default"
                data-testid="button-select-all"
                onClick={selectAll}
                disabled={!workerIdNum || dates.length === 0}
              >
                <UserCheck className="h-4 w-4 mr-1" />
                Select All
              </Button>
              <Button
                variant="outline"
                size="default"
                data-testid="button-deselect-all"
                onClick={deselectAll}
                disabled={!workerIdNum || dates.length === 0}
              >
                <UserX className="h-4 w-4 mr-1" />
                Deselect All
              </Button>
              <Button
                size="default"
                data-testid="button-save-per-worker"
                onClick={handleSave}
                disabled={!workerIdNum || dates.length === 0 || saveMutation.isPending}
              >
                <Save className="h-4 w-4 mr-1" />
                {saveMutation.isPending ? "Saving…" : "Save Attendance"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary */}
      {workerIdNum && dates.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <SummaryCard
            icon={<CalendarDays className="h-4 w-4" />}
            label="Days in Range"
            value={dates.length}
            color="text-foreground"
            testId="stat-pw-total"
            modern
          />
          <SummaryCard
            icon={<CheckCircle className="h-4 w-4" />}
            label="Present"
            value={presentCount}
            color="text-green-600 dark:text-green-400"
            testId="stat-pw-present"
            modern
          />
          <SummaryCard
            icon={<XCircle className="h-4 w-4" />}
            label="Absent"
            value={absentCount}
            color="text-red-600 dark:text-red-400"
            testId="stat-pw-absent"
            modern
          />
        </div>
      )}

      {/* Date checkbox table */}
      <Card className="overflow-hidden border-border/70 bg-card/75 shadow-none">
        <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/60 bg-muted/15 px-4 py-4 sm:px-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <User className="h-4 w-4" />
            {selectedWorker ? selectedWorker.fullName : "Select a worker"}
            {selectedWorker?.employeeCode && <Badge variant="secondary">{selectedWorker.employeeCode}</Badge>}
          </CardTitle>
          {workerIdNum && dates.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {startDate} to {endDate}
            </span>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {!workerIdNum ? (
            <div className="text-center text-muted-foreground py-12 text-sm">
              Select a worker above to mark their attendance.
            </div>
          ) : loadingAttendance ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-md" />
              ))}
            </div>
          ) : dates.length === 0 ? (
            <div className="text-center text-muted-foreground py-12 text-sm">No dates in the selected range.</div>
          ) : (
            <div className="table-responsive">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-30 bg-muted/30 backdrop-blur">
                  <tr className="border-b border-border/60">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground w-8">#</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Date</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground w-24">Day</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground w-28">Present</th>
                  </tr>
                </thead>
                <tbody>
                  {dates.map((date, idx) => {
                    const dayName = new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long" });
                    const isChecked = checkedDates[date] ?? false;
                    const isFriday = new Date(date + "T00:00:00").getDay() === 5;
                    const isSaturday = new Date(date + "T00:00:00").getDay() === 6;
                    const isSunday = new Date(date + "T00:00:00").getDay() === 0;
                    return (
                      <tr
                        key={date}
                        data-testid={`row-date-${date}`}
                        className={`cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-muted/20 ${isFriday || isSaturday ? "bg-muted/15" : isSunday ? "bg-blue-50/30 dark:bg-blue-950/15" : ""}`}
                        onClick={() => toggleDate(date)}
                      >
                        <td className="px-4 py-3 text-muted-foreground">{idx + 1}</td>
                        <td className="px-4 py-3 font-medium">
                          {new Date(date + "T00:00:00").toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </td>
                        <td
                          className={`px-4 py-3 text-sm ${isFriday || isSaturday ? "text-muted-foreground italic" : isSunday ? "text-blue-600 dark:text-blue-400 font-medium" : "text-muted-foreground"}`}
                        >
                          {dayName}
                          {isSunday ? " *" : ""}
                        </td>
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <Checkbox
                              data-testid={`checkbox-date-${date}`}
                              checked={isChecked}
                              onCheckedChange={() => toggleDate(date)}
                            />
                            <span
                              className={`text-xs font-medium ${isChecked ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}
                            >
                              {isChecked ? "Present" : "Absent"}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Summary card ──────────────────────────────────────────────────────────────
