import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import {
  CalendarDays,
  CheckCircle,
  XCircle,
  RotateCcw,
  Save,
  Users,
  UserCheck,
  UserX,
  Clock,
  User,
  ChevronsUpDown,
  Check,
} from "lucide-react";

type AttendanceStatus = "Present" | "Absent" | "Late" | "Half Day" | "Leave";
type ViewMode = "daily" | "perEmployee";

interface EmployeeAttendanceBulkRecord {
  employeeId: number;
  attendanceDate: string;
  status: string;
  notes?: string;
}

interface EmpRow {
  id: number;
  firstName: string;
  lastName: string;
  code: string | null;
  department: string | null;
}

interface AttRecord {
  id: number;
  employeeId: number;
  attendanceDate: string;
  status: string;
  notes: string | null;
}

const STATUS_OPTIONS: AttendanceStatus[] = ["Present", "Absent", "Late", "Half Day", "Leave"];

const STATUS_COLORS: Record<string, string> = {
  Present: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  Absent: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  Late: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  "Half Day": "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  Leave: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
};

function localDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayStr() {
  return localDateStr(new Date());
}
function _currentMonthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function _currentMonthEnd() {
  const d = new Date();
  return localDateStr(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}
function generateDateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  while (cur <= endDate) {
    dates.push(localDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}
function formatDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function SummaryCard({
  icon,
  label,
  value,
  color,
  testId,
}: {
  icon: React.JSX.Element;
  label: string;
  value: number;
  color: string;
  testId: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className={`text-2xl font-bold ${color}`} data-testid={testId}>
              {value}
            </p>
          </div>
          <div className={`opacity-60 ${color}`}>{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function FactoryEmployeeAttendanceTab() {
  const { toast } = useToast();
  const [mode, setMode] = useState<ViewMode>("daily");

  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [shift, setShift] = useState("");
  const [attendanceMap, setAttendanceMap] = useState<Record<number, AttendanceStatus>>({});
  const [notesMap, setNotesMap] = useState<Record<number, string>>({});

  const { data, isLoading } = useQuery<{ employees: EmpRow[]; attendance: AttRecord[] }>({
    queryKey: ["/api/factory/employee-attendance", selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/factory/employee-attendance?date=${selectedDate}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  useEffect(() => {
    if (!data) return;
    const newMap: Record<number, AttendanceStatus> = {};
    const newNotes: Record<number, string> = {};
    for (const e of data.employees) newMap[e.id] = "Present";
    for (const a of data.attendance) {
      newMap[a.employeeId] = a.status as AttendanceStatus;
      newNotes[a.employeeId] = a.notes || "";
    }
    setAttendanceMap(newMap);
    setNotesMap(newNotes);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (records: EmployeeAttendanceBulkRecord[]) =>
      apiRequest("POST", "/api/factory/employee-attendance/bulk", { records }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employee-attendance", selectedDate] });
      toast({ title: "Attendance saved", description: `Saved for ${selectedDate}` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = useCallback(() => {
    if (!data?.employees.length) return;
    const records = data.employees.map((e) => ({
      employeeId: e.id,
      attendanceDate: selectedDate,
      status: attendanceMap[e.id] ?? "Present",
      notes: notesMap[e.id] || undefined,
    }));
    saveMutation.mutate(records);
  }, [data, selectedDate, attendanceMap, notesMap, saveMutation]);

  const markAll = (status: AttendanceStatus) => {
    if (!data?.employees) return;
    const next: Record<number, AttendanceStatus> = {};
    for (const e of data.employees) next[e.id] = status;
    setAttendanceMap(next);
  };

  const reset = () => {
    if (!data?.employees) return;
    const next: Record<number, AttendanceStatus> = {};
    for (const e of data.employees) next[e.id] = "Present";
    setAttendanceMap(next);
    setNotesMap({});
  };

  const emps = data?.employees ?? [];
  const counts = {
    total: emps.length,
    present: emps.filter((e) => (attendanceMap[e.id] ?? "Present") === "Present").length,
    absent: emps.filter((e) => attendanceMap[e.id] === "Absent").length,
    other: emps.filter((e) => {
      const s = attendanceMap[e.id] ?? "Present";
      return s !== "Present" && s !== "Absent";
    }).length,
  };

  return (
    <div className="space-y-4 p-1">
      <div className="flex gap-2">
        <Button
          variant={mode === "daily" ? "default" : "outline"}
          onClick={() => setMode("daily")}
          data-testid="button-mode-daily"
        >
          <CalendarDays className="h-4 w-4 mr-2" />
          Daily View
        </Button>
        <Button
          variant={mode === "perEmployee" ? "default" : "outline"}
          onClick={() => setMode("perEmployee")}
          data-testid="button-mode-per-employee"
        >
          <User className="h-4 w-4 mr-2" />
          Per Employee
        </Button>
      </div>

      {mode === "perEmployee" ? (
        <PerEmployeeView />
      ) : (
        <>
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Attendance Date</Label>
                  <Input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="w-44"
                    data-testid="input-attendance-date"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Shift (optional)</Label>
                  <Input
                    placeholder="e.g. Morning"
                    value={shift}
                    onChange={(e) => setShift(e.target.value)}
                    className="w-36"
                    data-testid="input-shift"
                  />
                </div>
                <div className="flex flex-wrap gap-2 ml-auto items-center">
                  <Button
                    variant="outline"
                    onClick={() => markAll("Present")}
                    disabled={!emps.length}
                    data-testid="button-mark-all-present"
                  >
                    <UserCheck className="h-4 w-4 mr-1" /> Mark All Present
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => markAll("Absent")}
                    disabled={!emps.length}
                    data-testid="button-mark-all-absent"
                  >
                    <UserX className="h-4 w-4 mr-1" /> Mark All Absent
                  </Button>
                  <Button variant="ghost" onClick={reset} disabled={!emps.length} data-testid="button-reset">
                    <RotateCcw className="h-4 w-4 mr-1" /> Reset
                  </Button>
                  <Button
                    onClick={handleSave}
                    disabled={!emps.length || saveMutation.isPending}
                    data-testid="button-save-attendance"
                  >
                    <Save className="h-4 w-4 mr-1" />
                    {saveMutation.isPending ? "Saving…" : "Save Attendance"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {emps.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryCard
                icon={<Users className="h-4 w-4" />}
                label="Total"
                value={counts.total}
                color="text-foreground"
                testId="stat-total"
              />
              <SummaryCard
                icon={<CheckCircle className="h-4 w-4" />}
                label="Present"
                value={counts.present}
                color="text-green-600 dark:text-green-400"
                testId="stat-present"
              />
              <SummaryCard
                icon={<XCircle className="h-4 w-4" />}
                label="Absent"
                value={counts.absent}
                color="text-red-600 dark:text-red-400"
                testId="stat-absent"
              />
              <SummaryCard
                icon={<Clock className="h-4 w-4" />}
                label="Other"
                value={counts.other}
                color="text-amber-600 dark:text-amber-400"
                testId="stat-other"
              />
            </div>
          )}

          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarDays className="h-4 w-4" />
                Employees — {formatDate(selectedDate)}
                {shift && <Badge variant="secondary">{shift}</Badge>}
              </CardTitle>
              {emps.length > 0 && (
                <span className="text-sm text-muted-foreground">
                  {emps.length} employee{emps.length !== 1 ? "s" : ""}
                </span>
              )}
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full rounded-md" />
                  ))}
                </div>
              ) : emps.length === 0 ? (
                <div className="text-center text-muted-foreground py-12 text-sm">
                  <User className="h-10 w-10 mx-auto mb-3 opacity-40" />
                  No active employees found.
                </div>
              ) : (
                <>
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 z-30">
                        <tr className="border-b bg-muted/40">
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground w-8">#</th>
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground">Employee</th>
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground">Department</th>
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground w-44">Status</th>
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {emps.map((emp, idx) => {
                          const status = attendanceMap[emp.id] ?? "Present";
                          return (
                            <tr
                              key={emp.id}
                              className="border-b last:border-0 hover-elevate"
                              data-testid={`row-employee-${emp.id}`}
                            >
                              <td className="px-4 py-2 text-muted-foreground">{idx + 1}</td>
                              <td className="px-4 py-2 font-medium" data-testid={`text-employee-name-${emp.id}`}>
                                {emp.firstName} {emp.lastName}
                                {emp.code && <span className="text-xs text-muted-foreground ml-1">({emp.code})</span>}
                              </td>
                              <td className="px-4 py-2 text-sm text-muted-foreground">{emp.department || "—"}</td>
                              <td className="px-4 py-2">
                                <Select
                                  value={status}
                                  onValueChange={(v) =>
                                    setAttendanceMap((p) => ({ ...p, [emp.id]: v as AttendanceStatus }))
                                  }
                                >
                                  <SelectTrigger
                                    data-testid={`select-status-${emp.id}`}
                                    className={`h-8 text-xs font-medium ${STATUS_COLORS[status] ?? ""}`}
                                  >
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {STATUS_OPTIONS.map((s) => (
                                      <SelectItem key={s} value={s}>
                                        {s}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </td>
                              <td className="px-4 py-2">
                                <Input
                                  placeholder="Optional notes"
                                  value={notesMap[emp.id] ?? ""}
                                  onChange={(e) => setNotesMap((p) => ({ ...p, [emp.id]: e.target.value }))}
                                  className="h-8 text-xs"
                                  data-testid={`input-notes-${emp.id}`}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="sm:hidden space-y-2 p-3">
                    {emps.map((emp, idx) => {
                      const status = attendanceMap[emp.id] ?? "Present";
                      return (
                        <div
                          key={emp.id}
                          className="border rounded-md p-3 space-y-2"
                          data-testid={`card-employee-${emp.id}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-medium text-sm">
                              {emp.firstName} {emp.lastName}
                            </p>
                            <span className="text-xs text-muted-foreground shrink-0">{idx + 1}</span>
                          </div>
                          <Select
                            value={status}
                            onValueChange={(v) => setAttendanceMap((p) => ({ ...p, [emp.id]: v as AttendanceStatus }))}
                          >
                            <SelectTrigger className={`h-9 text-sm font-medium ${STATUS_COLORS[status] ?? ""}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {STATUS_OPTIONS.map((s) => (
                                <SelectItem key={s} value={s}>
                                  {s}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Input
                            placeholder="Notes (optional)"
                            value={notesMap[emp.id] ?? ""}
                            onChange={(e) => setNotesMap((p) => ({ ...p, [emp.id]: e.target.value }))}
                            className="h-8 text-xs"
                          />
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function PerEmployeeView() {
  const { toast } = useToast();
  const [selectedEmpId, setSelectedEmpId] = useState<string>("");
  const [empComboOpen, setEmpComboOpen] = useState(false);
  const [startDate, setStartDate] = useState(todayStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [checkedDates, setCheckedDates] = useState<Record<string, boolean>>({});

  const { data: empList } = useQuery<EmpRow[]>({
    queryKey: ["/api/factory/employees"],
    queryFn: async () => {
      const res = await fetch("/api/factory/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const empIdNum = selectedEmpId ? parseInt(selectedEmpId) : null;

  const { data: attendanceRecords } = useQuery<AttRecord[]>({
    queryKey: ["/api/factory/employee-attendance/employee", empIdNum, startDate, endDate],
    queryFn: async () => {
      if (!empIdNum) return [];
      const res = await fetch(
        `/api/factory/employee-attendance/employee/${empIdNum}?startDate=${startDate}&endDate=${endDate}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!empIdNum && !!startDate && !!endDate,
  });

  useEffect(() => {
    const dates = generateDateRange(startDate, endDate);
    const next: Record<string, boolean> = {};
    for (const d of dates) next[d] = false;
    if (attendanceRecords) {
      for (const r of attendanceRecords) next[r.attendanceDate] = r.status !== "Absent";
    }
    setCheckedDates(next);
  }, [attendanceRecords, startDate, endDate]);

  const dates = generateDateRange(startDate, endDate);
  const presentCount = Object.values(checkedDates).filter(Boolean).length;
  const absentCount = dates.length - presentCount;

  const saveMutation = useMutation({
    mutationFn: (records: EmployeeAttendanceBulkRecord[]) =>
      apiRequest("POST", "/api/factory/employee-attendance/bulk", { records }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/factory/employee-attendance/employee", empIdNum, startDate, endDate],
      });
      toast({ title: "Attendance saved", description: `${dates.length} days saved.` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    if (!empIdNum) return;
    const existingStatusMap: Record<string, string> = {};
    if (attendanceRecords) for (const r of attendanceRecords) existingStatusMap[r.attendanceDate] = r.status;
    const records = dates.map((d) => {
      if (checkedDates[d]) {
        const existing = existingStatusMap[d];
        const status = existing && existing !== "Absent" ? existing : "Present";
        return { employeeId: empIdNum, attendanceDate: d, status };
      }
      return { employeeId: empIdNum, attendanceDate: d, status: "Absent" };
    });
    saveMutation.mutate(records);
  };

  const selectedEmp = (empList ?? []).find((e) => e.id === empIdNum);

  const weeks = dates.reduce<string[][]>((acc, d) => {
    if (acc.length === 0 || acc[acc.length - 1].length === 7) acc.push([]);
    acc[acc.length - 1].push(d);
    return acc;
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1 min-w-[200px]">
              <Label className="text-xs text-muted-foreground">Employee</Label>
              <Popover open={empComboOpen} onOpenChange={setEmpComboOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={empComboOpen}
                    className="w-56 justify-between font-normal"
                    data-testid="select-employee"
                  >
                    <span className="truncate">
                      {selectedEmp ? `${selectedEmp.firstName} ${selectedEmp.lastName}` : "Select employee"}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search employee…" />
                    <CommandList>
                      <CommandEmpty>No employees found.</CommandEmpty>
                      <CommandGroup>
                        {(empList ?? []).map((e) => (
                          <CommandItem
                            key={e.id}
                            value={`${e.firstName} ${e.lastName} ${e.code ?? ""}`}
                            onSelect={() => {
                              setSelectedEmpId(String(e.id));
                              setEmpComboOpen(false);
                            }}
                          >
                            <Check
                              className={`mr-2 h-4 w-4 shrink-0 ${selectedEmpId === String(e.id) ? "opacity-100" : "opacity-0"}`}
                            />
                            {e.firstName} {e.lastName}
                            {e.code && <span className="ml-1 text-muted-foreground">({e.code})</span>}
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
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-40"
                data-testid="input-start-date"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-40"
                data-testid="input-end-date"
              />
            </div>
            <div className="flex gap-2 ml-auto items-center flex-wrap">
              <Button
                variant="outline"
                onClick={() => {
                  const n: Record<string, boolean> = {};
                  for (const d of dates) n[d] = true;
                  setCheckedDates(n);
                }}
                disabled={!empIdNum}
                data-testid="button-select-all"
              >
                <UserCheck className="h-4 w-4 mr-1" /> Select All
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const n: Record<string, boolean> = {};
                  for (const d of dates) n[d] = false;
                  setCheckedDates(n);
                }}
                disabled={!empIdNum}
                data-testid="button-deselect-all"
              >
                <UserX className="h-4 w-4 mr-1" /> Deselect All
              </Button>
              <Button
                onClick={handleSave}
                disabled={!empIdNum || saveMutation.isPending}
                data-testid="button-save-per-employee"
              >
                <Save className="h-4 w-4 mr-1" />
                {saveMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {empIdNum && (
        <>
          <div className="flex gap-4 text-sm">
            <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
              <CheckCircle className="h-4 w-4" /> Present: <strong>{presentCount}</strong>
            </span>
            <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
              <XCircle className="h-4 w-4" /> Absent: <strong>{absentCount}</strong>
            </span>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {selectedEmp ? `${selectedEmp.firstName} ${selectedEmp.lastName}` : "Employee"} — {startDate} to{" "}
                {endDate}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {weeks.map((week, wi) => (
                  <div key={wi} className="grid grid-cols-7 gap-1">
                    {week.map((d) => {
                      const isPresent = checkedDates[d];
                      const dayNum = new Date(d + "T00:00:00").getDate();
                      const dayName = new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" });
                      return (
                        <button
                          key={d}
                          onClick={() => setCheckedDates((p) => ({ ...p, [d]: !p[d] }))}
                          data-testid={`day-${d}`}
                          className={`flex flex-col items-center justify-center rounded-md py-2 px-1 text-xs border transition-colors
                            ${
                              isPresent
                                ? "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700 text-green-800 dark:text-green-200"
                                : "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-600 dark:text-red-400"
                            }`}
                        >
                          <span className="font-medium">{dayNum}</span>
                          <span className="text-[10px] opacity-70">{dayName}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {!empIdNum && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <User className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>Select an employee to view and edit attendance.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
