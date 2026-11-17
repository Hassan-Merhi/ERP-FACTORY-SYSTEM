// Extracted from ./FactoryEmployeeAdvancesTab.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useToast } from "@/hooks/use-toast";
import {
  today,
  type AdvanceRecord,
  type CashAccount,
  type Employee,
  type RepaymentRecord,
} from "./FactoryEmployeeAdvancesTabTypes";

export function useFactoryEmployeeAdvancesTabState() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "paid">("open");
  const [empFilter, setEmpFilter] = useState<string>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [repayOpen, setRepayOpen] = useState<AdvanceRecord | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<AdvanceRecord | null>(null);

  const [addForm, setAddForm] = useState({
    employeeId: "",
    advanceDate: today(),
    amount: "",
    cashAccountId: "",
    notes: "",
  });
  const [repayForm, setRepayForm] = useState({ repaymentDate: today(), amount: "", cashAccountId: "", notes: "" });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const { data: cashAccounts = [] } = useQuery<CashAccount[]>({
    queryKey: companyQueryKey("/api/factory/cash-accounts", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/cash-accounts", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const qKey = useMemo(
    () => companyQueryKey("/api/factory/employee-advances", selectedCompany?.id, statusFilter, empFilter),
    [selectedCompany?.id, statusFilter, empFilter]
  );

  const { data: advances = [], isLoading } = useQuery<AdvanceRecord[]>({
    queryKey: qKey,
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (empFilter !== "all") params.set("employeeId", empFilter);
      const res = await fetch(`/api/factory/employee-advances?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  useQuery<RepaymentRecord[]>({
    queryKey: companyQueryKey("/api/factory/employee-advance-repayments", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/employee-advance-repayments", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/factory/employee-advances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          employeeId: parseInt(addForm.employeeId),
          advanceDate: addForm.advanceDate,
          amount: addForm.amount,
          cashAccountId: addForm.cashAccountId || null,
          notes: addForm.notes || null,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Advance recorded" });
      setAddOpen(false);
      setAddForm({ employeeId: "", advanceDate: today(), amount: "", cashAccountId: "", notes: "" });
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employee-advances", selectedCompany?.id),
      });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const repayMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!repayOpen) return;
      const res = await fetch(`/api/factory/employee-advances/${repayOpen.id}/repay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          repaymentDate: repayForm.repaymentDate,
          amount: repayForm.amount,
          cashAccountId: repayForm.cashAccountId || null,
          notes: repayForm.notes || null,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Repayment recorded" });
      setRepayOpen(null);
      setRepayForm({ repaymentDate: today(), amount: "", cashAccountId: "", notes: "" });
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employee-advances", selectedCompany?.id),
      });
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employee-advance-repayments", selectedCompany?.id),
      });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await fetch(`/api/factory/employee-advances/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
    },
    onSuccess: () => {
      toast({ title: "Advance deleted" });
      setDeleteConfirm(null);
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employee-advances", selectedCompany?.id),
      });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const totalOutstanding = useMemo(
    () => advances.filter((a) => !a.fullyPaid).reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0),
    [advances]
  );
  return {
    addForm,
    addMutation,
    addOpen,
    advances,
    cashAccounts,
    deleteConfirm,
    deleteMutation,
    empFilter,
    employees,
    isLoading,
    recordChanges,
    repayForm,
    repayMutation,
    repayOpen,
    setAddForm,
    setAddOpen,
    setDeleteConfirm,
    setEmpFilter,
    setRepayForm,
    setRepayOpen,
    setStatusFilter,
    statusFilter,
    totalOutstanding,
  };
}
