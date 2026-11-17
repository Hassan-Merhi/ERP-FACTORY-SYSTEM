// Extracted from ./FactoryEmployeeDetail.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useLocation, useRoute } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useDateFormat } from "@/contexts/DateFormatContext";
import type { Employee, LedgerAccount, StatementRow } from "./FactoryEmployeeDetailTypes";

export function useFactoryEmployeeDetailState() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/payroll-hub?section=employees");
  const [, params] = useRoute("/factory/employees/:id");
  const employeeId = params?.id ? parseInt(params.id) : null;
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const { formatDisplayDate } = useDateFormat();

  const formatDate = (val: string | Date | null | undefined) => {
    if (!val) return "—";
    try {
      return formatDisplayDate(val instanceof Date ? val : new Date(val));
    } catch {
      return "—";
    }
  };

  // State for dialogs
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    firstName: "",
    lastName: "",
    department: "",
    phone: "",
    monthlySalary: "",
  });

  // Deposit form
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositDate, setDepositDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [depositNotes, setDepositNotes] = useState("");
  const [depositEffectiveDate, setDepositEffectiveDate] = useState("");

  // Withdrawal form
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawDate, setWithdrawDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [withdrawNotes, setWithdrawNotes] = useState("");
  const [withdrawCashAccountId, setWithdrawCashAccountId] = useState("");

  // Queries
  const {
    data: employee,
    isLoading: empLoading,
    error: empError,
  } = useQuery<Employee>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", `/api/factory/employees/${employeeId}`);
      if (!res.ok) throw new Error("Employee not found");
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!employeeId,
  });
  const {
    data: statement,
    isLoading: stmtLoading,
    isError: stmtError,
    refetch: refetchStatement,
  } = useQuery<{ employee: Employee; rows: StatementRow[] }>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId, "statement"),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", `/api/factory/employees/${employeeId}/statement`);
      if (!res.ok) throw new Error("Failed to fetch statement");
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !!employeeId,
  });

  const { data: cashAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: companyQueryKey("/api/ledger-accounts?includeHidden=true&profile=picker", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/ledger-accounts?includeHidden=true&profile=picker", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return (data || []).filter(
        (a: LedgerAccount) => a.accountType === "Cash" || a.accountType?.toLowerCase().includes("cash")
      );
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Mutations
  const updateMutation = useMutation({
    mutationFn: async (data: typeof editForm) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("PATCH", `/api/factory/employees/${employeeId}`, data);
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId),
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Employee updated" });
      setEditOpen(false);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const recalcMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("POST", `/api/factory/employees/${employeeId}/recalculate-balance`);
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId),
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Balance recalculated", description: `New balance: $${data.newBalance?.toFixed(2)}` });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const depositMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("POST", `/api/factory/employees/${employeeId}/deposit`, {
        amount: depositAmount,
        date: depositDate,
        notes: depositNotes,
        effectiveDate: depositEffectiveDate || null,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId),
      });
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId, "statement"),
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Deposit recorded" });
      setDepositOpen(false);
      setDepositAmount("");
      setDepositNotes("");
      setDepositEffectiveDate("");
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const withdrawMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("POST", `/api/factory/employees/${employeeId}/withdraw`, {
        amount: withdrawAmount,
        date: withdrawDate,
        notes: withdrawNotes,
        cashAccountId: withdrawCashAccountId,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId),
      });
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, employeeId, "statement"),
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Withdrawal recorded" });
      setWithdrawOpen(false);
      setWithdrawAmount("");
      setWithdrawNotes("");
      setWithdrawCashAccountId("");
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });
  return {
    stmtError,
    refetchStatement,
    AdminDialog,
    cashAccounts,
    depositAmount,
    depositDate,
    depositEffectiveDate,
    depositMutation,
    depositNotes,
    depositOpen,
    editForm,
    editOpen,
    empError,
    empLoading,
    employee,
    employeeId,
    formatDate,
    isDeveloper,
    navigate,
    recalcMutation,
    recordChanges,
    setDepositAmount,
    setDepositDate,
    setDepositEffectiveDate,
    setDepositNotes,
    setDepositOpen,
    setEditForm,
    setEditOpen,
    setWithdrawAmount,
    setWithdrawCashAccountId,
    setWithdrawDate,
    setWithdrawNotes,
    setWithdrawOpen,
    statement,
    stmtLoading,
    updateMutation,
    withdrawAmount,
    withdrawCashAccountId,
    withdrawDate,
    withdrawMutation,
    withdrawNotes,
    withdrawOpen,
    wrapAdminAction,
  };
}
