// Extracted from ./FactoryEmployeeBonusesTab.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useToast } from "@/hooks/use-toast";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
}

interface BonusRecord {
  id: number;
  employeeId: number;
  bonusDate: string;
  amount: string;
  notes: string | null;
  firstName: string;
  lastName: string;
  employeeCode: string;
  // Accept legacy read fields during the API rollout.
  employee_id?: number;
  bonus_date?: string;
  first_name?: string | null;
  last_name?: string | null;
  employee_code?: string | null;
}

export function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "0.00" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const today = () => new Date().toLocaleDateString("en-CA");

// Use the original record values, not guessed dates or names.
export function bonusName(b: BonusRecord) {
  return (
    [b.firstName || b.first_name, b.lastName || b.last_name].filter(Boolean).join(" ").trim() ||
    b.employeeCode ||
    b.employee_code ||
    "Employee #" + (b.employeeId || b.employee_id || b.id)
  );
}

export function bonusDate(b: BonusRecord) {
  return b.bonusDate || b.bonus_date || "";
}

export function dateLabel(date: string) {
  if (!date) return "Date unavailable";
  const iso = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return date;
  const [year, month, day] = iso.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return date;
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" });
}

function csvCell(value: string | number) {
  const escaped = String(value).replace(/^[=+\-@\t\r]/, (match) => "'" + match);
  return '"' + escaped.replace(/"/g, '""') + '"';
}

export function useFactoryEmployeeBonusesTabState() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const [empFilter, setEmpFilter] = useState("all");
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [visibleColumns, setVisibleColumns] = useState({ amount: true, notes: true });
  const [addOpen, setAddOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<BonusRecord | null>(null);
  const [addForm, setAddForm] = useState({ employeeId: "", bonusDate: today(), amount: "", notes: "" });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const qKey = useMemo(
    () => companyQueryKey("/api/factory/employee-bonuses", selectedCompany?.id, empFilter),
    [selectedCompany?.id, empFilter]
  );

  const { data: bonuses = [], isLoading } = useQuery<BonusRecord[]>({
    queryKey: qKey,
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (empFilter !== "all") params.set("employeeId", empFilter);
      const res = await fetch(`/api/factory/employee-bonuses?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const shownBonuses = useMemo(
    () =>
      bonuses.filter((b) => {
        const day = bonusDate(b).slice(0, 10);
        if (startDate && (!day || day < startDate)) return false;
        if (endDate && (!day || day > endDate)) return false;
        const needle = search.trim().toLowerCase();
        return (
          !needle ||
          [bonusName(b), b.employeeCode || b.employee_code || "", b.notes || ""].some((value) =>
            value.toLowerCase().includes(needle)
          )
        );
      }),
    [bonuses, startDate, endDate, search]
  );
  const totalBonuses = useMemo(
    () => shownBonuses.reduce((sum, b) => sum + parseFloat(b.amount || "0"), 0),
    [shownBonuses]
  );

  function exportBonusesCsv() {
    const rows = [
      ["Employee Name", "Date", "Amount", "Notes"],
      ...shownBonuses.map((b) => [bonusName(b), bonusDate(b).slice(0, 10), b.amount, b.notes || ""]),
    ];
    const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      exportFileName("employee bonuses", "csv", { from: startDate || undefined, to: endDate || undefined })
    );
  }

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/factory/employee-bonuses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          employeeId: parseInt(addForm.employeeId),
          bonusDate: addForm.bonusDate,
          amount: addForm.amount,
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
      toast({ title: "Bonus credited to employee account" });
      setAddOpen(false);
      setAddForm({ employeeId: "", bonusDate: today(), amount: "", notes: "" });
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employee-bonuses", selectedCompany?.id),
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await fetch(`/api/factory/employee-bonuses/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
    },
    onSuccess: () => {
      toast({ title: "Bonus reversed and deleted" });
      setDeleteConfirm(null);
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employee-bonuses", selectedCompany?.id),
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });
  return {
    AdminDialog,
    addForm,
    addMutation,
    addOpen,
    bonuses,
    deleteConfirm,
    deleteMutation,
    empFilter,
    employees,
    endDate,
    exportBonusesCsv,
    isLoading,
    recordChanges,
    search,
    setAddForm,
    setAddOpen,
    setDeleteConfirm,
    setEmpFilter,
    setEndDate,
    setSearch,
    setShowFilters,
    setStartDate,
    setVisibleColumns,
    showFilters,
    shownBonuses,
    startDate,
    totalBonuses,
    visibleColumns,
    wrapAdminAction,
  };
}
