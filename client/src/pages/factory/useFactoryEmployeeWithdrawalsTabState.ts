// Extracted from ./FactoryEmployeeWithdrawalsTab.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useToast } from "@/hooks/use-toast";
import { fmt, today, type Employee, type CashAccount } from "./FactoryEmployeeWithdrawalsTabHelpers";

export function useFactoryEmployeeWithdrawalsTabState() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const [singleOpen, setSingleOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  const [singleForm, setSingleForm] = useState({
    employeeId: "",
    amount: "",
    date: today(),
    cashAccountId: "",
    notes: "",
  });

  const [bulkForm, setBulkForm] = useState({
    date: today(),
    cashAccountId: "",
    notes: "",
  });
  const [bulkAmounts, setBulkAmounts] = useState<Record<number, string>>({});

  const {
    data: employeesData,
    isError,
    refetch,
  } = useQuery<Employee[]>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });
  const employees = employeesData ?? [];

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

  const singleMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await fetch(`/api/factory/employees/${singleForm.employeeId}/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          amount: singleForm.amount,
          date: singleForm.date,
          cashAccountId: singleForm.cashAccountId,
          notes: singleForm.notes || undefined,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Withdrawal recorded" });
      setSingleOpen(false);
      setSingleForm({ employeeId: "", amount: "", date: today(), cashAccountId: "", notes: "" });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const bulkMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const withdrawals = employees
        .filter((e) => bulkAmounts[e.id] && parseFloat(bulkAmounts[e.id]) > 0)
        .map((e) => ({ employeeId: e.id, amount: bulkAmounts[e.id] }));
      if (withdrawals.length === 0) throw new Error("Enter at least one withdrawal amount");
      const res = await fetch("/api/factory/employees/bulk-withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          withdrawals,
          date: bulkForm.date,
          cashAccountId: bulkForm.cashAccountId,
          notes: bulkForm.notes || undefined,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Bulk withdrawal recorded",
        description: `${data.results?.length ?? 0} employees — Total: ${fmt(data.totalAmount)}`,
      });
      setBulkOpen(false);
      setBulkAmounts({});
      setBulkForm({ date: today(), cashAccountId: "", notes: "" });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const bulkTotal = useMemo(
    () => Object.values(bulkAmounts).reduce((s, v) => s + (parseFloat(v) || 0), 0),
    [bulkAmounts]
  );

  const selectedEmp = employees.find((e) => String(e.id) === singleForm.employeeId);
  return {
    wrapAdminAction,
    AdminDialog,
    recordChanges,
    setSingleOpen,
    singleOpen,
    setBulkOpen,
    bulkOpen,
    setSingleForm,
    singleForm,
    bulkForm,
    setBulkForm,
    bulkAmounts,
    setBulkAmounts,
    isError,
    employeesData,
    refetch,
    employees,
    cashAccounts,
    singleMutation,
    bulkMutation,
    bulkTotal,
    selectedEmp,
  };
}
