// Extracted from ./FactoryEmployeePayrollTab.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useToast } from "@/hooks/use-toast";

interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
  monthlySalary: string;
  currentBalance: string;
  department: string | null;
  active: boolean;
  employeeType: string;
}

interface PayrollPreview {
  employeeId: number;
  employeeName: string;
  department: string | null;
  monthlySalary: string;
  daysInMonth: number;
  presentDays: number;
  halfDays: number;
  absentDays: number;
  totalMarkedDays: number;
  calculatedPay: string;
  outstandingAdvance: string;
  deduction: string;
  netPay: string;
}

export function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "0.00" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const today = () => new Date().toLocaleDateString("en-CA");

const currentMonthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};

const currentMonthEnd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;
};

export function useFactoryEmployeePayrollTabState() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const [payrollOpen, setPayrollOpen] = useState(false);
  const [payDate, setPayDate] = useState(today());
  const [payEffectiveDate, setPayEffectiveDate] = useState("");
  const [startDate, setStartDate] = useState(currentMonthStart());
  const [endDate, setEndDate] = useState(currentMonthEnd());
  const [payNotes, setPayNotes] = useState("");
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [deductions, setDeductions] = useState<Record<number, string>>({});
  const [previewRows, setPreviewRows] = useState<Record<number, PayrollPreview>>({});
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  const { data: employees = [], isLoading } = useQuery<Employee[]>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      const all = await res.json();
      return all.filter((e: Employee) => e.active);
    },
  });

  const { isLoading: previewLoading, refetch: refetchPreview } = useQuery<{ preview: PayrollPreview[] }>({
    queryKey: companyQueryKey("/api/factory/employee-payroll-preview", selectedCompany?.id, startDate, endDate),
    queryFn: async () => {
      const res = await fetch(`/api/factory/employee-payroll-preview?startDate=${startDate}&endDate=${endDate}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load preview");
      return res.json();
    },
    enabled: false,
  });

  useEffect(() => {
    setPreviewRows({});
    setAmounts({});
    setDeductions({});
    setPayrollOpen(false);
  }, [selectedCompany?.id]);

  const loadPreview = async () => {
    if (!selectedCompany?.id) return;
    const { data } = await refetchPreview();
    const preview = data?.preview || [];
    const initialAmounts: Record<number, string> = {};
    const initialDeductions: Record<number, string> = {};
    const rows: Record<number, PayrollPreview> = {};
    for (const p of preview) {
      rows[p.employeeId] = p;
      const pay = parseFloat(p.calculatedPay);
      const ded = parseFloat(p.deduction);
      initialAmounts[p.employeeId] = pay > 0 ? pay.toFixed(2) : "";
      initialDeductions[p.employeeId] = ded > 0 ? ded.toFixed(2) : "";
    }
    setPreviewRows(rows);
    setAmounts(initialAmounts);
    setDeductions(initialDeductions);
  };

  const openPayroll = async () => {
    await loadPreview();
    setPayrollOpen(true);
  };

  const getNet = useCallback(
    (empId: number) => {
      const sal = parseFloat(amounts[empId] || "0") || 0;
      const ded = parseFloat(deductions[empId] || "0") || 0;
      return Math.max(0, sal - ded);
    },
    [amounts, deductions]
  );

  const totalNet = useMemo(() => employees.reduce((s, e) => s + getNet(e.id), 0), [employees, getNet]);

  const payrollMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const deposits = employees
        .map((e) => ({
          employeeId: e.id,
          amount: parseFloat(amounts[e.id] || "0") || 0,
          deduction: parseFloat(deductions[e.id] || "0") || 0,
        }))
        .filter((d) => d.amount > 0 || d.deduction > 0);
      if (deposits.length === 0) throw new Error("No amounts entered");
      const res = await fetch("/api/factory/employees/bulk-payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          deposits,
          date: payDate,
          notes: payNotes || null,
          effectiveDate: payEffectiveDate || null,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Payroll run complete", description: `Total paid: ${fmt(totalNet)}` });
      setPayrollOpen(false);
      setAmounts({});
      setDeductions({});
      setPayNotes("");
      setPayEffectiveDate("");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employee-advances"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Run failed", description: e.message, variant: "destructive" }),
  });

  const grouped = useMemo(() => {
    const map: Record<string, Employee[]> = {};
    for (const e of employees) {
      const dept = e.department || "No Department";
      if (!map[dept]) map[dept] = [];
      map[dept].push(e);
    }
    return map;
  }, [employees]);

  const totalMonthlyBase = useMemo(
    () => employees.reduce((s, e) => s + parseFloat(e.monthlySalary || "0"), 0),
    [employees]
  );
  return {
    amounts,
    deductions,
    employees,
    endDate,
    expandedGroup,
    grouped,
    isLoading,
    loadPreview,
    openPayroll,
    payDate,
    payEffectiveDate,
    payNotes,
    payrollMutation,
    payrollOpen,
    previewLoading,
    previewRows,
    recordChanges,
    setAmounts,
    setDeductions,
    setEndDate,
    setExpandedGroup,
    setPayDate,
    setPayEffectiveDate,
    setPayNotes,
    setPayrollOpen,
    setStartDate,
    startDate,
    totalMonthlyBase,
    totalNet,
  };
}
