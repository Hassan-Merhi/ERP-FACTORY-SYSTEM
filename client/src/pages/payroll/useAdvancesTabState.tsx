// Extracted from ./AdvancesTab.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Banknote, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { format } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { queryClient } from "@/lib/queryClient";
import { getApiRequest } from "@/lib/factoryApi";
import { useAppMode } from "@/contexts/AppModeContext";
import { useAuthenticatedUser } from "@/app/useAuthenticatedUser";
import type { Employee } from "@shared/schema";
import type { AccountOption } from "./payrollTypes";
import {
  type DeductionFormData,
  deductionSchema,
  type SalaryAdvance,
  type SalaryAdvanceFormData,
  salaryAdvanceSchema,
} from "./payrollSchemas";
import { calculateAdvanceStats } from "./advanceStats";
import type { WorkerDeductionFormData } from "./AddWorkerDeductionDialog";

export interface AdvancesTabProps {
  cashAccounts?: AccountOption[];
}

export function useAdvancesTabState({ cashAccounts = [] }: AdvancesTabProps) {
  const appMode = useAppMode();
  const { user } = useAuthenticatedUser();
  const recordChanges = useExistingRecordChangeAccess();
  const canCreateAdvance = recordChanges.canCreate("POST", "/api/salary-advances");
  const canReassignAdvance =
    recordChanges.allowed && ["Admin", "Owner", "Developer"].includes(user?.currentRole ?? user?.role ?? "");
  const modeApiRequest = getApiRequest(appMode);
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();

  const [advanceDialogOpen, setAdvanceDialogOpen] = useState(false);
  const [deductionDialogOpen, setDeductionDialogOpen] = useState(false);
  const [selectedAdvance, setSelectedAdvance] = useState<SalaryAdvance | null>(null);
  const [reassignTarget, setReassignTarget] = useState<SalaryAdvance | null>(null);
  const [showPaid, setShowPaid] = useState(false);
  const [workerFilter, setWorkerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [addWorkerDeductionDialogOpen, setAddWorkerDeductionDialogOpen] = useState(false);

  const { data: workerStaff = [] } = useQuery<Employee[]>({
    queryKey: ["/api/payroll/employees-with-balances", selectedCompany?.id],
    enabled: !!selectedCompany,
    select: (data) => data.filter((e) => e.employeeType === "Worker"),
  });

  const { data: salaryAdvances = [], isLoading: advancesLoading } = useQuery<SalaryAdvance[]>({
    queryKey: ["/api/salary-advances", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const { data: repayments = [], isLoading: repaymentsLoading } = useQuery<
    {
      id: number;
      workerName?: string;
      employeeId?: number;
      payrollMonth?: string;
      deductionAmount?: string;
      advanceRemaining?: string;
      createdAt?: string;
    }[]
  >({
    queryKey: ["/api/salary-advance-deductions", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const workerDeductionsBase =
    appMode === "factory" ? "/api/factory/worker-deductions" : "/api/payroll/worker-deductions";
  const { data: workerDeductions = [], isLoading: deductionsLoading } = useQuery<
    {
      id: number;
      workerId: number;
      workerName?: string;
      deductionDate?: string;
      reason?: string | null;
      amount?: string;
      applied?: boolean;
    }[]
  >({
    queryKey: [workerDeductionsBase, selectedCompany?.id],
    queryFn: async () => {
      if (!selectedCompany?.id) return [];
      const res = await fetch(`${workerDeductionsBase}?companyId=${selectedCompany.id}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch worker deductions");
      return res.json();
    },
    enabled: !!selectedCompany,
  });

  const advanceForm = useForm<SalaryAdvanceFormData>({
    resolver: zodResolver(salaryAdvanceSchema),
    defaultValues: {
      employeeId: "",
      amount: "",
      advanceDate: new Date(),
      notes: "",
      isOpeningBalance: false,
    },
  });

  const deductionForm = useForm<DeductionFormData>({
    resolver: zodResolver(deductionSchema),
    defaultValues: {
      deductionAmount: "",
      payrollMonth: format(new Date(), "yyyy-MM"),
    },
  });

  const addWorkerDeductionForm = useForm<WorkerDeductionFormData>({
    defaultValues: {
      workerId: "",
      amount: "",
      reason: "",
      deductionDate: new Date().toLocaleDateString("en-CA"),
    },
  });

  const advanceMutation = useMutation({
    mutationFn: async (data: SalaryAdvanceFormData) => {
      return await modeApiRequest("POST", "/api/salary-advances", {
        employeeId: parseInt(data.employeeId),
        amount: data.amount,
        advanceDate: format(data.advanceDate, "yyyy-MM-dd"),
        cashAccountId: data.isOpeningBalance ? undefined : parseInt(data.cashAccountId || "0"),
        notes: data.notes,
        isOpeningBalance: data.isOpeningBalance,
      });
    },
    onSuccess: () => {
      toast({ title: "Created", description: "Salary advance created successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advances", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
      setAdvanceDialogOpen(false);
      advanceForm.reset();
    },
    onError: (error: Error) => {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const deleteAdvanceMutation = useMutation({
    mutationFn: async (advanceId: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return await modeApiRequest("DELETE", `/api/salary-advances/${advanceId}`, undefined);
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Salary advance deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advances", selectedCompany?.id] });
    },
    onError: (error: Error) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  const deductionMutation = useMutation({
    mutationFn: async (data: DeductionFormData) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!selectedAdvance) throw new Error("No advance selected");
      return await modeApiRequest("POST", `/api/salary-advances/${selectedAdvance.id}/deduction`, data);
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "Deduction recorded successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advances", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advance-deductions", selectedCompany?.id] });
      setDeductionDialogOpen(false);
      deductionForm.reset();
      setSelectedAdvance(null);
    },
    onError: (error: Error) => {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const workerDeductionsWorkerBase = appMode === "factory" ? "/api/factory/workers" : "/api/payroll/workers";

  const addWorkerDeductionMutation = useMutation({
    mutationFn: async (data: { workerId: string; amount: string; reason: string; deductionDate: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return await modeApiRequest("POST", `${workerDeductionsWorkerBase}/${data.workerId}/deductions`, {
        amount: data.amount,
        reason: data.reason || null,
        deductionDate: data.deductionDate,
      });
    },
    onSuccess: () => {
      toast({ title: "Deduction added", description: "Worker deduction recorded successfully." });
      queryClient.invalidateQueries({ queryKey: [workerDeductionsBase, selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/employees-with-balances", selectedCompany?.id] });
      setAddWorkerDeductionDialogOpen(false);
      addWorkerDeductionForm.reset({
        workerId: "",
        amount: "",
        reason: "",
        deductionDate: new Date().toLocaleDateString("en-CA"),
      });
    },
    onError: (error: Error) => {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const deleteWorkerDeductionMutation = useMutation({
    mutationFn: async ({ workerId, deductionId }: { workerId: number; deductionId: number }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return await modeApiRequest(
        "DELETE",
        `${workerDeductionsWorkerBase}/${workerId}/deductions/${deductionId}`,
        undefined
      );
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Worker deduction deleted." });
      queryClient.invalidateQueries({ queryKey: [workerDeductionsBase, selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/employees-with-balances", selectedCompany?.id] });
    },
    onError: (error: Error) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });

  const stats = useMemo(() => calculateAdvanceStats(salaryAdvances), [salaryAdvances]);

  // Filtered list
  const filteredAdvances = useMemo(() => {
    return salaryAdvances.filter((a) => {
      const matchWorker = workerFilter === "all" || String(a.employeeId) === workerFilter;
      const matchStatus =
        statusFilter === "all" ||
        (statusFilter === "outstanding" && !a.fullyPaid) ||
        (statusFilter === "paid" && a.fullyPaid);
      return matchWorker && matchStatus;
    });
  }, [salaryAdvances, workerFilter, statusFilter]);

  const outstanding = filteredAdvances.filter((a) => !a.fullyPaid);
  const paid = filteredAdvances.filter((a) => a.fullyPaid);
  return {
    addWorkerDeductionDialogOpen,
    addWorkerDeductionForm,
    addWorkerDeductionMutation,
    advanceDialogOpen,
    advanceForm,
    advanceMutation,
    advancesLoading,
    canCreateAdvance,
    canReassignAdvance,
    cashAccounts,
    deductionDialogOpen,
    deductionForm,
    deductionMutation,
    deductionsLoading,
    deleteAdvanceMutation,
    deleteWorkerDeductionMutation,
    formatAmount,
    formatDisplayDate,
    modeApiRequest,
    outstanding,
    paid,
    reassignTarget,
    recordChanges,
    repayments,
    repaymentsLoading,
    selectedAdvance,
    selectedCompany,
    setAddWorkerDeductionDialogOpen,
    setAdvanceDialogOpen,
    setDeductionDialogOpen,
    setReassignTarget,
    setSelectedAdvance,
    setShowPaid,
    setStatusFilter,
    setWorkerFilter,
    showPaid,
    stats,
    statusFilter,
    workerDeductions,
    workerFilter,
    workerStaff,
  };
}

export function AdvancesTabSection({
  canCreateAdvance,
  setAdvanceDialogOpen,
  setStatusFilter,
  setWorkerFilter,
  statusFilter,
  workerFilter,
  workerStaff,
}: Pick<
  ReturnType<typeof useAdvancesTabState>,
  | "canCreateAdvance"
  | "setAdvanceDialogOpen"
  | "setStatusFilter"
  | "setWorkerFilter"
  | "statusFilter"
  | "workerFilter"
  | "workerStaff"
>) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Select value={workerFilter} onValueChange={setWorkerFilter}>
        <SelectTrigger className="w-44" data-testid="select-worker-filter">
          <SelectValue placeholder="All Workers" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Workers</SelectItem>
          {workerStaff.map((w) => (
            <SelectItem key={w.id} value={String(w.id)}>
              {w.firstName} {w.lastName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={statusFilter} onValueChange={setStatusFilter}>
        <SelectTrigger className="w-40" data-testid="select-status-filter">
          <SelectValue placeholder="All Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Status</SelectItem>
          <SelectItem value="outstanding">Outstanding</SelectItem>
          <SelectItem value="paid">Fully Paid</SelectItem>
        </SelectContent>
      </Select>

      {canCreateAdvance && (
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={() => setAdvanceDialogOpen(true)} data-testid="button-bulk-advance">
            <Banknote className="mr-2 h-4 w-4" />
            Bulk Advance
          </Button>
          <Button onClick={() => setAdvanceDialogOpen(true)} data-testid="button-create-advance">
            <Plus className="mr-2 h-4 w-4" />
            Add Advance
          </Button>
        </div>
      )}
    </div>
  );
}
