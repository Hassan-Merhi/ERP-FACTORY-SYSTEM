import { searchAny } from "@shared/searchNormalization";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useDateFormat } from "@/contexts/DateFormatContext";
import type { FactoryWorker } from "@shared/schema";
import type { ProductionBonusDecisionResult } from "./ProductionBonusDecisionPanel";
import type { Company, PayrollRecord } from "./types";
import { amount } from "./utils";

interface PayrollSettings {
  payrollTabWorkerMasterEnabled?: boolean;
}

interface FactoryAccess {
  hiddenCostFields?: string[];
}

interface WorkerImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors?: unknown[];
  message?: string;
}

interface PayrollMigrationResult {
  vouchersUpdated: number;
  bonusEntriesCreated: number;
  message?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function wasHandledGlobally(error: unknown): boolean {
  return typeof error === "object" && error !== null && "_handledGlobally" in error && error._handledGlobally === true;
}

export function useFactoryPayrollModel() {
  const { toast } = useToast();
  const today = new Date().toLocaleDateString("en-CA");
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString("en-CA");
  const { formatDisplayDate } = useDateFormat();
  const [, navigate] = useLocation();

  const { data: settings } = useQuery<PayrollSettings>({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const response = await fetch("/api/factory/settings");
      return response.ok ? ((await response.json()) as PayrollSettings) : {};
    },
    staleTime: 60000,
  });
  const { data: myAccess } = useQuery<FactoryAccess>({
    queryKey: ["/api/factory/my-access"],
    staleTime: 5 * 60000,
  });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];
  const showPayrollRecords = !hiddenTabs.includes("hide_tab_payroll_records");
  const showWorkerMaster =
    settings?.payrollTabWorkerMasterEnabled !== false && !hiddenTabs.includes("hide_tab_payroll_worker_master");

  const [companyId, setCompanyId] = useState<number | null>(null);
  const [filterStartDate, setFilterStartDate] = useState(thirtyDaysAgo);
  const [filterEndDate, setFilterEndDate] = useState(today);
  const [statusFilter, setStatusFilter] = useState("ALL");

  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [genStartDate, setGenStartDate] = useState(thirtyDaysAgo);
  const [genEndDate, setGenEndDate] = useState(today);

  const [editRecord, setEditRecord] = useState<PayrollRecord | null>(null);
  const [editOtherBonuses, setEditOtherBonuses] = useState("");
  const [editDeductions, setEditDeductions] = useState("");
  const [editAdvances, setEditAdvances] = useState("");
  const [editOvertimeHours, setEditOvertimeHours] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editStatus, setEditStatus] = useState("DRAFT");

  const [showPayDialog, setShowPayDialog] = useState(false);
  const [paySource, setPaySource] = useState("Cash");
  const [payDate, setPayDate] = useState(today);
  const [payReference, setPayReference] = useState("");
  const [payEffectiveDate, setPayEffectiveDate] = useState("");

  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [migrating, setMigrating] = useState(false);

  const [workerSearch, setWorkerSearch] = useState("");
  const [workerImporting, setWorkerImporting] = useState(false);
  const workerFileInput = useRef<HTMLInputElement>(null);

  const { data: companies = [] } = useQuery<Company[]>({ queryKey: ["/api/user/companies"] });
  const firstCompanyId = companies.length > 0 ? companies[0].id : null;
  const selectedCompanyId = companyId ?? firstCompanyId;

  useEffect(() => {
    if (companies.length === 1 && companyId === null) setCompanyId(companies[0].id);
  }, [companies, companyId]);

  const payrollQueryParams = new URLSearchParams();
  if (selectedCompanyId) payrollQueryParams.set("companyId", String(selectedCompanyId));
  if (filterStartDate) payrollQueryParams.set("startDate", filterStartDate);
  if (filterEndDate) payrollQueryParams.set("endDate", filterEndDate);
  if (statusFilter !== "ALL") payrollQueryParams.set("status", statusFilter);
  const payrollUrl = `/api/factory/payroll?${payrollQueryParams.toString()}`;

  const { data: allWorkers = [], isLoading: workersLoading } = useQuery<FactoryWorker[]>({
    queryKey: ["/api/factory/workers", selectedCompanyId],
    queryFn: async () => {
      const response = await fetch(`/api/factory/workers?companyId=${selectedCompanyId}`, { credentials: "include" });
      if (!response.ok) return [];
      return (await response.json()) as FactoryWorker[];
    },
    enabled: !!selectedCompanyId,
  });

  const filteredWorkers = useMemo(() => {
    if (!workerSearch.trim()) return allWorkers;
    return allWorkers.filter((worker) =>
      searchAny(workerSearch, worker.fullName, worker.employeeCode, worker.phone1, worker.position)
    );
  }, [allWorkers, workerSearch]);

  const {
    data: payrollRecords = [],
    isLoading,
    isError,
  } = useQuery<PayrollRecord[]>({
    queryKey: ["/api/factory/payroll", selectedCompanyId, filterStartDate, filterEndDate, statusFilter],
    queryFn: async () => {
      const response = await fetch(payrollUrl, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch payroll data");
      return (await response.json()) as PayrollRecord[];
    },
    enabled: !!selectedCompanyId,
  });

  const generateMutation = useMutation({
    mutationFn: async (data: { companyId: number; startDate: string; endDate: string }) => {
      const response = await factoryApiRequest("POST", "/api/factory/payroll/generate", data);
      return (await response.json()) as PayrollRecord[];
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/payroll"] });
      setShowGenerateDialog(false);
      toast({ title: "Payroll generated", description: `${data.length} payroll records available.` });
    },
    onError: (error: unknown) => {
      if (wasHandledGlobally(error)) return;
      toast({ title: "Generation failed", description: errorMessage(error), variant: "destructive" });
    },
  });

  const adjustMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Record<string, unknown> }) => {
      const response = await factoryApiRequest("PATCH", `/api/factory/payroll/${id}`, data);
      return (await response.json()) as PayrollRecord;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/payroll"] });
      setEditRecord(null);
      setShowPayDialog(false);
      toast({ title: "Payroll updated" });
    },
    onError: (error: unknown) => {
      if (wasHandledGlobally(error)) return;
      toast({ title: "Update failed", description: errorMessage(error), variant: "destructive" });
    },
  });

  const openEditDialog = (record: PayrollRecord) => {
    setEditRecord(record);
    setEditOtherBonuses(record.otherBonuses || "0");
    setEditDeductions(record.deductions || "0");
    setEditAdvances(record.advances || "0");
    setEditOvertimeHours(record.overtimeHours || "0");
    setEditNotes(record.notes || "");
    setEditStatus(record.status);
  };

  const handleProductionBonusChanged = (result: ProductionBonusDecisionResult) => {
    setEditRecord((current) => {
      if (!current) return current;
      return {
        ...current,
        bonuses: result.totalBonus.toFixed(2),
        productionBonus: result.details.totals.approved.toFixed(2),
        pendingProductionBonus: result.details.totals.pending.toFixed(2),
        rejectedProductionBonus: result.details.totals.rejected.toFixed(2),
        suggestedProductionBonus: result.details.totals.totalSuggested.toFixed(2),
        productionBonusPendingCount: result.details.totals.pendingCount,
        productionBonusApprovedCount: result.details.totals.approvedCount,
        productionBonusRejectedCount: result.details.totals.rejectedCount,
        otherBonuses: result.otherBonus.toFixed(2),
        netSalary: result.netSalary.toFixed(2),
      };
    });
    setEditOtherBonuses(result.otherBonus.toFixed(2));
  };

  const handleAdjustSubmit = () => {
    if (!editRecord) return;
    if (editStatus === "PAID" && editRecord.status !== "PAID") {
      setPayDate(today);
      setPaySource("Cash");
      setPayReference("");
      setPayEffectiveDate("");
      setShowPayDialog(true);
      return;
    }
    adjustMutation.mutate({
      id: editRecord.id,
      data: {
        otherBonuses: editOtherBonuses,
        deductions: editDeductions,
        advances: editAdvances,
        overtimeHours: editOvertimeHours,
        notes: editNotes,
        status: editStatus,
      },
    });
  };

  const handleConfirmPayment = () => {
    if (!editRecord) return;
    adjustMutation.mutate({
      id: editRecord.id,
      data: {
        otherBonuses: editOtherBonuses,
        deductions: editDeductions,
        advances: editAdvances,
        overtimeHours: editOvertimeHours,
        notes: editNotes,
        status: "PAID",
        paymentSource: paySource,
        paymentDate: payDate,
        paymentReference: payReference,
        effectiveDate: payEffectiveDate || null,
      },
    });
  };

  const handleWorkerImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !selectedCompanyId) return;
    setWorkerImporting(true);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("companyId", String(selectedCompanyId));
    try {
      const response = await fetch("/api/factory/workers/import-excel", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const data = (await response.json()) as WorkerImportResult;
      if (!response.ok) throw new Error(data.message || "Import failed");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", selectedCompanyId] });
      toast({
        title: "Import complete",
        description: `Created: ${data.created}, Updated: ${data.updated}, Skipped: ${data.skipped}`,
      });
      if (data.errors?.length) console.warn("Import errors:", data.errors);
    } catch (error: unknown) {
      toast({ title: "Import failed", description: errorMessage(error), variant: "destructive" });
    } finally {
      setWorkerImporting(false);
      if (workerFileInput.current) workerFileInput.current.value = "";
    }
  };

  const handleMigrateCitySplit = async () => {
    if (!selectedCompanyId) return;
    if (
      !window.confirm(
        "This will split historical salary/bonus expense entries by city (Lubumbashi / Kolwezi). Run once only. Continue?"
      )
    )
      return;
    setMigrating(true);
    try {
      const response = await fetch("/api/factory/payroll/migrate-city-split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ companyId: selectedCompanyId }),
      });
      const data = (await response.json()) as PayrollMigrationResult;
      if (!response.ok) throw new Error(data.message || "Migration failed");
      toast({
        title: "Migration complete",
        description: `${data.vouchersUpdated} payroll vouchers split by city, ${data.bonusEntriesCreated} bonus entries created.`,
      });
    } catch (error: unknown) {
      toast({ title: "Migration failed", description: errorMessage(error), variant: "destructive" });
    } finally {
      setMigrating(false);
    }
  };

  const handleExportPdf = async () => {
    if (!selectedCompanyId) return;
    if (!navigator.onLine) {
      window.print();
      return;
    }
    setExportingPdf(true);
    try {
      const response = await fetch("/api/factory/payroll/export-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ companyId: selectedCompanyId, startDate: filterStartDate, endDate: filterEndDate }),
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `payroll-${filterStartDate}-${filterEndDate}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast({ title: "PDF exported" });
    } catch (error: unknown) {
      toast({ title: "Export failed", description: errorMessage(error), variant: "destructive" });
    } finally {
      setExportingPdf(false);
    }
  };

  const handleExportExcel = async () => {
    if (!selectedCompanyId) return;
    setExportingExcel(true);
    try {
      const response = await fetch("/api/factory/payroll/export-excel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ companyId: selectedCompanyId, startDate: filterStartDate, endDate: filterEndDate }),
      });
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `payroll-${filterStartDate}-${filterEndDate}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast({ title: "Excel exported" });
    } catch (error: unknown) {
      toast({ title: "Export failed", description: errorMessage(error), variant: "destructive" });
    } finally {
      setExportingExcel(false);
    }
  };

  const totals = useMemo(
    () =>
      payrollRecords.reduce(
        (acc, record) => ({
          baseSalary: acc.baseSalary + amount(record.baseSalary),
          baleEarnings: acc.baleEarnings + amount(record.baleEarnings),
          kgEarnings: acc.kgEarnings + amount(record.kgEarnings),
          overtimePay: acc.overtimePay + amount(record.overtimePay),
          productionBonus: acc.productionBonus + amount(record.productionBonus),
          pendingProductionBonus: acc.pendingProductionBonus + amount(record.pendingProductionBonus),
          otherBonuses: acc.otherBonuses + amount(record.otherBonuses),
          deductions: acc.deductions + amount(record.deductions),
          advances: acc.advances + amount(record.advances),
          netSalary: acc.netSalary + amount(record.netSalary),
        }),
        {
          baseSalary: 0,
          baleEarnings: 0,
          kgEarnings: 0,
          overtimePay: 0,
          productionBonus: 0,
          pendingProductionBonus: 0,
          otherBonuses: 0,
          deductions: 0,
          advances: 0,
          netSalary: 0,
        }
      ),
    [payrollRecords]
  );
  return {
    formatDisplayDate,
    navigate,
    showPayrollRecords,
    showWorkerMaster,
    setCompanyId,
    filterStartDate,
    setFilterStartDate,
    filterEndDate,
    setFilterEndDate,
    statusFilter,
    setStatusFilter,
    showGenerateDialog,
    setShowGenerateDialog,
    genStartDate,
    setGenStartDate,
    genEndDate,
    setGenEndDate,
    editRecord,
    setEditRecord,
    editOtherBonuses,
    setEditOtherBonuses,
    editDeductions,
    setEditDeductions,
    editAdvances,
    setEditAdvances,
    editOvertimeHours,
    setEditOvertimeHours,
    editNotes,
    setEditNotes,
    editStatus,
    setEditStatus,
    showPayDialog,
    setShowPayDialog,
    paySource,
    setPaySource,
    payDate,
    setPayDate,
    payReference,
    setPayReference,
    payEffectiveDate,
    setPayEffectiveDate,
    exportingPdf,
    exportingExcel,
    migrating,
    workerSearch,
    setWorkerSearch,
    workerImporting,
    workerFileInput,
    companies,
    selectedCompanyId,
    workersLoading,
    filteredWorkers,
    payrollRecords,
    isLoading,
    isError,
    generateMutation,
    adjustMutation,
    openEditDialog,
    handleProductionBonusChanged,
    handleAdjustSubmit,
    handleConfirmPayment,
    handleWorkerImport,
    handleMigrateCitySplit,
    handleExportPdf,
    handleExportExcel,
    totals,
  };
}
