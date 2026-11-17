// Extracted from ./FactoryEmployees.tsx to keep that module under the source-size cap.
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryApiRequest } from "@/lib/factoryApi";

export interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  department: string | null;
  monthlySalary: string;
  currentBalance: string;
  totalDeposits: string;
  totalWithdrawals: string;
  active: boolean;
  joinDate: string;
  employeeType: string;
}

const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
];

export function getAvatarColor(name: string) {
  let hash = 0;
  for (const c of name) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function getInitials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

export const emptyForm = {
  firstName: "",
  lastName: "",
  code: "",
  department: "",
  phone: "",
  monthlySalary: "",
  joinDate: new Date().toLocaleDateString("en-CA"),
};

export function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  if (isNaN(n)) return "$0";
  return n % 1 === 0 ? `$${n.toLocaleString()}` : `$${n.toFixed(2)}`;
}

export function useFactoryEmployeesState() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("Active");
  const [createOpen, setCreateOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [endingContractEmployee, setEndingContractEmployee] = useState<Employee | null>(null);
  const [formData, setFormData] = useState({ ...emptyForm });
  const [recalcConfirmOpen, setRecalcConfirmOpen] = useState(false);
  const [recalcResultOpen, setRecalcResultOpen] = useState(false);
  const [recalcResult, setRecalcResult] = useState<{
    updated: number;
    employees: Array<{ id: number; name: string; oldBalance: number; newBalance: number }>;
  } | null>(null);
  const {
    data: employeesData,
    isLoading,
    isError,
    refetch,
  } = useQuery<Employee[]>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/factory/employees");
      if (!res.ok) throw new Error("Failed to fetch employees");
      return res.json();
    },
  });
  const employees = employeesData ?? [];
  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const res = await factoryApiRequest("POST", "/api/factory/employees", data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to create employee");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Employee created" });
      setCreateOpen(false);
      setFormData({ ...emptyForm });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<typeof formData> }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("PATCH", `/api/factory/employees/${id}`, data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update employee");
      }
      return res.json();
    },
    onSuccess: (emp: Employee) => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, emp.id),
      });
      toast({ title: "Employee updated" });
      setEditingEmployee(null);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("PATCH", `/api/factory/employees/${id}`, { active: false });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to end contract");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Contract ended", description: "Employee has been deactivated" });
      setEndingContractEmployee(null);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("PATCH", `/api/factory/employees/${id}`, { active: true });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to reactivate employee");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Employee reactivated" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const recalcMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("POST", "/api/factory/employees/recalculate-balances", {});
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to recalculate balances");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      setRecalcConfirmOpen(false);
      setRecalcResult(data);
      setRecalcResultOpen(true);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: "Recalculation failed", description: e.message });
    },
  });
  return {
    refetch,
    isError,
    employeesData,
    createMutation,
    createOpen,
    deactivateMutation,
    editingEmployee,
    employees,
    endingContractEmployee,
    formData,
    isLoading,
    navigate,
    reactivateMutation,
    recalcConfirmOpen,
    recalcMutation,
    recalcResult,
    recalcResultOpen,
    recordChanges,
    search,
    setCreateOpen,
    setEditingEmployee,
    setEndingContractEmployee,
    setFormData,
    setRecalcConfirmOpen,
    setRecalcResultOpen,
    setSearch,
    setStatusFilter,
    statusFilter,
    updateMutation,
  };
}
