// Extracted from ./FactoryEmployeeAttendanceTab.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import {
  type AttendanceAdminCredentials,
  attendancePastDates,
  attendanceToday,
} from "./factoryattendance/attendanceEditPolicy";

export type AttendanceStatus = "Present" | "Absent" | "Late" | "Half Day" | "Leave";

type ViewMode = "daily" | "perEmployee";

export interface EmployeeAttendanceBulkRecord {
  employeeId: number;
  attendanceDate: string;
  status: string;
  notes?: string;
}

export interface EmpRow {
  id: number;
  firstName: string;
  lastName: string;
  code: string | null;
  department: string | null;
}

export interface AttRecord {
  id: number;
  employeeId: number;
  attendanceDate: string;
  status: string;
  notes: string | null;
}

export const STATUS_OPTIONS: AttendanceStatus[] = ["Present", "Absent", "Late", "Half Day", "Leave"];

// Visual-only palette: status identifiers and attendance rules remain unchanged.
export const STATUS_COLORS: Record<string, string> = {
  Present:
    "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-200",
  Absent: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-500/50 dark:bg-rose-500/15 dark:text-rose-200",
  Late: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-200",
  "Half Day": "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-200",
  Leave:
    "border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-500/50 dark:bg-violet-500/15 dark:text-violet-200",
};

const SUMMARY_TONES: Record<string, { card: string; icon: string; glow: string }> = {
  Total: {
    card: "border-blue-200 bg-gradient-to-br from-blue-50 via-white to-sky-100 dark:border-blue-500/35 dark:from-[hsl(var(--factory-hue)_57%_23%)] dark:via-[hsl(var(--factory-hue)_56%_18%)] dark:to-[hsl(var(--factory-hue)_68%_29%)]",
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

export function generateDateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  while (cur <= endDate) {
    dates.push(localDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

export function formatDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function SummaryCard({
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
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute -bottom-12 -right-8 h-32 w-44 rotate-[-20deg] rounded-full blur-2xl ${tone.glow}`}
      />
      <CardContent className="relative flex items-center justify-between gap-3 px-4 py-4 sm:px-5 sm:py-5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-600 dark:text-slate-200">{label}</p>
          <p className={`mt-1 text-3xl font-bold tracking-tight tabular-nums ${color}`} data-testid={testId}>
            {value}
          </p>
        </div>
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl shadow-sm ${tone.icon}`}>
          {icon}
        </div>
      </CardContent>
    </Card>
  );
}

export function useFactoryEmployeeAttendanceTabState() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const canEditPastWithoutPassword = selectedCompany?.role === "Admin" || selectedCompany?.role === "Developer";
  const [mode, setMode] = useState<ViewMode>("daily");

  const [selectedDate, setSelectedDate] = useState(attendanceToday);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalDates, setApprovalDates] = useState<string[]>([]);
  const [pendingApprovalRecords, setPendingApprovalRecords] = useState<EmployeeAttendanceBulkRecord[] | null>(null);
  const [shift, setShift] = useState("");
  const [attendanceMap, setAttendanceMap] = useState<Record<number, AttendanceStatus>>({});
  const [notesMap, setNotesMap] = useState<Record<number, string>>({});
  const { data, isLoading, isError, refetch } = useQuery<{ employees: EmpRow[]; attendance: AttRecord[] }>({
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
  }, [selectedCompany?.id, canEditPastWithoutPassword]);
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
    mutationFn: (payload: { records: EmployeeAttendanceBulkRecord[]; credentials?: AttendanceAdminCredentials }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return apiRequest("POST", "/api/factory/employee-attendance/bulk", {
        records: payload.records,
        ...payload.credentials,
      });
    },
    onSuccess: () => {
      setApprovalOpen(false);
      setPendingApprovalRecords(null);
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employee-attendance", selectedCompany?.id, selectedDate),
      });
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
    if (priorDates.length && !canEditPastWithoutPassword) {
      setApprovalDates(priorDates);
      setPendingApprovalRecords(records);
      setApprovalOpen(true);
    } else {
      saveMutation.mutate({ records });
    }
  }, [data, selectedDate, attendanceMap, notesMap, saveMutation, selectedCompany?.id, canEditPastWithoutPassword]);
  const approveAttendanceSave = (credentials: AttendanceAdminCredentials) => {
    if (selectedCompany?.id && pendingApprovalRecords)
      saveMutation.mutate({ records: pendingApprovalRecords, credentials });
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
  return {
    data,
    refetch,
    isError,
    canEditPastWithoutPassword,
    approvalDates,
    approvalOpen,
    approveAttendanceSave,
    attendanceMap,
    counts,
    emps,
    handleSave,
    isLoading,
    markAll,
    mode,
    notesMap,
    recordChanges,
    reset,
    saveMutation,
    selectedCompany,
    selectedDate,
    setApprovalOpen,
    setAttendanceMap,
    setMode,
    setNotesMap,
    setSelectedDate,
    setShift,
    shift,
  };
}
