import { useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import type { Employee } from "@shared/schema";
import { usePayrollState } from "./usePayrollState";
import { usePayrollData } from "./usePayrollData";
import { cleanTxnDesc, decodeLocationOption, errorMessage } from "./payrollUtils";
import type { BaleRateResponse, SalesPreview } from "./payrollTypes";
import {
  depositSchema,
  withdrawalSchema,
  bulkPaymentSchema,
  getThisMonthRange,
  type DepositFormData,
  type WithdrawalFormData,
  type BulkPaymentFormData,
  type EmployeeFormData,
  type WorkerFormData,
} from "./payrollSchemas";

export function usePayrollModel() {
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { toast } = useToast();
  const { selectedCompany, companies } = useCompany();
  const showError = (error: unknown) =>
    toast({ title: "Error", description: errorMessage(error), variant: "destructive" });

  const state = usePayrollState();
  const {
    empSearch,
    empStatusFilter,
    setDepositDialogOpen,
    setBonusDialogOpen,
    bonusTab,
    setBonusTab,
    bonusSalesPeriod,
    setBonusSalesPeriod,
    bonusSalesLocationId,
    setBonusSalesLocationId,
    bonusSalesStart,
    setBonusSalesStart,
    bonusSalesEnd,
    setBonusSalesEnd,
    bonusSalesPreview,
    setBonusSalesPreview,
    setBonusSalesLoading,
    bonusSalesCustomPct,
    setBonusSalesCustomPct,
    bonusDate,
    setBonusDate,
    bonusNotes,
    setBonusNotes,
    balesRows,
    setBalesRows,
    balesPeriod,
    setBalesPeriod,
    balesStart,
    balesEnd,
    setWithdrawalDialogOpen,
    setBulkPaymentDialogOpen,
    selectedEmployee,
    setSelectedEmployee,
    setNewWorkerDialogOpen,
    setEditWorkerDialogOpen,
    selectedWorkerForEdit,
    workerOverrides,
    setWorkerOverrides,
    setCreateEmployeeDialogOpen,
    deleteConflict,
    setDeleteConflict,
    deleteWorkerConflict,
    setDeleteWorkerConflict,
    statementEmployee,
    setStatementExpanded,
    setEditEmployeeDialogOpen,
    editingEmployee,
    setEditingEmployee,
    workerDeductionTarget,
    setWorkerDeductionTarget,
    workerDeductionAmount,
    setWorkerDeductionAmount,
    workerDeductionReason,
    setWorkerDeductionReason,
    workerDeductionDate,
    bulkDepositSelections,
    setBulkDepositSelections,
    setBulkDepositDialogOpen,
    bulkDepositDate,
    bulkDepositNotes,
    editBaleRates,
    setEditBaleRates,
    editBalePctRates,
    setEditBalePctRates,
    bulkBonusAutoMonth,
    bulkBonusAutoStart,
    bulkBonusAutoEnd,
    setBulkBonusAutoLoading,
    bulkBonusAutoPctLocationId,
    setBulkBonusDialogOpen,
    bulkBonusDate,
    bulkBonusNotes,
    bulkBonusAmounts,
    setBulkBonusAmounts,
    bulkBonusBreakdowns,
    setBulkBonusBreakdowns,
    setBulkBonusStep,
    pendingBonuses,
    setPendingBonuses,
    setBulkWithdrawalDialogOpen,
    bulkWithdrawalDate,
    bulkWithdrawalNotes,
    bulkWithdrawalAmounts,
    setBulkWithdrawalAmounts,
    bulkWithdrawalAccountType,
    bulkWithdrawalAccountId,
    newGroupName,
    setNewGroupName,
    newGroupDescription,
    setNewGroupDescription,
    setCreateGroupDialogOpen,
    selectedGroupForMembers,
  } = state;

  const data = usePayrollData({
    selectedCompany,
    companies,
    statementEmployee,
    workerOverrides,
    empSearch,
    empStatusFilter,
  });
  const { locations, allCompanyLocations, employeeStaff, workerPayments, selectedPayments } = data;

  // Forms
  const depositForm = useForm<DepositFormData>({ resolver: zodResolver(depositSchema) });
  const withdrawalForm = useForm<WithdrawalFormData>({ resolver: zodResolver(withdrawalSchema) });
  const bulkPaymentForm = useForm<BulkPaymentFormData>({ resolver: zodResolver(bulkPaymentSchema) });
  const newWorkerForm = useForm<WorkerFormData>();
  const editWorkerForm = useForm<WorkerFormData>();

  // Pre-populate edit worker form when a worker is selected for editing
  useEffect(() => {
    if (selectedWorkerForEdit) {
      editWorkerForm.reset({
        firstName: selectedWorkerForEdit.firstName ?? "",
        lastName: selectedWorkerForEdit.lastName ?? "",
        code: selectedWorkerForEdit.code ?? "",
        monthlySalary: selectedWorkerForEdit.monthlySalary ?? "",
        department: selectedWorkerForEdit.department ?? "",
        active: selectedWorkerForEdit.active ?? true,
      });
    }
  }, [editWorkerForm, selectedWorkerForEdit]);
  const createEmployeeForm = useForm<EmployeeFormData>();
  const editEmployeeForm = useForm<EmployeeFormData>();

  // Reset statementExpanded whenever a new employee statement is opened
  useEffect(() => {
    if (statementEmployee) setStatementExpanded(false);
  }, [setStatementExpanded, statementEmployee]);

  // Pre-populate edit employee form + load bale rates when editingEmployee changes
  useEffect(() => {
    if (!editingEmployee) return;
    const employeeGroupId = (editingEmployee as Employee & { employeeGroupId?: number | null }).employeeGroupId;
    editEmployeeForm.reset({
      firstName: editingEmployee.firstName || "",
      lastName: editingEmployee.lastName || "",
      code: editingEmployee.code || "",
      monthlySalary: editingEmployee.monthlySalary || "",
      employeeGroupId: employeeGroupId ? String(employeeGroupId) : "",
      salesBonusPct: editingEmployee.salesBonusPct ? String(editingEmployee.salesBonusPct) : "",
      salesBonusPctLocationId: editingEmployee.salesBonusPctLocationId
        ? String(editingEmployee.salesBonusPctLocationId)
        : "",
      salesBonusPctSourceCompanyId: editingEmployee.salesBonusPctSourceCompanyId
        ? String(editingEmployee.salesBonusPctSourceCompanyId)
        : "",
    });
    // Load bale rates
    fetch(`/api/employees/${editingEmployee.id}/bale-rates`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: BaleRateResponse[]) =>
        setEditBaleRates(
          data.map((r) => ({
            locationId: String(r.locationId),
            rate: String(r.rate),
            sourceCompanyId: r.sourceCompanyId ? String(r.sourceCompanyId) : "",
          }))
        )
      )
      .catch(() => setEditBaleRates([]));
    // Load pct rates
    fetch(`/api/employees/${editingEmployee.id}/bale-pct-rates`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: BaleRateResponse[]) =>
        setEditBalePctRates(
          data.map((r) => ({
            locationId: String(r.locationId),
            pct: String(r.pct),
            sourceCompanyId: r.sourceCompanyId ? String(r.sourceCompanyId) : "",
          }))
        )
      )
      .catch(() => setEditBalePctRates([]));
  }, [editEmployeeForm, editingEmployee, setEditBalePctRates, setEditBaleRates]);

  // Mutations (Logic simplified for orchestrator)
  const depositMutation = useMutation({
    mutationFn: async (data: DepositFormData) => {
      if (!selectedEmployee) throw new Error("No employee selected");
      return await modeApiRequest("POST", "/api/payroll/deposit-employee", {
        employeeId: selectedEmployee.id,
        amount: data.amount,
        date: data.date,
        notes: data.notes || "",
      });
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Deposit recorded successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/employee", selectedEmployee?.id] });
      setDepositDialogOpen(false);
      depositForm.reset();
    },
  });

  const withdrawalMutation = useMutation({
    mutationFn: async (data: WithdrawalFormData) => {
      if (!selectedEmployee) throw new Error("No employee selected");
      return await modeApiRequest("POST", "/api/payroll/withdraw-employee", {
        employeeId: selectedEmployee.id,
        amount: data.amount,
        paymentAccountType: data.paymentAccountType,
        paymentAccountId: data.paymentAccountId,
        date: data.date,
        notes: data.notes || "",
      });
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Withdrawal recorded successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/employee", selectedEmployee?.id] });
      setWithdrawalDialogOpen(false);
      withdrawalForm.reset();
    },
  });

  // Handlers
  const handleDeposit = (emp: Employee) => {
    setSelectedEmployee(emp);
    depositForm.reset({ amount: emp.monthlySalary || "", date: new Date().toLocaleDateString("en-CA"), notes: "" });
    setDepositDialogOpen(true);
  };

  const handleWithdrawal = (emp: Employee) => {
    setSelectedEmployee(emp);
    withdrawalForm.reset({
      amount: "",
      paymentAccountType: "cash",
      paymentAccountId: "",
      date: new Date().toLocaleDateString("en-CA"),
      notes: "",
    });
    setWithdrawalDialogOpen(true);
  };

  const handleBonus = (emp: Employee) => {
    setSelectedEmployee(emp);
    setBonusTab("sales");
    setBonusSalesPreview(null);
    setBonusSalesCustomPct(emp.salesBonusPct ? String(emp.salesBonusPct) : "");
    setBonusSalesLocationId(emp.salesBonusPctLocationId ? String(emp.salesBonusPctLocationId) : "");
    setBonusSalesPeriod("thisMonth");
    setBonusSalesStart("");
    setBonusSalesEnd("");
    setBalesRows([
      {
        locationId: "",
        sourceCompanyId: "",
        qty: "",
        rate: emp.balesBonusRate != null ? String(emp.balesBonusRate) : "",
        preview: null,
        loading: false,
      },
    ]);
    setBalesPeriod("thisMonth");
    setBonusDate(new Date().toLocaleDateString("en-CA"));
    setBonusNotes("");
    setBonusDialogOpen(true);
  };

  const fetchSalesPreview = async () => {
    if (!bonusSalesLocationId) return;
    setBonusSalesLoading(true);
    setBonusSalesPreview(null);
    try {
      const range =
        bonusSalesPeriod === "thisMonth" ? getThisMonthRange() : { start: bonusSalesStart, end: bonusSalesEnd };
      const { locationId, sourceCompanyId } = decodeLocationOption(bonusSalesLocationId);
      const sourceParam = sourceCompanyId ? `&sourceCompanyId=${sourceCompanyId}` : "";
      const res = await fetch(
        `/api/payroll/sales-summary?locationId=${locationId}&startDate=${range.start}&endDate=${range.end}${sourceParam}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as SalesPreview;
      setBonusSalesPreview(data);
    } catch (error: unknown) {
      showError(error);
    } finally {
      setBonusSalesLoading(false);
    }
  };

  const fetchBalesQty = async (idx: number) => {
    const row = balesRows[idx];
    if (!row.locationId) return;
    setBalesRows((previous) => previous.map((row, index) => (index === idx ? { ...row, loading: true } : row)));
    try {
      const range = balesPeriod === "thisMonth" ? getThisMonthRange() : { start: balesStart, end: balesEnd };
      const sourceParam = row.sourceCompanyId ? `&sourceCompanyId=${row.sourceCompanyId}` : "";
      const res = await fetch(
        `/api/payroll/sales-summary?locationId=${row.locationId}&startDate=${range.start}&endDate=${range.end}${sourceParam}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as SalesPreview;
      setBalesRows((previous) =>
        previous.map((row, index) => (index === idx ? { ...row, qty: data.totalQuantity, loading: false } : row))
      );
    } catch (error: unknown) {
      setBalesRows((previous) => previous.map((row, index) => (index === idx ? { ...row, loading: false } : row)));
      toast({ title: "Error fetching qty", description: errorMessage(error), variant: "destructive" });
    }
  };

  const getBonusAmount = (): number => {
    if (bonusTab === "sales") {
      if (!bonusSalesPreview) return 0;
      return (parseFloat(bonusSalesPreview.totalSalesAmount || "0") * parseFloat(bonusSalesCustomPct || "0")) / 100;
    } else {
      return balesRows.reduce((sum, row) => sum + parseFloat(row.qty || "0") * parseFloat(row.rate || "0"), 0);
    }
  };

  const saveBonusToPending = () => {
    if (!selectedEmployee) return;
    const amount = getBonusAmount();
    if (amount <= 0) return;
    const descParts: string[] = [];
    if (bonusTab === "sales" && bonusSalesPreview) {
      descParts.push(`Sales bonus ${bonusSalesCustomPct}% on ${bonusSalesPreview.locationName}`);
    } else {
      balesRows
        .filter((row) => parseFloat(row.qty || "0") > 0 && parseFloat(row.rate || "0") > 0)
        .forEach((row) => {
          const loc =
            locations.find((location) => location.id === parseInt(row.locationId)) ??
            allCompanyLocations.find((location) => location.id === parseInt(row.locationId));
          descParts.push(`${parseFloat(row.qty)} bales @ ${row.rate} (${loc?.name ?? row.locationId})`);
        });
    }
    setPendingBonuses((previous) => ({
      ...previous,
      [selectedEmployee.id]: {
        amount,
        description: descParts.join(", ") || "Bonus",
        employeeName: `${selectedEmployee.firstName} ${selectedEmployee.lastName}`,
      },
    }));
    setBonusDialogOpen(false);
    toast({
      title: "Saved to bulk",
      description: `Bonus of ${amount.toFixed(2)} saved for ${selectedEmployee.firstName}`,
    });
  };

  const bonusMutation = useMutation({
    mutationFn: async ({ employeeId, amount }: { employeeId: number; amount: number }) => {
      return await modeApiRequest("POST", "/api/payroll/bonus-employee", {
        employeeId,
        amount: amount.toFixed(2),
        date: bonusDate,
        notes: bonusNotes || "",
      });
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Bonus recorded successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      if (selectedEmployee)
        queryClient.invalidateQueries({ queryKey: ["/api/accounts/employee", selectedEmployee.id] });
      setBonusDialogOpen(false);
    },
    onError: showError,
  });

  const submitSmartBonus = () => {
    if (!selectedEmployee) return;
    const amount = getBonusAmount();
    if (amount <= 0) return;
    bonusMutation.mutate({ employeeId: selectedEmployee.id, amount });
  };

  // ── Bulk deposit helpers ─────────────────────────────────────────────────
  const handleSelectAllEmployees = (checked: boolean | "indeterminate") => {
    if (checked) {
      const all: Record<number, boolean> = {};
      employeeStaff.forEach((e) => {
        all[e.id] = true;
      });
      setBulkDepositSelections(all);
    } else {
      setBulkDepositSelections({});
    }
  };

  const handleToggleEmployeeDeposit = (id: number) => {
    setBulkDepositSelections((prev: Record<number, boolean>) => ({ ...prev, [id]: !prev[id] }));
  };

  const validSelectedEmployees = useMemo(
    () => employeeStaff.filter((e) => bulkDepositSelections[e.id] && parseFloat(e.monthlySalary || "0") > 0),
    [employeeStaff, bulkDepositSelections]
  );

  const bulkDepositTotal = useMemo(
    () => validSelectedEmployees.reduce((s, e) => s + parseFloat(e.monthlySalary || "0"), 0),
    [validSelectedEmployees]
  );

  const bulkDepositMutation = useMutation({
    mutationFn: async () => {
      const deposits = validSelectedEmployees.map((e) => ({ employeeId: e.id, amount: e.monthlySalary }));
      return modeApiRequest("POST", "/api/payroll/bulk-deposit-employees", {
        deposits,
        date: bulkDepositDate,
        notes: bulkDepositNotes || "",
      });
    },
    onSuccess: () => {
      toast({ title: "Success", description: `Deposited salary for ${validSelectedEmployees.length} employees` });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setBulkDepositDialogOpen(false);
      setBulkDepositSelections({});
    },
    onError: showError,
  });

  const bulkWithdrawalMutation = useMutation({
    mutationFn: async () => {
      const withdrawals = Object.entries(bulkWithdrawalAmounts)
        .filter(([, amt]) => parseFloat(amt) > 0)
        .map(([empId, amount]) => ({ employeeId: parseInt(empId), amount }));
      return modeApiRequest("POST", "/api/payroll/bulk-withdraw-employees", {
        withdrawals,
        date: bulkWithdrawalDate,
        notes: bulkWithdrawalNotes || "",
        paymentAccountType: bulkWithdrawalAccountType,
        paymentAccountId: bulkWithdrawalAccountId,
      });
    },
    onSuccess: () => {
      const count = Object.values(bulkWithdrawalAmounts).filter((amt) => parseFloat(amt) > 0).length;
      toast({ title: "Success", description: `Processed withdrawals for ${count} employees` });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setBulkWithdrawalDialogOpen(false);
      setBulkWithdrawalAmounts({});
    },
    onError: showError,
  });

  const bulkBonusMutation = useMutation({
    mutationFn: async () => {
      const bonuses = Object.entries(bulkBonusAmounts)
        .filter(([, amt]) => parseFloat(amt) > 0)
        .map(([empId, amount]) => ({ employeeId: parseInt(empId), amount }));
      return modeApiRequest("POST", "/api/payroll/bulk-bonus-employees", {
        bonuses,
        date: bulkBonusDate,
        notes: bulkBonusNotes || "",
      });
    },
    onSuccess: () => {
      const count = Object.values(bulkBonusAmounts).filter((amt) => parseFloat(amt) > 0).length;
      toast({ title: "Success", description: `Bonus deposited for ${count} employees` });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setBulkBonusDialogOpen(false);
      setBulkBonusAmounts({});
      setBulkBonusBreakdowns({});
      setPendingBonuses({});
      setBulkBonusStep("edit");
    },
    onError: showError,
  });

  const bulkPaymentMutation = useMutation({
    mutationFn: async (data: BulkPaymentFormData) => {
      const payments = selectedPayments.map((w) => ({
        workerId: w.id,
        amount: workerPayments[w.id]?.amount || "0",
      }));
      return modeApiRequest("POST", "/api/payroll/bulk-pay-workers", {
        payments,
        paymentAccountType: data.paymentAccountType,
        paymentAccountId: data.paymentAccountId,
        date: data.date,
        notes: data.notes || "",
      });
    },
    onSuccess: () => {
      toast({ title: "Success", description: `Paid ${selectedPayments.length} workers` });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setBulkPaymentDialogOpen(false);
      bulkPaymentForm.reset();
      setWorkerOverrides({});
    },
    onError: showError,
  });

  const autoCalculateBonuses = async () => {
    setBulkBonusAutoLoading(true);
    try {
      const range =
        bulkBonusAutoMonth === "thisMonth" ? getThisMonthRange() : { start: bulkBonusAutoStart, end: bulkBonusAutoEnd };

      // The picker stores "locationId:companyId" so the % bonus is computed from
      // the sales of the company that sells at the location, which is not always
      // the company that owns the location row (GC-LSHI).
      const { locationId: pctLocationId, sourceCompanyId: pctSourceCompanyId } =
        decodeLocationOption(bulkBonusAutoPctLocationId);
      const res = await modeApiRequest("POST", "/api/payroll/auto-calculate-bonuses", {
        startDate: range.start,
        endDate: range.end,
        pctLocationId: pctLocationId || null,
        pctSourceCompanyId: pctSourceCompanyId || null,
      });
      const { results } = (await res.json()) as {
        results: Array<{ employeeId: number; amount: string; breakdown: string[] }>;
      };

      const amounts: Record<number, string> = { ...bulkBonusAmounts };
      const breakdowns: Record<number, string[]> = { ...bulkBonusBreakdowns };

      for (const r of results) {
        if (parseFloat(r.amount) > 0) {
          amounts[r.employeeId] = r.amount;
          breakdowns[r.employeeId] = r.breakdown;
        }
      }

      setBulkBonusAmounts(amounts);
      setBulkBonusBreakdowns(breakdowns);
      const calculatedCount = results.filter((r) => parseFloat(r.amount) > 0).length;
      if (calculatedCount === 0) {
        toast({
          title: "Nothing calculated",
          description:
            "No sales found for the configured locations in this date range. Check the date range, the saved bonus rates, and the Sales % location selection.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Done",
          description: `Bonuses calculated for ${calculatedCount} employee${calculatedCount !== 1 ? "s" : ""}`,
        });
      }
    } catch (error: unknown) {
      showError(error);
    } finally {
      setBulkBonusAutoLoading(false);
    }
  };

  const handlePrintBulkBonus = () => {
    const rows = employeeStaff
      .filter((emp) => parseFloat(bulkBonusAmounts[emp.id] || "0") > 0)
      .map((emp) => {
        const pending = pendingBonuses[emp.id];
        const amount = parseFloat(bulkBonusAmounts[emp.id] || "0");
        return `${emp.firstName} ${emp.lastName}: $${amount.toFixed(2)}${pending?.description ? ` — ${pending.description}` : ""}`;
      });
    const total = employeeStaff.reduce((s, e) => s + parseFloat(bulkBonusAmounts[e.id] || "0"), 0);
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`
      <html><head><title>Bulk Bonus — ${bulkBonusDate}</title>
      <style>body{font-family:sans-serif;padding:24px}h2{margin-bottom:8px}ul{list-style:none;padding:0}li{padding:6px 0;border-bottom:1px solid #eee}.total{font-weight:bold;margin-top:12px}</style>
      </head><body>
      <h2>Bulk Bonus Deposit</h2>
      <p>Date: ${bulkBonusDate}${bulkBonusNotes ? ` &nbsp;·&nbsp; ${bulkBonusNotes}` : ""}</p>
      <ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul>
      <p class="total">Total: $${total.toFixed(2)}</p>
      </body></html>
    `);
    win.document.close();
    win.print();
  };

  const handleDeleteEmployee = (emp: Employee) => {
    if (confirm(`Are you sure you want to delete ${emp.firstName}?`)) {
      modeApiRequest("DELETE", `/api/employees/${emp.id}`, undefined)
        .then(() => {
          toast({ title: "Deleted", description: "Employee deleted" });
          queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
        })
        .catch(showError);
    }
  };

  const handleForceDeleteEmployee = () => {
    if (!deleteConflict) return;
    modeApiRequest("DELETE", `/api/employees/${deleteConflict.employee.id}?force=true`, undefined)
      .then(() => {
        toast({ title: "Deleted", description: "Employee force-deleted" });
        queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
        setDeleteConflict(null);
      })
      .catch(showError);
  };

  const editEmployeeMutation = useMutation({
    mutationFn: async (data: EmployeeFormData) => {
      if (!editingEmployee) throw new Error("No employee selected");
      await modeApiRequest("PATCH", `/api/employees/${editingEmployee.id}`, data);
      // Save bale rates
      await fetch(`/api/employees/${editingEmployee.id}/bale-rates`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(
          editBaleRates
            .filter((r) => r.locationId && r.rate)
            .map((r) => ({
              locationId: parseInt(r.locationId),
              rate: parseFloat(r.rate),
              sourceCompanyId: r.sourceCompanyId ? parseInt(r.sourceCompanyId) : null,
            }))
        ),
      });
      // Save pct rates
      await fetch(`/api/employees/${editingEmployee.id}/bale-pct-rates`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(
          editBalePctRates
            .filter((r) => r.locationId && r.pct)
            .map((r) => ({
              locationId: parseInt(r.locationId),
              pct: parseFloat(r.pct),
              sourceCompanyId: r.sourceCompanyId ? parseInt(r.sourceCompanyId) : null,
            }))
        ),
      });
    },
    onSuccess: () => {
      toast({ title: "Employee updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setEditEmployeeDialogOpen(false);
      setEditingEmployee(null);
    },
    onError: showError,
  });

  const createEmployeeMutation = useMutation({
    mutationFn: async (data: EmployeeFormData) =>
      modeApiRequest("POST", "/api/employees", {
        ...data,
        companyId: selectedCompany?.id,
        employeeType: "Employee",
      }),
    onSuccess: () => {
      toast({ title: "Employee created" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setCreateEmployeeDialogOpen(false);
      createEmployeeForm.reset();
    },
    onError: showError,
  });

  const createGroupMutation = useMutation({
    mutationFn: async () =>
      modeApiRequest("POST", "/api/employee-groups", {
        name: newGroupName,
        description: newGroupDescription,
        companyId: selectedCompany?.id,
      }),
    onSuccess: () => {
      toast({ title: "Group created" });
      queryClient.invalidateQueries({ queryKey: ["/api/employee-groups", selectedCompany?.id] });
      setCreateGroupDialogOpen(false);
      setNewGroupName("");
      setNewGroupDescription("");
    },
    onError: showError,
  });

  const { data: groupMembers = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employee-groups", selectedGroupForMembers?.id, "members"],
    queryFn: async () => {
      if (!selectedGroupForMembers) return [];
      const res = await fetch(`/api/employee-groups/${selectedGroupForMembers.id}/members`, {
        credentials: "include",
      });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedGroupForMembers,
  });

  const addWorkerToGroupMutation = useMutation({
    mutationFn: async ({ groupId, employeeId }: { groupId: number; employeeId: number }) =>
      modeApiRequest("POST", `/api/employee-groups/${groupId}/members/${employeeId}`, undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/employee-groups", selectedGroupForMembers?.id, "members"],
      });
    },
    onError: showError,
  });

  const removeWorkerFromGroupMutation = useMutation({
    mutationFn: async ({ groupId, employeeId }: { groupId: number; employeeId: number }) =>
      modeApiRequest("DELETE", `/api/employee-groups/${groupId}/members/${employeeId}`, undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/employee-groups", selectedGroupForMembers?.id, "members"],
      });
    },
    onError: showError,
  });

  // Worker tab handlers
  const handleToggleWorker = (id: number) => {
    setWorkerOverrides((previous) => ({
      ...previous,
      [id]: { ...previous[id], selected: !previous[id]?.selected },
    }));
  };

  const handleUpdateAmount = (id: number, val: string) => {
    setWorkerOverrides((previous) => ({
      ...previous,
      [id]: { ...previous[id], amount: val, manuallyEdited: true },
    }));
  };

  const handleDeleteWorker = (worker: Employee) => {
    if (confirm(`Delete worker ${worker.firstName} ${worker.lastName}?`)) {
      modeApiRequest("DELETE", `/api/employees/${worker.id}`, undefined)
        .then(() => {
          toast({ title: "Deleted", description: "Worker deleted" });
          queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
        })
        .catch(showError);
    }
  };

  const createWorkerMutation = useMutation({
    mutationFn: async (data: WorkerFormData & { joinDate?: string }) =>
      modeApiRequest("POST", "/api/employees", {
        ...data,
        companyId: selectedCompany?.id,
        employeeType: "Worker",
        joinDate: data.joinDate || new Date().toLocaleDateString("en-CA"),
      }),
    onSuccess: () => {
      toast({ title: "Worker created" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setNewWorkerDialogOpen(false);
      newWorkerForm.reset();
    },
    onError: showError,
  });

  const updateWorkerMutation = useMutation({
    mutationFn: async (data: WorkerFormData) => {
      if (!selectedWorkerForEdit) throw new Error("No worker selected");
      return modeApiRequest("PATCH", `/api/employees/${selectedWorkerForEdit.id}`, data);
    },
    onSuccess: () => {
      toast({ title: "Worker updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setEditWorkerDialogOpen(false);
    },
    onError: showError,
  });

  const handleForceDeleteWorker = () => {
    if (!deleteWorkerConflict) return;
    modeApiRequest("DELETE", `/api/employees/${deleteWorkerConflict.employee.id}?force=true`, undefined)
      .then(() => {
        toast({ title: "Deleted", description: "Worker force-deleted" });
        queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
        setDeleteWorkerConflict(null);
      })
      .catch(showError);
  };

  const deleteWorkerGroupMutation = useMutation({
    mutationFn: async (groupId: number) => modeApiRequest("DELETE", `/api/worker-groups/${groupId}`, undefined),
    onSuccess: () => {
      toast({ title: "Group deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/worker-groups/with-members", selectedCompany?.id] });
    },
  });

  const addWorkerToWorkerGroupMutation = useMutation({
    mutationFn: async ({ groupId, workerId }: { groupId: number; workerId: number }) =>
      modeApiRequest("POST", `/api/worker-groups/${groupId}/members/${workerId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/worker-groups/with-members", selectedCompany?.id] });
    },
  });

  const removeWorkerFromWorkerGroupMutation = useMutation({
    mutationFn: async ({ groupId, workerId }: { groupId: number; workerId: number }) =>
      modeApiRequest("DELETE", `/api/worker-groups/${groupId}/members/${workerId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/worker-groups/with-members", selectedCompany?.id] });
    },
  });

  const workerDeductionMutation = useMutation({
    mutationFn: async () => {
      if (!workerDeductionTarget) throw new Error("No worker selected");
      return await modeApiRequest("POST", `/api/factory/workers/${workerDeductionTarget.id}/deductions`, {
        amount: workerDeductionAmount,
        reason: workerDeductionReason || null,
        deductionDate: workerDeductionDate,
      });
    },
    onSuccess: () => {
      toast({ title: "Deduction added", description: "Pending deduction saved." });
      setWorkerDeductionTarget(null);
      setWorkerDeductionAmount("");
      setWorkerDeductionReason("");
    },
  });
  return {
    ...data,
    ...state,
    selectedCompany,
    depositForm,
    withdrawalForm,
    bulkPaymentForm,
    newWorkerForm,
    editWorkerForm,
    createEmployeeForm,
    editEmployeeForm,
    cleanTxnDesc,
    depositMutation,
    withdrawalMutation,
    handleDeposit,
    handleWithdrawal,
    handleBonus,
    fetchSalesPreview,
    fetchBalesQty,
    saveBonusToPending,
    submitSmartBonus,
    handleSelectAllEmployees,
    handleToggleEmployeeDeposit,
    validSelectedEmployees,
    bulkDepositTotal,
    bulkDepositMutation,
    bulkWithdrawalMutation,
    bulkBonusMutation,
    bulkPaymentMutation,
    autoCalculateBonuses,
    handlePrintBulkBonus,
    handleDeleteEmployee,
    handleForceDeleteEmployee,
    editEmployeeMutation,
    createEmployeeMutation,
    createGroupMutation,
    groupMembers,
    addWorkerToGroupMutation,
    removeWorkerFromGroupMutation,
    handleToggleWorker,
    handleUpdateAmount,
    handleDeleteWorker,
    createWorkerMutation,
    updateWorkerMutation,
    handleForceDeleteWorker,
    deleteWorkerGroupMutation,
    addWorkerToWorkerGroupMutation,
    removeWorkerFromWorkerGroupMutation,
    workerDeductionMutation,
  };
}
