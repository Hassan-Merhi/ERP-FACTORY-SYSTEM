// Extracted from ./PerWorkerView.tsx
import { useCompany } from "@/contexts/CompanyContext";
import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { AttendanceBulkRecord, AttendanceRecord, WorkerRow } from "../types";
import {
  attendancePastDates,
  canSkipAttendanceApproval,
  attendanceToday,
  type AttendanceAdminCredentials,
} from "../attendanceEditPolicy";
import { generateDateRange } from "../utils";

export function usePerWorkerViewState() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const canEditPastWithoutPassword = (dates: string[]) => canSkipAttendanceApproval(selectedCompany?.role, dates);
  const recordChanges = useExistingRecordChangeAccess();
  const [selectedWorkerId, setSelectedWorkerId] = useState<string>("");
  const [workerComboOpen, setWorkerComboOpen] = useState(false);
  const [startDate, setStartDate] = useState<string>(attendanceToday);
  const [endDate, setEndDate] = useState<string>(attendanceToday);
  const [checkedDates, setCheckedDates] = useState<Record<string, boolean>>({});
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [pendingApprovalRecords, setPendingApprovalRecords] = useState<AttendanceBulkRecord[] | null>(null);
  const [approvalDates, setApprovalDates] = useState<string[]>([]);

  const { data: workersList, isLoading: loadingWorkers } = useQuery<WorkerRow[]>({
    queryKey: ["/api/factory/workers?active=true"],
  });

  const workerIdNum = selectedWorkerId ? parseInt(selectedWorkerId) : null;

  const {
    data: attendanceRecords,
    isLoading: loadingAttendance,
    isError: attendanceError,
    refetch: refetchAttendance,
  } = useQuery<AttendanceRecord[]>({
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
    mutationFn: (payload: { records: AttendanceBulkRecord[]; credentials?: AttendanceAdminCredentials }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return apiRequest("POST", "/api/factory/attendance/bulk", { records: payload.records, ...payload.credentials });
    },
    onSuccess: () => {
      setApprovalOpen(false);
      setPendingApprovalRecords(null);
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
    const records: AttendanceBulkRecord[] = dates.map((d): AttendanceBulkRecord => {
      if (checkedDates[d]) {
        // Preserve existing granular status (Late, Half Day, Leave) if the date
        // is checked; fall back to "Present" for new/previously-absent dates.
        const existing = existingStatusMap[d];
        const status: AttendanceBulkRecord["status"] =
          existing === "Late" || existing === "Half Day" || existing === "Leave" ? existing : "Present";
        return { workerId: workerIdNum, attendanceDate: d, status };
      }
      return { workerId: workerIdNum, attendanceDate: d, status: "Absent" };
    });
    const priorDates = attendancePastDates(records.map((record) => record.attendanceDate));
    if (priorDates.length && !canEditPastWithoutPassword(priorDates)) {
      setApprovalDates(priorDates);
      setPendingApprovalRecords(records);
      setApprovalOpen(true);
    } else {
      saveMutation.mutate({ records });
    }
  };

  const approveAttendanceSave = (credentials: AttendanceAdminCredentials) => {
    if (pendingApprovalRecords) saveMutation.mutate({ records: pendingApprovalRecords, credentials });
  };

  const selectedWorker = (workersList ?? []).find((w) => w.id === workerIdNum);
  return {
    canEditPastWithoutPassword,
    recordChanges,
    setSelectedWorkerId,
    selectedWorkerId,
    workerComboOpen,
    setWorkerComboOpen,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    checkedDates,
    approvalOpen,
    setApprovalOpen,
    approvalDates,
    loadingWorkers,
    workersList,
    workerIdNum,
    loadingAttendance,
    attendanceError,
    attendanceRecords,
    refetchAttendance,
    dates,
    presentCount,
    absentCount,
    toggleDate,
    selectAll,
    deselectAll,
    saveMutation,
    handleSave,
    approveAttendanceSave,
    selectedWorker,
  };
}
