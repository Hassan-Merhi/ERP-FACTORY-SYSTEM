import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";

import { ExcelJS, writeFile } from "@/lib/excelHelper";

import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { FactoryWorker, FactoryWorkerCategory } from "@shared/schema";

import type { CashAccount } from "./types";
import { emptyForm } from "./utils";
interface FactoryWorkerSettings {
  workersTabCategoriesEnabled?: boolean;
}

interface FactoryWorkerAccess {
  hiddenCostFields?: string[];
}

type FactoryWorkerRecord = FactoryWorker & {
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

function isHandledGlobally(error: unknown): boolean {
  return typeof error === "object" && error !== null && "_handledGlobally" in error;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred";
}

export function useFactoryWorkersModel() {
  const { data: settings } = useQuery<FactoryWorkerSettings>({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryWorkerAccess>({
    queryKey: ["/api/factory/my-access"],
    staleTime: 5 * 60000,
  });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];
  const showWorkersList = !hiddenTabs.includes("hide_tab_workers_list");

  const showCategories =
    settings?.workersTabCategoriesEnabled !== false && !hiddenTabs.includes("hide_tab_workers_categories");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("Active");

  // ── Column filters ──────────────────────────────────────────────────────
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [positionFilter, setPositionFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [nationalityFilter, setNationalityFilter] = useState("all");
  const [salaryTypeFilter, setSalaryTypeFilter] = useState("all");
  const [salaryRangeFilter, setSalaryRangeFilter] = useState("all"); // all | 0-500 | 500-1000 | 1000-2000 | 2000-5000 | 5000+
  const [transportFilter, setTransportFilter] = useState("all"); // all | has | none
  const [advanceFilter, setAdvanceFilter] = useState("all"); // all | has | none

  const [createOpen, setCreateOpen] = useState(false);
  const [editingWorker, setEditingWorker] = useState<FactoryWorkerRecord | null>(null);
  const [formData, setFormData] = useState({ ...emptyForm });
  const [importLoading, setImportLoading] = useState(false);
  const [nationalityOpen, setNationalityOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [endContractWorker, setEndContractWorker] = useState<FactoryWorker | null>(null);
  const [endStep, setEndStep] = useState<1 | 2>(1);
  const [endStart, setEndStart] = useState("");
  const [endEnd, setEndEnd] = useState(new Date().toLocaleDateString("en-CA"));
  const [endCalculating, setEndCalculating] = useState(false);
  const [endResult, setEndResult] = useState<{
    earned: string;
    paid: string;
    advances: string;
    balance: string;
  } | null>(null);
  const [endCashAccountId, setEndCashAccountId] = useState("");
  const [endSubmitting, setEndSubmitting] = useState(false);

  const { data: cashAccounts } = useQuery<CashAccount[]>({
    queryKey: ["/api/factory/cash-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/factory/cash-accounts", { credentials: "include" });
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: workers, isLoading } = useQuery<FactoryWorkerRecord[]>({
    queryKey: ["/api/factory/workers", "full"],
    queryFn: async () => {
      const res = await fetch("/api/factory/workers?profile=full", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch workers");
      return res.json();
    },
  });

  const { data: docCounts = {} } = useQuery<Record<number, number>>({
    queryKey: ["/api/factory/workers/document-counts"],
    queryFn: async () => {
      const res = await fetch("/api/factory/workers/document-counts", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    staleTime: 15000,
  });

  const { data: savedNationalities = [] } = useQuery<string[]>({
    queryKey: ["/api/factory/workers/nationalities"],
    queryFn: async () => {
      const res = await fetch("/api/factory/workers/nationalities", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 30000,
  });

  // ── Amount due till today (calendar proration minus recorded absences) ─────
  const { data: amountDue = {} } = useQuery<
    Record<
      number,
      {
        periodStart: string;
        periodEnd: string;
        base: number;
        transport: number;
        absenceDeducted: number;
        advanceDeducted: number;
        net: number;
        lastPaidThrough: string | null;
      }
    >
  >({
    queryKey: ["/api/factory/workers/amount-due"],
    queryFn: async () => {
      const res = await fetch("/api/factory/workers/amount-due", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    staleTime: 2 * 60 * 1000, // 2 min — fresh enough, won't flicker while typing
    refetchOnWindowFocus: false,
  });

  // ── Categories ─────────────────────────────────────────────────────────────
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<FactoryWorkerCategory | null>(null);
  const [catName, setCatName] = useState("");
  const [catWorkerIds, setCatWorkerIds] = useState<number[]>([]);

  const { data: categories = [] } = useQuery<FactoryWorkerCategory[]>({
    queryKey: ["/api/factory/worker-categories"],
    queryFn: async () => {
      const res = await fetch("/api/factory/worker-categories", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch worker categories");
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
  });

  const createCatMutation = useMutation({
    mutationFn: (data: { name: string; workerIds: number[] }) =>
      factoryApiRequest("POST", "/api/factory/worker-categories", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-categories"] });
      setCategoryDialogOpen(false);
      toast({ title: "Category created" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateCatMutation = useMutation({
    mutationFn: (data: { id: number; name: string; workerIds: number[] }) =>
      factoryApiRequest("PATCH", `/api/factory/worker-categories/${data.id}`, {
        name: data.name,
        workerIds: data.workerIds,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-categories"] });
      setCategoryDialogOpen(false);
      toast({ title: "Category updated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteCatMutation = useMutation({
    mutationFn: (id: number) => factoryApiRequest("DELETE", `/api/factory/worker-categories/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-categories"] });
      toast({ title: "Category deleted" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const openNewCategory = () => {
    setEditingCategory(null);
    setCatName("");
    setCatWorkerIds([]);
    setCategoryDialogOpen(true);
  };

  const openEditCategory = (cat: FactoryWorkerCategory) => {
    setEditingCategory(cat);
    setCatName(cat.name);
    setCatWorkerIds(Array.isArray(cat.workerIds) ? (cat.workerIds as number[]) : []);
    setCategoryDialogOpen(true);
  };

  const toggleCatWorker = (id: number) => {
    setCatWorkerIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSaveCategory = () => {
    if (!catName.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    // Only keep active workers' IDs
    const activeIds = (workers ?? []).filter((w) => w.active).map((w) => w.id);
    const filteredIds = catWorkerIds.filter((id) => activeIds.includes(id));
    if (editingCategory) {
      updateCatMutation.mutate({ id: editingCategory.id, name: catName.trim(), workerIds: filteredIds });
    } else {
      createCatMutation.mutate({ name: catName.trim(), workerIds: filteredIds });
    }
  };
  // ── End Categories ─────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const res = await factoryApiRequest("POST", "/api/factory/workers", { ...data });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Worker added" });
      resetForm();
      setCreateOpen(false);
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: getErrorMessage(err), variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: typeof formData }) => {
      const res = await factoryApiRequest("PATCH", `/api/factory/workers/${id}`, { ...data });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-categories"] });
      toast({ title: "Worker updated" });
      resetForm();
      setEditingWorker(null);
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: getErrorMessage(err), variant: "destructive" });
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await factoryApiRequest("POST", `/api/factory/workers/${id}/reactivate`, {});
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    onSuccess: (data: FactoryWorker) => {
      toast({ title: "Worker reactivated", description: `${data.fullName} is now active again.` });
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: getErrorMessage(err), variant: "destructive" });
    },
  });

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/factory/workers/import-excel", {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message || "Import failed");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      const parts: string[] = [];
      if (result.created) parts.push(`${result.created} created`);
      if (result.updated) parts.push(`${result.updated} updated`);
      if (result.skipped) parts.push(`${result.skipped} skipped`);
      toast({ title: "Import complete", description: parts.join(", ") || "No changes" });
    } catch (err: unknown) {
      toast({ title: "Import failed", description: getErrorMessage(err), variant: "destructive" });
    } finally {
      setImportLoading(false);
    }
  };

  const resetForm = () => setFormData({ ...emptyForm });

  const openEdit = (w: FactoryWorkerRecord) => {
    setEditingWorker(w);
    setFormData({
      fullName: w.fullName || "",
      fatherName: w.fatherName || "",
      motherName: w.motherName || "",
      nationalId: w.nationalId || "",
      passportNumber: w.passportNumber || "",
      dateOfBirth: w.dateOfBirth || "",
      gender: w.gender || "",
      nationality: w.nationality || "",
      maritalStatus: w.maritalStatus || "",
      numberOfChildren: w.numberOfChildren ?? 0,
      phone1: w.phone1 || "",
      phone2: w.phone2 || "",
      emergencyContactName: w.emergencyContactName || "",
      emergencyContactPhone: w.emergencyContactPhone || "",
      address: w.address || "",
      city: w.city || "",
      country: w.country || "",
      position: w.position || "",
      department: w.department || "",
      dateJoined: w.dateJoined || "",
      contractStartDate: w.contractStartDate || "",
      contractEndDate: w.contractEndDate || "",
      salaryType: w.salaryType || "Monthly",
      baseSalary: w.baseSalary || "",
      perBaleRate: w.perBaleRate || "",
      perKgRate: w.perKgRate || "",
      overtimeRate: w.overtimeRate || "",
      shiftType: w.shiftType || "",
      payFrequency: w.payFrequency || "Monthly",
      hourlyRate: w.hourlyRate || "",
      weeklySalary: w.weeklySalary || "",
      biWeeklySalary: w.biWeeklySalary || "",
      transportAllowance: w.transportAllowance || "",
      visaNumber: w.visaNumber || "",
      visaExpiry: w.visaExpiry || "",
      workPermitNumber: w.workPermitNumber || "",
      workPermitExpiry: w.workPermitExpiry || "",
      residentialPermit: w.residentialPermit || "",
      residentialPermitExpiry: w.residentialPermitExpiry || "",
      bankName: w.bankName || "",
      bankAccountNumber: w.bankAccountNumber || "",
      paymentMethod: w.paymentMethod || "Cash",
      notes: w.notes || "",
    });
  };

  const handleSubmit = () => {
    if (!formData.fullName.trim()) {
      toast({ title: "Full name is required", variant: "destructive" });
      return;
    }
    if (editingWorker) updateMutation.mutate({ id: editingWorker.id, data: formData });
    else createMutation.mutate(formData);
  };

  const updateField = (field: string, value: string | number) => setFormData((prev) => ({ ...prev, [field]: value }));

  const openEndContract = (w: FactoryWorker) => {
    setEndContractWorker(w);
    setEndStep(1);
    setEndResult(null);
    setEndCashAccountId("");
    const today = new Date().toLocaleDateString("en-CA");
    const firstOfMonth = today.slice(0, 7) + "-01";
    setEndStart(w.contractStartDate || w.dateJoined || firstOfMonth);
    setEndEnd(today);
  };

  const handleCalculate = async () => {
    if (!endContractWorker || !endStart || !endEnd) return;
    if (!navigator.onLine) {
      toast({
        title: "Not available offline",
        description: "Settle-and-end requires a connection",
        variant: "destructive",
      });
      return;
    }
    setEndCalculating(true);
    try {
      const res = await factoryApiRequest("POST", `/api/factory/workers/${endContractWorker.id}/settle-and-end`, {
        startDate: endStart,
        endDate: endEnd,
        dryRun: true,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Calculation failed");
      setEndResult(data);
      setEndStep(2);
    } catch (err: unknown) {
      toast({ title: "Error", description: getErrorMessage(err), variant: "destructive" });
    } finally {
      setEndCalculating(false);
    }
  };

  const handleEndContract = async (payNow: boolean) => {
    if (!endContractWorker) return;
    if (!navigator.onLine) {
      toast({
        title: "Not available offline",
        description: "Settle-and-end requires a connection",
        variant: "destructive",
      });
      return;
    }
    setEndSubmitting(true);
    try {
      const res = await factoryApiRequest("POST", `/api/factory/workers/${endContractWorker.id}/settle-and-end`, {
        startDate: endStart,
        endDate: endEnd,
        payNow,
        cashAccountId: payNow ? endCashAccountId : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to end contract");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-categories"] });
      toast({ title: "Contract ended", description: payNow ? `Paid ${data.balance}` : "Balance recorded as pending" });
      setEndContractWorker(null);
    } catch (err: unknown) {
      toast({ title: "Error", description: getErrorMessage(err), variant: "destructive" });
    } finally {
      setEndSubmitting(false);
    }
  };

  function parseCodeNumber(code: string | null | undefined): number {
    if (!code) return Infinity;
    const m = code.match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : Infinity;
  }

  // Unique option lists derived from the full worker roster
  const uniquePositions = useMemo(
    () => [...new Set((workers ?? []).map((w) => w.position).filter(Boolean))].sort() as string[],
    [workers]
  );
  const uniqueLocations = useMemo(
    () => [...new Set((workers ?? []).map((w) => w.city || w.country).filter(Boolean))].sort() as string[],
    [workers]
  );
  const uniqueNationalities = useMemo(
    () => [...new Set((workers ?? []).map((w) => w.nationality).filter(Boolean))].sort() as string[],
    [workers]
  );
  const uniqueSalaryTypes = useMemo(
    () => [...new Set((workers ?? []).map((w) => w.salaryType).filter(Boolean))].sort() as string[],
    [workers]
  );

  const activeFilterCount = [
    positionFilter !== "all",
    locationFilter !== "all",
    nationalityFilter !== "all",
    salaryTypeFilter !== "all",
    salaryRangeFilter !== "all",
    transportFilter !== "all",
    advanceFilter !== "all",
  ].filter(Boolean).length;

  const clearAllFilters = () => {
    setPositionFilter("all");
    setLocationFilter("all");
    setNationalityFilter("all");
    setSalaryTypeFilter("all");
    setSalaryRangeFilter("all");
    setTransportFilter("all");
    setAdvanceFilter("all");
  };

  const filteredWorkers = useMemo(() => {
    if (!workers) return [];
    return workers
      .filter((w) => {
        if (statusFilter === "Active" && !w.active) return false;
        if (statusFilter === "Inactive" && w.active) return false;

        // ── Text search ────────────────────────────────────────────────
        if (searchQuery) {
          const matches = searchAny(
            searchQuery,
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
        if (positionFilter !== "all" && w.position !== positionFilter) return false;
        if (locationFilter !== "all") {
          const loc = w.city || w.country || "";
          if (loc !== locationFilter) return false;
        }
        if (nationalityFilter !== "all" && w.nationality !== nationalityFilter) return false;
        if (salaryTypeFilter !== "all" && w.salaryType !== salaryTypeFilter) return false;

        if (salaryRangeFilter !== "all") {
          const salary = parseFloat(w.baseSalary || "0");
          if (salaryRangeFilter === "5000+") {
            // "$5,000 and above" — inclusive lower bound
            if (salary < 5000) return false;
          } else {
            // Half-open interval [lo, hi): "Under $500" means salary < 500
            const [lo, hi] = salaryRangeFilter.split("-").map(Number);
            if (salary < lo || salary >= hi) return false;
          }
        }

        if (transportFilter === "has" && !(parseFloat(w.transportAllowance || "0") > 0)) return false;
        if (transportFilter === "none" && parseFloat(w.transportAllowance || "0") > 0) return false;

        if (advanceFilter === "has" && !(parseFloat(w.pendingAdvanceBalance || "0") > 0)) return false;
        if (advanceFilter === "none" && parseFloat(w.pendingAdvanceBalance || "0") > 0) return false;

        return true;
      })
      .sort((a, b) => parseCodeNumber(a.employeeCode) - parseCodeNumber(b.employeeCode));
  }, [
    workers,
    statusFilter,
    searchQuery,
    positionFilter,
    locationFilter,
    nationalityFilter,
    salaryTypeFilter,
    salaryRangeFilter,
    transportFilter,
    advanceFilter,
  ]);

  const activeCount = workers?.filter((w) => w.active).length ?? 0;
  const inactiveCount = workers?.filter((w) => !w.active).length ?? 0;

  const handleExportSalaries = async () => {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Factory System";
    const ws = wb.addWorksheet("Workers Salaries");

    ws.columns = [
      { key: "no", width: 6 },
      { key: "code", width: 14 },
      { key: "name", width: 30 },
      { key: "position", width: 20 },
      { key: "department", width: 18 },
      { key: "salaryType", width: 14 },
      { key: "salary", width: 16 },
    ];

    const headerRow = ws.addRow(["#", "Code", "Name", "Position", "Department", "Salary Type", "Base Salary"]);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E40AF" } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.border = {
        top: { style: "thin" },
        bottom: { style: "thin" },
        left: { style: "thin" },
        right: { style: "thin" },
      };
    });
    headerRow.height = 22;

    let totalSalary = 0;
    filteredWorkers.forEach((w, idx) => {
      const salary = parseFloat(w.baseSalary || "0") || 0;
      totalSalary += salary;
      const row = ws.addRow([
        idx + 1,
        w.employeeCode || "",
        w.fullName || "",
        w.position || "",
        w.department || "",
        w.salaryType || "Monthly",
        salary,
      ]);
      row.getCell(7).numFmt = "#,##0.00";
      row.getCell(7).alignment = { horizontal: "right" };
      row.eachCell((cell) => {
        cell.border = {
          top: { style: "thin", color: { argb: "FFE5E7EB" } },
          bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
          left: { style: "thin", color: { argb: "FFE5E7EB" } },
          right: { style: "thin", color: { argb: "FFE5E7EB" } },
        };
      });
      if (idx % 2 === 1) {
        row.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
        });
      }
    });

    const totalRow = ws.addRow(["", "", `Total Workers: ${filteredWorkers.length}`, "", "", "TOTAL", totalSalary]);
    totalRow.getCell(6).alignment = { horizontal: "right" };
    totalRow.getCell(7).numFmt = "#,##0.00";
    totalRow.getCell(7).alignment = { horizontal: "right" };
    totalRow.eachCell((cell) => {
      cell.font = { bold: true, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.border = {
        top: { style: "medium" },
        bottom: { style: "medium" },
        left: { style: "thin" },
        right: { style: "thin" },
      };
    });
    totalRow.height = 22;

    const date = new Date().toLocaleDateString("en-CA");
    await writeFile(wb, `workers-salaries-${date}.xlsx`);
  };

  const balance = endResult ? parseFloat(endResult.balance) : 0;

  const totalSalary = (workers ?? []).filter((w) => w.active).reduce((s, w) => s + parseFloat(w.baseSalary || "0"), 0);
  const totalTransport = (workers ?? [])
    .filter((w) => w.active)
    .reduce((s, w) => s + parseFloat(w.transportAllowance || "0"), 0);
  const totalAdvances = (workers ?? []).reduce((s, w) => s + parseFloat(w.pendingAdvanceBalance || "0"), 0);
  const totalDueToday = Object.values(amountDue).reduce((s, d) => s + (d.net > 0 ? d.net : 0), 0);
  // Total Remaining = sum of the "DUE − ADV" column: Due Today minus pending advance for each active worker
  const totalRemainingToBePaid = (workers ?? [])
    .filter((w) => w.active)
    .reduce((s, w) => {
      const dueNet = amountDue[w.id]?.net ?? 0;
      const advance = parseFloat(w.pendingAdvanceBalance || "0");
      return s + (dueNet - advance);
    }, 0);

  return {
    showWorkersList,
    showCategories,
    setLocation,
    searchQuery,
    setSearchQuery,
    statusFilter,
    setStatusFilter,
    filtersOpen,
    setFiltersOpen,
    positionFilter,
    setPositionFilter,
    locationFilter,
    setLocationFilter,
    nationalityFilter,
    setNationalityFilter,
    salaryTypeFilter,
    setSalaryTypeFilter,
    salaryRangeFilter,
    setSalaryRangeFilter,
    transportFilter,
    setTransportFilter,
    advanceFilter,
    setAdvanceFilter,
    createOpen,
    setCreateOpen,
    editingWorker,
    setEditingWorker,
    formData,
    importLoading,
    nationalityOpen,
    setNationalityOpen,
    fileInputRef,
    endContractWorker,
    setEndContractWorker,
    endStep,
    setEndStep,
    endStart,
    setEndStart,
    endEnd,
    setEndEnd,
    endCalculating,
    endResult,
    setEndResult,
    endCashAccountId,
    setEndCashAccountId,
    endSubmitting,
    cashAccounts,
    workers,
    isLoading,
    docCounts,
    savedNationalities,
    amountDue,
    categoryDialogOpen,
    setCategoryDialogOpen,
    editingCategory,
    catName,
    setCatName,
    catWorkerIds,
    categories,
    createCatMutation,
    updateCatMutation,
    deleteCatMutation,
    openNewCategory,
    openEditCategory,
    toggleCatWorker,
    handleSaveCategory,
    createMutation,
    updateMutation,
    reactivateMutation,
    handleImportFile,
    resetForm,
    openEdit,
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
