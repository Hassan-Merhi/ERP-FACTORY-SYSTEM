import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
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
import { AttendanceAdminApprovalDialog } from "./factoryattendance/components/AttendanceAdminApprovalDialog";
import { attendancePastDates, attendanceToday, type AttendanceAdminCredentials } from "./factoryattendance/attendanceEditPolicy";
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

// Visual-only palette: status identifiers and attendance rules remain unchanged.
const STATUS_COLORS: Record<string, string> = {
  Present: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-200",
  Absent: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-500/50 dark:bg-rose-500/15 dark:text-rose-200",
  Late: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-200",
  "Half Day": "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-200",
  Leave: "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-500/50 dark:bg-violet-500/15 dark:text-violet-200",
};

const SUMMARY_TONES: Record<string, { card: string; icon: string; glow: string }> = {
  Total: {
    card: "border-blue-200 bg-gradient-to-br from-blue-50 via-white to-sky-100 dark:border-blue-500/35 dark:from-[#192f5a] dark:via-[#142747] dark:to-[#183f7c]",
    icon: "bg-blue-100 text-blue-700 dark:bg-blue-400/20 dark:text-blue-200",
    glow: "bg-blue-400/15 dark:bg-blue-400/25",
  },
  Present: {
    card: "border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-emerald-100 dark:border-emerald-500/35 dark:from-[#123e3a] dark:via-[#10332f] dark:to-[#12694b]",
    icon: "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-200",
    glow: "bg-emerald-400/15 dark:bg-emerald-400/25",
  },
  Absent: {
    card: "border-rose-200 bg-gradient-to-br from-rose-50 via-white to-rose-100 dark:border-rose-500/35 dark:from-[#4b2135] dark:via-[#392033] dark:to-[#732f47]",
    icon: "bg-rose-100 text-rose-700 dark:bg-rose-400/20 dark:text-rose-200",
    glow: "bg-rose-400/15 dark:bg-rose-400/25",
  },
  Other: {
    card: "border-amber-200 bg-gradient-to-br from-amber-50 via-white to-amber-100 dark:border-amber-500/35 dark:from-[#44351a] dark:via-[#3b301d] dark:to-[#77520e]",
    icon: "bg-amber-100 text-amber-700 dark:bg-amber-400/20 dark:text-amber-200",
    glow: "bg-amber-400/15 dark:bg-amber-400/25",
  },
};

