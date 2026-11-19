// Extracted from ./useFactoryWorkersModel.tsx: roster filters, queries and worker state for the Factory Workers page.
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import type { FactoryWorker, FactoryWorkerCategory } from "@shared/schema";
import type { CashAccount } from "./types";
import { emptyForm } from "./utils";
import type { FactoryWorkerSettings, FactoryWorkerRecord } from "./useFactoryWorkersModel";
import { isHandledGlobally, getErrorMessage } from "./useFactoryWorkersModel";

export function useFactoryWorkersRosterModel() {
  const { selectedCompany } = useCompany();
  const { data: settings } = useQuery<FactoryWorkerSettings>({
    queryKey: companyQueryKey("/api/factory/settings", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const hiddenTabs =
    myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
      ? myAccess.hiddenCostFields
      : ["hide_tab_workers_list", "hide_tab_workers_categories"];
  const showWorkersList = !hiddenTabs.includes("hide_tab_workers_list");

  const showCategories =
    settings?.workersTabCategoriesEnabled !== false && !hiddenTabs.includes("hide_tab_workers_categories");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();

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
    queryKey: companyQueryKey("/api/factory/cash-accounts", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/cash-accounts", { credentials: "include" });
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: workers, isLoading } = useQuery<FactoryWorkerRecord[]>({
    queryKey: companyQueryKey("/api/factory/workers", selectedCompany?.id, "full"),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/workers?profile=full", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch workers");
      return res.json();
    },
  });

  const { data: docCounts = {} } = useQuery<Record<number, number>>({
    queryKey: companyQueryKey("/api/factory/workers/document-counts", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/workers/document-counts", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    staleTime: 15000,
  });

  const { data: savedNationalities = [] } = useQuery<string[]>({
    queryKey: companyQueryKey("/api/factory/workers/nationalities", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
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
    queryKey: companyQueryKey("/api/factory/workers/amount-due", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
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
    queryKey: companyQueryKey("/api/factory/worker-categories", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
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
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const updateCatMutation = useMutation({
    mutationFn: (data: { id: number; name: string; workerIds: number[] }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("PATCH", `/api/factory/worker-categories/${data.id}`, {
        name: data.name,
        workerIds: data.workerIds,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-categories"] });
      setCategoryDialogOpen(false);
      toast({ title: "Category updated" });
    },
    onError: (e: Error) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const deleteCatMutation = useMutation({
    mutationFn: (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return factoryApiRequest("DELETE", `/api/factory/worker-categories/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-categories"] });
      toast({ title: "Category deleted" });
    },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
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
      toast({ title: "Save failed", description: getErrorMessage(err), variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: typeof formData }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
      toast({ title: "Update failed", description: getErrorMessage(err), variant: "destructive" });
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
      toast({ title: "Update failed", description: getErrorMessage(err), variant: "destructive" });
    },
  });

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !recordChanges.allowed) return;
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

  return {
    showWorkersList,
    showCategories,
    setLocation,
    toast,
    recordChanges,
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
    setFormData,
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
    setEndCalculating,
    endResult,
    setEndResult,
    endCashAccountId,
    setEndCashAccountId,
    endSubmitting,
    setEndSubmitting,
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
  };
}
