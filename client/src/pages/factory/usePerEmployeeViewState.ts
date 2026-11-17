// Extracted from ./FactoryEmployeeAttendanceTab.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useToast } from "@/hooks/use-toast";
import {
  type AttendanceAdminCredentials,
  attendancePastDates,
  attendanceToday,
} from "./factoryattendance/attendanceEditPolicy";
import {
  generateDateRange,
  type AttRecord,
  type EmpRow,
  type EmployeeAttendanceBulkRecord,
} from "./useFactoryEmployeeAttendanceTabState";

export function usePerEmployeeViewState() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const canEditPastWithoutPassword = selectedCompany?.role === "Admin" || selectedCompany?.role === "Developer";
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
    queryKey: companyQueryKey(
      "/api/factory/employee-attendance/employee",
      selectedCompany?.id,
      empIdNum,
      startDate,
      endDate
    ),
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
        queryKey: companyQueryKey(
          "/api/factory/employee-attendance/employee",
          selectedCompany?.id,
          empIdNum,
          startDate,
          endDate
        ),
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
    if (priorDates.length && !canEditPastWithoutPassword) {
      setApprovalDates(priorDates);
      setPendingApprovalRecords(records);
      setApprovalOpen(true);
    } else {
      saveMutation.mutate({ records });
    }
  };

  const approveAttendanceSave = (credentials: AttendanceAdminCredentials) => {
    if (selectedCompany?.id && pendingApprovalRecords)
      saveMutation.mutate({ records: pendingApprovalRecords, credentials });
  };

  const selectedEmp = (empList ?? []).find((e) => e.id === empIdNum);

  const weeks = dates.reduce<string[][]>((acc, d) => {
    if (acc.length === 0 || acc[acc.length - 1].length === 7) acc.push([]);
    acc[acc.length - 1].push(d);
    return acc;
  }, []);
  return {
    canEditPastWithoutPassword,
    absentCount,
    approvalDates,
    approvalOpen,
    approveAttendanceSave,
    checkedDates,
    dates,
    empComboOpen,
    empIdNum,
    empList,
    endDate,
    handleSave,
    presentCount,
    recordChanges,
    saveMutation,
    selectedEmp,
    selectedEmpId,
    setApprovalOpen,
    setCheckedDates,
    setEmpComboOpen,
    setEndDate,
    setSelectedEmpId,
    setStartDate,
    startDate,
    weeks,
  };
}
