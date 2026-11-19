// Extracted from ./useERPRunPayrollModel.ts: state, queries and mutations for useERPRunPayrollModel.
import { searchAny } from "@shared/searchNormalization";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { usePayrollRunTab } from "@/pages/payroll/payrollTabs";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type {
  Employee,
  LedgerAccount,
  PayrollRun,
  PreviewItem,
  SalaryAdvance,
  WorkerDeductionRow,
  WorkerGroup,
} from "./types";

export function useERPRunPayrollStateModel() {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const { formatAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;

  const [activeTab, setActiveTab] = usePayrollRunTab(); // Run / History in ?tab=

  // ── Step 1: worker selection ──────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<number | string, boolean>>({});
  const [selectedWorkers, setSelectedWorkers] = useState<Set<number>>(new Set());

  // ── Step 2: preview / draft ───────────────────────────────────────────────
  const [step, setStep] = useState<1 | 2>(1);
  const [previewItems, setPreviewItems] = useState<PreviewItem[]>([]);
  const [previewDate, setPreviewDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [previewNotes, setPreviewNotes] = useState("");

  // ── History: pay dialog ───────────────────────────────────────────────────
  const [payDialogRun, setPayDialogRun] = useState<PayrollRun | null>(null);
  const [payAccountId, setPayAccountId] = useState("");
  const [deleteRunId, setDeleteRunId] = useState<number | null>(null);
  const [undoRunId, setUndoRunId] = useState<number | null>(null);

  // ── Queries ───────────────────────────────────────────────────────────────
  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";

  const { data: allEmployees, isLoading: empLoading } = useQuery<Employee[]>({
    queryKey: ["/api/employees", companyId],
  });

  const { data: workerGroupsRaw = [], isLoading: groupsLoading } = useQuery<WorkerGroup[]>({
    queryKey: ["/api/worker-groups/with-members", companyId],
    queryFn: async () => {
      const res = await fetch("/api/worker-groups/with-members", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", companyId],
    queryFn: async () => {
      const res = await fetch("/api/ledger-accounts", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: salaryAdvances = [] } = useQuery<SalaryAdvance[]>({
    queryKey: ["/api/salary-advances", companyId],
    queryFn: async () => {
      const res = await fetch("/api/salary-advances", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: workerDeductionsRaw = [] } = useQuery<WorkerDeductionRow[]>({
    queryKey: ["/api/payroll/worker-deductions", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/payroll/worker-deductions?companyId=${companyId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!companyId,
  });

  const { data: payrollRuns = [], isLoading: runsLoading } = useQuery<PayrollRun[]>({
    queryKey: ["/api/payroll/runs", companyId],
    queryFn: async () => {
      if (!companyId) return [];
      const res = await fetch(`/api/payroll/runs?companyId=${companyId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!companyId,
  });

  const cashAccounts = useMemo(() => ledgerAccounts.filter((a) => a.accountType === "Cash"), [ledgerAccounts]);
  const workers = useMemo(
    () => (allEmployees || []).filter((e) => e.employeeType === "Worker" && e.active),
    [allEmployees]
  );
  const workerGroups = useMemo(
    () =>
      workerGroupsRaw.filter((g) => {
        const t = g.groupType || g.group_type;
        return !t || t === "Worker";
      }),
    [workerGroupsRaw]
  );

  const advanceBalanceByEmployee = useMemo(() => {
    const map: Record<number, number> = {};
    for (const adv of salaryAdvances) {
      if (!adv.fullyPaid) {
        const bal = parseFloat(adv.remainingBalance || "0");
        if (bal > 0) map[adv.employeeId] = (map[adv.employeeId] || 0) + bal;
      }
    }
    return map;
  }, [salaryAdvances]);

  const pendingDeductionsByEmployee = useMemo(() => {
    const map: Record<number, number> = {};
    for (const d of workerDeductionsRaw) {
      if (!d.applied) {
        map[d.workerId] = (map[d.workerId] || 0) + parseFloat(d.amount || "0");
      }
    }
    return map;
  }, [workerDeductionsRaw]);

  const workerMemberships = useMemo(() => {
    const map: Record<number, number[]> = {};
    for (const g of workerGroups)
      for (const m of g.members || []) {
        if (!map[m.id]) map[m.id] = [];
        map[m.id].push(g.id);
      }
    return map;
  }, [workerGroups]);

  const ungroupedWorkers = useMemo(
    () => workers.filter((w) => !workerMemberships[w.id]?.length),
    [workers, workerMemberships]
  );

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return new Set(workers.map((w) => w.id));
    return new Set(
      workers
        .filter((w) => searchAny(searchQuery, `${w.firstName} ${w.lastName}`, w.code, w.department))
        .map((w) => w.id)
    );
  }, [workers, searchQuery]);

  const workerById = useMemo(() => {
    const map: Record<number, Employee> = {};
    for (const w of workers) map[w.id] = w;
    return map;
  }, [workers]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function toggleGroup(key: number | string) {
    setExpandedGroups((p) => ({ ...p, [key]: !(p[key] ?? true) }));
  }
  function toggleWorker(id: number) {
    setSelectedWorkers((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleGroupSelection(memberIds: number[]) {
    const visible = memberIds.filter((id) => filtered.has(id));
    const allSel = visible.every((id) => selectedWorkers.has(id));
    setSelectedWorkers((p) => {
      const n = new Set(p);
      if (allSel) visible.forEach((id) => n.delete(id));
      else visible.forEach((id) => n.add(id));
      return n;
    });
  }

  function enterPreview() {
    const items: PreviewItem[] = [];
    // A worker can belong to more than one worker group. Payroll is per employee,
    // so never add the same employee twice just because they have multiple memberships.
    const addedEmployeeIds = new Set<number>();
    function addGroup(label: string, memberIds: number[]) {
      for (const id of memberIds) {
        if (!selectedWorkers.has(id) || !workerById[id] || addedEmployeeIds.has(id)) continue;
        addedEmployeeIds.add(id);
        const w = workerById[id];
        const salary = parseFloat(w.monthlySalary || "0");
        const deduction = Math.min(advanceBalanceByEmployee[id] || 0, salary);
        const pendingDeductions = pendingDeductionsByEmployee[id] || 0;
        items.push({
          employeeId: id,
          employeeName: `${w.firstName} ${w.lastName}`.trim(),
          groupName: label,
          baseSalary: salary,
          deduction,
          pendingDeductions,
          netPay: Math.max(0, salary - deduction - pendingDeductions),
        });
      }
    }
    for (const g of workerGroups)
      addGroup(
        g.name,
        (g.members || []).map((m) => m.id)
      );
    if (ungroupedWorkers.length > 0)
      addGroup(
        "Ungrouped",
        ungroupedWorkers.map((w) => w.id)
      );
    setPreviewItems(items);
    setPreviewNotes("");
    setStep(2);
  }

  function updateDeduction(idx: number, val: string) {
    setPreviewItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it;
        const ded = Math.max(0, parseFloat(val) || 0);
        return { ...it, deduction: ded, netPay: Math.max(0, it.baseSalary - ded - it.pendingDeductions) };
      })
    );
  }

  // ── Mutations ─────────────────────────────────────────────────────────────
  const saveDraftMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/payroll/runs", {
        date: previewDate,
        notes: previewNotes || undefined,
        items: previewItems.map((it) => ({
          employeeId: it.employeeId,
          employeeName: it.employeeName,
          groupName: it.groupName,
          baseSalary: it.baseSalary.toFixed(2),
          deduction: it.deduction.toFixed(2),
          payrollDeduction: it.pendingDeductions.toFixed(2),
          netPay: it.netPay.toFixed(2),
        })),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save draft");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs"] });
      toast({ title: "Draft saved", description: "Payroll saved as draft. Go to History to pay it." });
      setStep(1);
      setSelectedWorkers(new Set());
      setPreviewItems([]);
      setActiveTab("history");
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  return {
    toast,
    recordChanges,
    formatAmount,
    selectedCompany,
    activeTab,
    setActiveTab,
    searchQuery,
    setSearchQuery,
    expandedGroups,
    selectedWorkers,
    setSelectedWorkers,
    step,
    setStep,
    previewItems,
    setPreviewItems,
    previewDate,
    setPreviewDate,
    previewNotes,
    setPreviewNotes,
    payDialogRun,
    setPayDialogRun,
    payAccountId,
    setPayAccountId,
    deleteRunId,
    setDeleteRunId,
    undoRunId,
    setUndoRunId,
    isDeveloper,
    empLoading,
    groupsLoading,
    payrollRuns,
    runsLoading,
    cashAccounts,
    workers,
    workerGroups,
    advanceBalanceByEmployee,
    ungroupedWorkers,
    filtered,
    workerById,
    toggleGroup,
    toggleWorker,
    toggleGroupSelection,
    enterPreview,
    updateDeduction,
    saveDraftMutation,
  };
}
