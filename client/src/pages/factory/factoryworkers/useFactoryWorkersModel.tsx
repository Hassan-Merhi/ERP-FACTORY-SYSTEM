import { searchAny } from "@shared/searchNormalization";
import { exportFileName } from "@/lib/exportFile";
import { useMemo } from "react";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { FactoryWorker } from "@shared/schema";

import { useFactoryWorkersRosterModel } from "./useFactoryWorkersRosterModel";
export interface FactoryWorkerSettings {
  workersTabCategoriesEnabled?: boolean;
}

export type FactoryWorkerRecord = FactoryWorker & {
  payFrequency?: string | null;
  hourlyRate?: string | null;
  weeklySalary?: string | null;
  biWeeklySalary?: string | null;
  transportAllowance?: string | null;
  visaNumber?: string | null;
  visaExpiry?: string | null;
  workPermitNumber?: string | null;
  workPermitExpiry?: string | null;
  residentialPermit?: string | null;
  residentialPermitExpiry?: string | null;
  city?: string | null;
  country?: string | null;
  pendingAdvanceBalance?: string | null;
};

export function isHandledGlobally(error: unknown): boolean {
  return typeof error === "object" && error !== null && "_handledGlobally" in error;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred";
}

export function useFactoryWorkersModel() {
  const r = useFactoryWorkersRosterModel();

  const handleSubmit = () => {
    if (!r.formData.fullName.trim()) {
      r.toast({ title: "Full name is required", variant: "destructive" });
      return;
    }
    if (r.editingWorker) r.updateMutation.mutate({ id: r.editingWorker.id, data: r.formData });
    else r.createMutation.mutate(r.formData);
  };

  const updateField = (field: string, value: string | number) => r.setFormData((prev) => ({ ...prev, [field]: value }));

  const openEndContract = (w: FactoryWorker) => {
    r.setEndContractWorker(w);
    r.setEndStep(1);
    r.setEndResult(null);
    r.setEndCashAccountId("");
    const today = new Date().toLocaleDateString("en-CA");
    const firstOfMonth = today.slice(0, 7) + "-01";
    r.setEndStart(w.contractStartDate || w.dateJoined || firstOfMonth);
    r.setEndEnd(today);
  };

  const handleCalculate = async () => {
    if (!r.endContractWorker || !r.endStart || !r.endEnd) return;
    if (!navigator.onLine) {
      r.toast({
        title: "Not available offline",
        description: "Settle-and-end requires a connection",
        variant: "destructive",
      });
      return;
    }
    r.setEndCalculating(true);
    try {
      const res = await factoryApiRequest("POST", `/api/factory/workers/${r.endContractWorker.id}/settle-and-end`, {
        startDate: r.endStart,
        endDate: r.endEnd,
        dryRun: true,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Calculation failed");
      r.setEndResult(data);
      r.setEndStep(2);
    } catch (err: unknown) {
      r.toast({ title: "Preview failed", description: getErrorMessage(err), variant: "destructive" });
    } finally {
      r.setEndCalculating(false);
    }
  };

  const handleEndContract = async (payNow: boolean) => {
    if (!r.endContractWorker || !r.recordChanges.allowed) return;
    if (!navigator.onLine) {
      r.toast({
        title: "Not available offline",
        description: "Settle-and-end requires a connection",
        variant: "destructive",
      });
      return;
    }
    r.setEndSubmitting(true);
    try {
      const res = await factoryApiRequest("POST", `/api/factory/workers/${r.endContractWorker.id}/settle-and-end`, {
        startDate: r.endStart,
        endDate: r.endEnd,
        payNow,
        cashAccountId: payNow ? r.endCashAccountId : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to end contract");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-categories"] });
      r.toast({
        title: "Contract ended",
        description: payNow ? `Paid ${data.balance}` : "Balance recorded as pending",
      });
      r.setEndContractWorker(null);
    } catch (err: unknown) {
      r.toast({ title: "Settlement failed", description: getErrorMessage(err), variant: "destructive" });
    } finally {
      r.setEndSubmitting(false);
    }
  };

  function parseCodeNumber(code: string | null | undefined): number {
    if (!code) return Infinity;
    const m = code.match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : Infinity;
  }

  // Unique option lists derived from the full worker roster
  const uniquePositions = useMemo(
    () => [...new Set((r.workers ?? []).map((w) => w.position).filter(Boolean))].sort() as string[],
    [r.workers]
  );
  const uniqueLocations = useMemo(
    () => [...new Set((r.workers ?? []).map((w) => w.city || w.country).filter(Boolean))].sort() as string[],
    [r.workers]
  );
  const uniqueNationalities = useMemo(
    () => [...new Set((r.workers ?? []).map((w) => w.nationality).filter(Boolean))].sort() as string[],
    [r.workers]
  );
  const uniqueSalaryTypes = useMemo(
    () => [...new Set((r.workers ?? []).map((w) => w.salaryType).filter(Boolean))].sort() as string[],
    [r.workers]
  );

  const activeFilterCount = [
    r.positionFilter !== "all",
    r.locationFilter !== "all",
    r.nationalityFilter !== "all",
    r.salaryTypeFilter !== "all",
    r.salaryRangeFilter !== "all",
    r.transportFilter !== "all",
    r.advanceFilter !== "all",
  ].filter(Boolean).length;

  const clearAllFilters = () => {
    r.setPositionFilter("all");
    r.setLocationFilter("all");
    r.setNationalityFilter("all");
    r.setSalaryTypeFilter("all");
    r.setSalaryRangeFilter("all");
    r.setTransportFilter("all");
    r.setAdvanceFilter("all");
  };

  const filteredWorkers = useMemo(() => {
    if (!r.workers) return [];
    return r.workers
      .filter((w) => {
        if (r.statusFilter === "Active" && !w.active) return false;
        if (r.statusFilter === "Inactive" && w.active) return false;

        // ── Text search ────────────────────────────────────────────────
        if (r.searchQuery) {
          const matches = searchAny(
            r.searchQuery,
            w.fullName,
            w.employeeCode,
            w.position,
            w.department,
            w.phone1,
            w.city,
            w.country,
            w.salaryType,
            w.nationality
          );
          if (!matches) return false;
        }

        // ── Column filters ─────────────────────────────────────────────
        if (r.positionFilter !== "all" && w.position !== r.positionFilter) return false;
        if (r.locationFilter !== "all") {
          const loc = w.city || w.country || "";
          if (loc !== r.locationFilter) return false;
        }
        if (r.nationalityFilter !== "all" && w.nationality !== r.nationalityFilter) return false;
        if (r.salaryTypeFilter !== "all" && w.salaryType !== r.salaryTypeFilter) return false;

        if (r.salaryRangeFilter !== "all") {
          const salary = parseFloat(w.baseSalary || "0");
          if (r.salaryRangeFilter === "5000+") {
            // "$5,000 and above" — inclusive lower bound
            if (salary < 5000) return false;
          } else {
            // Half-open interval [lo, hi): "Under $500" means salary < 500
            const [lo, hi] = r.salaryRangeFilter.split("-").map(Number);
            if (salary < lo || salary >= hi) return false;
          }
        }

        if (r.transportFilter === "has" && !(parseFloat(w.transportAllowance || "0") > 0)) return false;
        if (r.transportFilter === "none" && parseFloat(w.transportAllowance || "0") > 0) return false;

        if (r.advanceFilter === "has" && !(parseFloat(w.pendingAdvanceBalance || "0") > 0)) return false;
        if (r.advanceFilter === "none" && parseFloat(w.pendingAdvanceBalance || "0") > 0) return false;

        return true;
      })
      .sort((a, b) => parseCodeNumber(a.employeeCode) - parseCodeNumber(b.employeeCode));
  }, [
    r.workers,
    r.statusFilter,
    r.searchQuery,
    r.positionFilter,
    r.locationFilter,
    r.nationalityFilter,
    r.salaryTypeFilter,
    r.salaryRangeFilter,
    r.transportFilter,
    r.advanceFilter,
  ]);

  const activeCount = r.workers?.filter((w) => w.active).length ?? 0;
  const inactiveCount = r.workers?.filter((w) => !w.active).length ?? 0;

  const handleExportSalaries = async () => {
    // Fetch the same net payable figures shown in the roster, fresh at export time.
    // Never silently write zeroes if the due-today endpoint is unavailable.
    let exportAmountDue: typeof r.amountDue;
    try {
      const res = await fetch("/api/factory/workers/amount-due", { credentials: "include" });
      if (!res.ok) throw new Error("Could not load the current Due Today amounts");
      const data: unknown = await res.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Invalid Due Today amounts received");
      }
      exportAmountDue = data as typeof r.amountDue;
    } catch (error: unknown) {
      r.toast({ title: "Export failed", description: getErrorMessage(error), variant: "destructive" });
      return;
    }

    const rows = filteredWorkers.map((w, idx) => {
      const salary = Number(w.baseSalary || 0) || 0;
      const net = exportAmountDue[w.id]?.net;
      // Missing due-today evidence stays blank; never invent a zero payable.
      const dueToday = typeof net === "number" && Number.isFinite(net) ? Math.max(0, net) : null;
      return {
        no: idx + 1,
        code: w.employeeCode || "",
        name: w.fullName || "",
        position: w.position || "",
        department: w.department || "",
        salaryType: w.salaryType || "Monthly",
        salary,
        dueToday,
      };
    });
    const totalSalary = rows.reduce((amount, row) => amount + row.salary, 0);
    const totalDueToday = rows.reduce((amount, row) => amount + (row.dueToday ?? 0), 0);
    const { exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
    try {
      await exportOperationalWorkbook({
        title: "Factory Workers — Salaries",
        fileName: exportFileName("workers salaries", "xlsx"),
        sheets: [
          {
            name: "Workers Salaries",
            columns: [
              { key: "no", header: "#", type: "integer", width: 6 },
              { key: "code", header: "Code", width: 14 },
              { key: "name", header: "Name", width: 30 },
              { key: "position", header: "Position", width: 20 },
              { key: "department", header: "Department", width: 18 },
              { key: "salaryType", header: "Salary Type", width: 14 },
              { key: "salary", header: "Base Salary", type: "money", width: 16 },
              { key: "dueToday", header: "Due Today", type: "money", width: 16 },
            ],
            rows,
            footer: {
              no: null,
              code: "",
              name: "Total Workers: " + filteredWorkers.length,
              position: "",
              department: "",
              salaryType: "TOTAL",
              salary: totalSalary,
              dueToday: totalDueToday,
            },
          },
        ],
      });
    } catch (error: unknown) {
      r.toast({ title: "Export failed", description: getErrorMessage(error), variant: "destructive" });
    }
  };

  const balance = r.endResult ? parseFloat(r.endResult.balance) : 0;

  const totalSalary = (r.workers ?? [])
    .filter((w) => w.active)
    .reduce((s, w) => s + parseFloat(w.baseSalary || "0"), 0);
  const totalTransport = (r.workers ?? [])
    .filter((w) => w.active)
    .reduce((s, w) => s + parseFloat(w.transportAllowance || "0"), 0);
  const totalAdvances = (r.workers ?? []).reduce((s, w) => s + parseFloat(w.pendingAdvanceBalance || "0"), 0);
  const totalDueToday = Object.values(r.amountDue).reduce((s, d) => s + (d.net > 0 ? d.net : 0), 0);
  // The amount-due API returns net payable for active workers AFTER eligible advance deductions.
  // Do not deduct their outstanding advances a second time, or include manual-repayment advances.
  const totalRemainingToBePaid = totalDueToday;

  return {
    canChangeExistingRecords: r.recordChanges.allowed,
    canCreate: r.recordChanges.canCreate,
    changeDisabledReason: r.recordChanges.reason,
    showWorkersList: r.showWorkersList,
    showCategories: r.showCategories,
    setLocation: r.setLocation,
    searchQuery: r.searchQuery,
    setSearchQuery: r.setSearchQuery,
    statusFilter: r.statusFilter,
    setStatusFilter: r.setStatusFilter,
    filtersOpen: r.filtersOpen,
    setFiltersOpen: r.setFiltersOpen,
    positionFilter: r.positionFilter,
    setPositionFilter: r.setPositionFilter,
    locationFilter: r.locationFilter,
    setLocationFilter: r.setLocationFilter,
    nationalityFilter: r.nationalityFilter,
    setNationalityFilter: r.setNationalityFilter,
    salaryTypeFilter: r.salaryTypeFilter,
    setSalaryTypeFilter: r.setSalaryTypeFilter,
    salaryRangeFilter: r.salaryRangeFilter,
    setSalaryRangeFilter: r.setSalaryRangeFilter,
    transportFilter: r.transportFilter,
    setTransportFilter: r.setTransportFilter,
    advanceFilter: r.advanceFilter,
    setAdvanceFilter: r.setAdvanceFilter,
    createOpen: r.createOpen,
    setCreateOpen: r.setCreateOpen,
    editingWorker: r.editingWorker,
    setEditingWorker: r.setEditingWorker,
    formData: r.formData,
    importLoading: r.importLoading,
    nationalityOpen: r.nationalityOpen,
    setNationalityOpen: r.setNationalityOpen,
    fileInputRef: r.fileInputRef,
    endContractWorker: r.endContractWorker,
    setEndContractWorker: r.setEndContractWorker,
    endStep: r.endStep,
    setEndStep: r.setEndStep,
    endStart: r.endStart,
    setEndStart: r.setEndStart,
    endEnd: r.endEnd,
    setEndEnd: r.setEndEnd,
    endCalculating: r.endCalculating,
    endResult: r.endResult,
    setEndResult: r.setEndResult,
    endCashAccountId: r.endCashAccountId,
    setEndCashAccountId: r.setEndCashAccountId,
    endSubmitting: r.endSubmitting,
    cashAccounts: r.cashAccounts,
    workers: r.workers,
    isLoading: r.isLoading,
    docCounts: r.docCounts,
    savedNationalities: r.savedNationalities,
    amountDue: r.amountDue,
    categoryDialogOpen: r.categoryDialogOpen,
    setCategoryDialogOpen: r.setCategoryDialogOpen,
    editingCategory: r.editingCategory,
    catName: r.catName,
    setCatName: r.setCatName,
    catWorkerIds: r.catWorkerIds,
    categories: r.categories,
    createCatMutation: r.createCatMutation,
    updateCatMutation: r.updateCatMutation,
    deleteCatMutation: r.deleteCatMutation,
    openNewCategory: r.openNewCategory,
    openEditCategory: r.openEditCategory,
    toggleCatWorker: r.toggleCatWorker,
    handleSaveCategory: r.handleSaveCategory,
    createMutation: r.createMutation,
    updateMutation: r.updateMutation,
    reactivateMutation: r.reactivateMutation,
    handleImportFile: r.handleImportFile,
    resetForm: r.resetForm,
    openEdit: r.openEdit,
    handleSubmit,
    updateField,
    openEndContract,
    handleCalculate,
    handleEndContract,
    uniquePositions,
    uniqueLocations,
    uniqueNationalities,
    uniqueSalaryTypes,
    activeFilterCount,
    clearAllFilters,
    filteredWorkers,
    activeCount,
    inactiveCount,
    handleExportSalaries,
    balance,
    totalSalary,
    totalTransport,
    totalAdvances,
    totalDueToday,
    totalRemainingToBePaid,
  };
}