function localDateStr(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  const tone = SUMMARY_TONES[label] ?? SUMMARY_TONES.Total;
  return (
    <Card className={`relative isolate overflow-hidden rounded-2xl shadow-sm ${tone.card}`}>
      <div aria-hidden="true" className={`pointer-events-none absolute -bottom-12 -right-8 h-32 w-44 rotate-[-20deg] rounded-full blur-2xl ${tone.glow}`} />
      <CardContent className="relative flex items-center justify-between gap-3 px-4 py-4 sm:px-5 sm:py-5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-600 dark:text-slate-200">{label}</p>
          <p className={`mt-1 text-3xl font-bold tracking-tight tabular-nums ${color}`} data-testid={testId}>
            {value}
          </p>
        </div>
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl shadow-sm ${tone.icon}`}>{icon}</div>
      </CardContent>
    </Card>
  );
}

export default function FactoryEmployeeAttendanceTab() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const [mode, setMode] = useState<ViewMode>("daily");

  const [selectedDate, setSelectedDate] = useState(attendanceToday);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalDates, setApprovalDates] = useState<string[]>([]);
  const [pendingApprovalRecords, setPendingApprovalRecords] = useState<EmployeeAttendanceBulkRecord[] | null>(null);
  const [shift, setShift] = useState("");
  const [attendanceMap, setAttendanceMap] = useState<Record<number, AttendanceStatus>>({});
  const [notesMap, setNotesMap] = useState<Record<number, string>>({});

  const { data, isLoading } = useQuery<{ employees: EmpRow[]; attendance: AttRecord[] }>({
    queryKey: companyQueryKey("/api/factory/employee-attendance", selectedCompany?.id, selectedDate),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch(`/api/factory/employee-attendance?date=${selectedDate}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  useEffect(() => {
    setAttendanceMap({});
    setNotesMap({});
    setApprovalOpen(false);
    setPendingApprovalRecords(null);
  }, [selectedCompany?.id]);

  useEffect(() => {
    if (!data) return;
    const newMap: Record<number, AttendanceStatus> = {};
    const newNotes: Record<number, string> = {};
    for (const e of data.employees ?? []) newMap[e.id] = "Present";
    for (const a of data.attendance ?? []) {
      newMap[a.employeeId] = a.status as AttendanceStatus;
      newNotes[a.employeeId] = a.notes || "";
    }
    setAttendanceMap(newMap);
    setNotesMap(newNotes);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (payload: { records: EmployeeAttendanceBulkRecord[]; credentials?: AttendanceAdminCredentials }) =>
      apiRequest("POST", "/api/factory/employee-attendance/bulk", {
        records: payload.records, ...payload.credentials,
      }),
    onSuccess: () => {
      setApprovalOpen(false);
      setPendingApprovalRecords(null);
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employee-attendance", selectedCompany?.id, selectedDate) });
      toast({ title: "Attendance saved", description: `Saved for ${selectedDate}` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = useCallback(() => {
    if (!selectedCompany?.id || !data?.employees?.length) return;
    const records = data.employees.map((e) => ({
      employeeId: e.id,
      attendanceDate: selectedDate,
      status: attendanceMap[e.id] ?? "Present",
      notes: notesMap[e.id] || undefined,
    }));
    const priorDates = attendancePastDates(records.map((record) => record.attendanceDate));
    if (priorDates.length) {
      setApprovalDates(priorDates);
      setPendingApprovalRecords(records);
      setApprovalOpen(true);
    } else {
      saveMutation.mutate({ records });
    }
  }, [data, selectedDate, attendanceMap, notesMap, saveMutation, selectedCompany?.id]);

  const approveAttendanceSave = (credentials: AttendanceAdminCredentials) => {
    if (selectedCompany?.id && pendingApprovalRecords) saveMutation.mutate({ records: pendingApprovalRecords, credentials });
  };

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
    <div className="space-y-5 rounded-2xl border border-slate-200/70 bg-gradient-to-b from-slate-50/80 to-white p-3 shadow-sm sm:p-5 dark:border-blue-400/10 dark:from-[#0c1933] dark:via-[#0c1730] dark:to-[#0a1327]">
      <div className="inline-flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white/80 p-1.5 shadow-sm dark:border-blue-400/20 dark:bg-slate-900/70">
        <Button
          variant={mode === "daily" ? "default" : "outline"}
          className={mode === "daily" ? "rounded-lg border-blue-500 bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-md shadow-blue-500/20 hover:from-sky-600 hover:to-blue-700" : "rounded-lg border-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}
          onClick={() => setMode("daily")}
          data-testid="button-mode-daily"
        >
          <CalendarDays className="h-4 w-4 mr-2" />
          Daily View
        </Button>
        <Button
          variant={mode === "perEmployee" ? "default" : "outline"}
          className={mode === "perEmployee" ? "rounded-lg border-blue-500 bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-md shadow-blue-500/20 hover:from-sky-600 hover:to-blue-700" : "rounded-lg border-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}
          onClick={() => setMode("perEmployee")}
          data-testid="button-mode-per-employee"
        >
          <User className="h-4 w-4 mr-2" />
          Per Employee
        </Button>
      </div>

      {mode === "perEmployee" ? (
        <PerEmployeeView key={selectedCompany?.id ?? "no-company"} />
      ) : (
        <>
          <Card className="rounded-2xl border-slate-200/90 bg-white/90 shadow-sm dark:border-blue-400/25 dark:bg-[#13223d]/80">
            <CardContent className="px-4 py-4 sm:px-5 sm:py-5">
              <div className="flex flex-wrap items-end gap-3 sm:gap-4">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Attendance Date</Label>
                  <Input
                    type="date"
                    max={attendanceToday()}
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="h-10 w-44 rounded-xl border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-950/40"
                    data-testid="input-attendance-date"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Shift (optional)</Label>
                  <Input
                    placeholder="e.g. Morning"
                    value={shift}
                    onChange={(e) => setShift(e.target.value)}
                    className="h-10 w-40 rounded-xl border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-950/40"
                    data-testid="input-shift"
                  />
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    className="rounded-xl border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-500/60 dark:bg-emerald-500/15 dark:text-emerald-200 dark:hover:bg-emerald-500/25"
                    onClick={() => markAll("Present")}
                    disabled={!emps.length}
                    data-testid="button-mark-all-present"
                  >
                    <UserCheck className="h-4 w-4 mr-1" /> Mark All Present
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-xl border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100 dark:border-rose-500/60 dark:bg-rose-500/15 dark:text-rose-200 dark:hover:bg-rose-500/25"
                    onClick={() => markAll("Absent")}
                    disabled={!emps.length}
                    data-testid="button-mark-all-absent"
                  >
                    <UserX className="h-4 w-4 mr-1" /> Mark All Absent
                  </Button>
                  <Button variant="ghost" className="rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800/60 dark:hover:bg-slate-700" onClick={reset} disabled={!emps.length} data-testid="button-reset">
                    <RotateCcw className="h-4 w-4 mr-1" /> Reset
                  </Button>
                  <Button
                    className="rounded-xl border border-blue-500 bg-gradient-to-r from-sky-500 to-blue-600 px-5 text-white shadow-md shadow-blue-500/20 hover:from-sky-600 hover:to-blue-700"
                    onClick={handleSave}
                    disabled={!emps.length || saveMutation.isPending || selectedDate > attendanceToday()}
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
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <SummaryCard
                icon={<Users className="h-5 w-5" />}
                label="Total"
                value={counts.total}
                color="text-blue-800 dark:text-blue-100"
                testId="stat-total"
              />
              <SummaryCard
                icon={<CheckCircle className="h-5 w-5" />}
                label="Present"
                value={counts.present}
                color="text-green-600 dark:text-green-400"
                testId="stat-present"
              />
              <SummaryCard
                icon={<XCircle className="h-5 w-5" />}
                label="Absent"
                value={counts.absent}
                color="text-red-600 dark:text-red-400"
                testId="stat-absent"
              />
              <SummaryCard
                icon={<Clock className="h-5 w-5" />}
                label="Other"
                value={counts.other}
                color="text-amber-600 dark:text-amber-400"
                testId="stat-other"
              />
            </div>
          )}

          <Card className="overflow-hidden rounded-2xl border-slate-200/90 bg-white/95 shadow-sm dark:border-blue-400/25 dark:bg-[#13223d]/80">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4 pb-3 pt-5 sm:px-5">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base font-semibold sm:text-lg">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200"><CalendarDays className="h-5 w-5" /></span>
                Employees — {formatDate(selectedDate)}
                {shift && <Badge variant="secondary">{shift}</Badge>}
              </CardTitle>
              {emps.length > 0 && (
                <span className="text-sm text-muted-foreground">
                  {emps.length} employee{emps.length !== 1 ? "s" : ""}
                </span>
              )}
            </CardHeader>
            <CardContent className="px-3 pb-4 pt-0 sm:px-5 sm:pb-5">
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
                  <div className="hidden overflow-x-auto rounded-xl border border-slate-200 sm:block dark:border-slate-600/70">
                    <table className="w-full min-w-[760px] text-sm">
                      <thead className="sticky top-0 z-30">
                        <tr className="border-b border-slate-200 bg-slate-100/90 dark:border-slate-600 dark:bg-[#213353]">
                          <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200 w-8">#</th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200">Employee</th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200">Department</th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200 w-44">Status</th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {emps.map((emp, idx) => {
                          const status = attendanceMap[emp.id] ?? "Present";
                          return (
                            <tr
                              key={emp.id}
                              className="border-b border-slate-100 transition-colors last:border-0 hover:bg-blue-50/60 dark:border-slate-700/70 dark:hover:bg-blue-400/10"
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
                                    className={`h-9 rounded-lg text-xs font-semibold shadow-sm ${STATUS_COLORS[status] ?? ""}`}
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
                                  className="h-9 rounded-lg border-slate-200 bg-slate-50/70 text-xs dark:border-slate-600 dark:bg-slate-950/30"
                                  data-testid={`input-notes-${emp.id}`}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="space-y-3 sm:hidden">
                    {emps.map((emp, idx) => {
                      const status = attendanceMap[emp.id] ?? "Present";
                      return (
                        <div
                          key={emp.id}
                          className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4 shadow-sm dark:border-slate-600/70 dark:bg-slate-900/50"
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
                            <SelectTrigger className={`h-10 rounded-lg text-sm font-semibold ${STATUS_COLORS[status] ?? ""}`}>
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
      {selectedDate < attendanceToday() && (
        <Badge variant="secondary">Earlier date — Admin approval required to save</Badge>
      )}
      <AttendanceAdminApprovalDialog
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        onApprove={approveAttendanceSave}
        isPending={saveMutation.isPending}
        dates={approvalDates}
      />
    </div>
  );
}

function PerEmployeeView() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const [selectedEmpId, setSelectedEmpId] = useState<string>("");
  const [empComboOpen, setEmpComboOpen] = useState(false);
  const [startDate, setStartDate] = useState(attendanceToday);
  const [endDate, setEndDate] = useState(attendanceToday);
  const [checkedDates, setCheckedDates] = useState<Record<string, boolean>>({});
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalDates, setApprovalDates] = useState<string[]>([]);
  const [pendingApprovalRecords, setPendingApprovalRecords] = useState<EmployeeAttendanceBulkRecord[] | null>(null);

  const { data: empList } = useQuery<EmpRow[]>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const empIdNum = selectedEmpId ? parseInt(selectedEmpId) : null;

  const { data: attendanceRecords } = useQuery<AttRecord[]>({
    queryKey: companyQueryKey("/api/factory/employee-attendance/employee", selectedCompany?.id, empIdNum, startDate, endDate),
    queryFn: async () => {
      if (!empIdNum) return [];
      const res = await fetch(
        `/api/factory/employee-attendance/employee/${empIdNum}?startDate=${startDate}&endDate=${endDate}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!empIdNum && !!startDate && !!endDate,
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
    mutationFn: (payload: { records: EmployeeAttendanceBulkRecord[]; credentials?: AttendanceAdminCredentials }) =>
      apiRequest("POST", "/api/factory/employee-attendance/bulk", {
        records: payload.records, ...payload.credentials,
      }),
    onSuccess: () => {
      setApprovalOpen(false);
      setPendingApprovalRecords(null);
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employee-attendance/employee", selectedCompany?.id, empIdNum, startDate, endDate),
      });
      toast({ title: "Attendance saved", description: `${dates.length} days saved.` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    if (!selectedCompany?.id || !empIdNum) return;
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
    const priorDates = attendancePastDates(records.map((record) => record.attendanceDate));
    if (priorDates.length) {
      setApprovalDates(priorDates);
      setPendingApprovalRecords(records);
      setApprovalOpen(true);
    } else {
      saveMutation.mutate({ records });
    }
  };

  const approveAttendanceSave = (credentials: AttendanceAdminCredentials) => {
    if (selectedCompany?.id && pendingApprovalRecords) saveMutation.mutate({ records: pendingApprovalRecords, credentials });
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
                max={attendanceToday()}
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
                max={attendanceToday()}
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
                disabled={!empIdNum || saveMutation.isPending || dates.some((d) => d > attendanceToday())}
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
                          <span className="text-[11px] opacity-70">{dayName}</span>
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
      {attendancePastDates(dates).length > 0 && (
        <Badge variant="secondary">Earlier dates require Admin approval to save</Badge>
      )}
      <AttendanceAdminApprovalDialog
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        onApprove={approveAttendanceSave}
        isPending={saveMutation.isPending}
        dates={approvalDates}
      />
    </div>
  );
}
