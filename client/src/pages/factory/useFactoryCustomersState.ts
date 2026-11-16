// Extracted from ./FactoryCustomers.tsx to keep that module under the source-size cap.
import { downloadBlob } from "@/lib/downloadBlob";
import { searchAny } from "@shared/searchNormalization";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useState } from "react";
import { useLocation } from "wouter";
import { useSingleFlightAction } from "@/hooks/use-single-flight-action";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useTablePrefs } from "@/hooks/use-table-prefs";
import { useClientTablePagination } from "@/hooks/use-client-table-pagination";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { Customer } from "./factorycustomers/types";

export function useFactoryCustomersState() {
  const { toast } = useToast();
  const { execute: executeSave, pending: saving } = useSingleFlightAction();
  const { formatCashAmount } = useCurrencyContext();
  const [, navigate] = useLocation();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const { prefs, setPrefs } = useTablePrefs("factory-customers", { companyId: selectedCompany?.id });

  const pageSize = prefs.pageSize ?? 25;
  const [search, setSearch] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [deletingCustomer, setDeletingCustomer] = useState<Customer | null>(null);
  const [showDeleted] = useState(false);
  const [showZeroBalance, setShowZeroBalance] = useState(false);
  const [balanceFilter, setBalanceFilter] = useState<"all" | "Dr" | "Cr">("all");
  const showBalanceColumn = prefs.columns?.balance !== false;
  const showActionsColumn = prefs.columns?.actions !== false;
  const setColumnVisible = (column: "balance" | "actions", visible: boolean) => {
    setPrefs({ columns: { ...prefs.columns, [column]: visible } });
  };
  const [formData, setFormData] = useState({
    legalName: "",
    phone: "",
    openingBalance: "",
    openingBalanceSide: "Dr",
    paymentTermsDays: "" as string,
  });

  const {
    data: customers = [],
    isLoading,
    isError,
    error,
    refetch: refetchCustomers,
  } = useQuery<Customer[]>({
    queryKey: companyQueryKey("/api/factory/customers", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const createMutation = useMutation({
    mutationFn: async (data: {
      legalName: string;
      phone?: string;
      openingBalance?: string;
      openingBalanceSide?: string;
      paymentTermsDays?: number;
    }) => {
      return await factoryApiRequest("POST", "/api/factory/customers", data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Customer created" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      setIsCreateOpen(false);
      resetForm();
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: number;
      data: { legalName: string; phone: string | null; paymentTermsDays: number | null };
    }) => {
      return await factoryApiRequest("PUT", `/api/factory/customers/${id}`, data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Customer updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      setEditingCustomer(null);
      resetForm();
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      return await factoryApiRequest("DELETE", `/api/factory/customers/${id}`, {});
    },
    onSuccess: () => {
      toast({ title: "Customer deleted", description: "You can restore them from the deleted customers list." });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers/deleted"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      setDeletingCustomer(null);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const { data: deletedCustomers = [] } = useQuery<Customer[]>({
    queryKey: companyQueryKey("/api/factory/customers/deleted", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id) && showDeleted,
  });

  const restoreMutation = useMutation({
    mutationFn: async (id: number) => {
      return await factoryApiRequest("POST", `/api/factory/customers/${id}/restore`, {});
    },
    onSuccess: () => {
      toast({ title: "Customer restored", description: "The customer is now active again." });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/customers/deleted"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setFormData({ legalName: "", phone: "", openingBalance: "", openingBalanceSide: "Dr", paymentTermsDays: "" });
  };

  const openCreate = () => {
    resetForm();
    setIsCreateOpen(true);
  };

  const openEdit = (customer: Customer) => {
    setEditingCustomer(customer);
    setFormData({
      legalName: customer.legalName,
      phone: customer.phone || "",
      openingBalance: customer.openingBalance || "",
      openingBalanceSide: customer.openingBalanceSide || "Dr",
      paymentTermsDays: customer.paymentTermsDays != null ? String(customer.paymentTermsDays) : "",
    });
  };

  const handleCreate = () => {
    if (!formData.legalName.trim() || saving || createMutation.isPending) return;
    const days = formData.paymentTermsDays ? parseInt(formData.paymentTermsDays) : undefined;
    void executeSave(() =>
      createMutation.mutateAsync({
        legalName: formData.legalName.trim(),
        phone: formData.phone.trim() || undefined,
        openingBalance: formData.openingBalance || undefined,
        openingBalanceSide: formData.openingBalanceSide || undefined,
        paymentTermsDays: days || undefined,
      })
    ).catch(() => {
      // Existing mutation.onError provides feedback.
    });
  };

  const handleUpdate = () => {
    if (!editingCustomer || !formData.legalName.trim() || saving || updateMutation.isPending) return;
    const days = formData.paymentTermsDays ? parseInt(formData.paymentTermsDays) : null;
    void executeSave(() =>
      updateMutation.mutateAsync({
        id: editingCustomer.id,
        data: {
          legalName: formData.legalName.trim(),
          phone: formData.phone.trim() || null,
          paymentTermsDays: days,
        },
      })
    ).catch(() => {
      // Existing mutation.onError provides feedback.
    });
  };

  const filtered = customers.filter((c) => {
    if (!search) return true;
    return searchAny(search, c.legalName, c.code, c.phone);
  });
  const zeroBalanceCount = filtered.filter((customer) => Math.abs(customer.balance ?? 0) <= 0.001).length;
  const visibleCustomers = (
    showZeroBalance ? filtered : filtered.filter((customer) => Math.abs(customer.balance ?? 0) > 0.001)
  ).filter(
    (customer) => balanceFilter === "all" || customer.balanceSide?.toUpperCase() === balanceFilter.toUpperCase()
  );
  const { page: safePage, setPage, totalPages, paginate } = useClientTablePagination(visibleCustomers.length, pageSize);
  const pagedCustomers = paginate(visibleCustomers);

  // Display-only summaries of the existing API amounts. The API supplies an
  // unsigned magnitude and a separate debit/credit side; never infer the
  // accounting side from the amount's sign or use these sums for posting.
  const { totalDebit, totalCredit } = customers.reduce(
    (totals, customer) => {
      const amount = Number(customer.balance);
      if (!Number.isFinite(amount) || Math.abs(amount) <= 0.001) return totals;
      if (customer.balanceSide?.toUpperCase() === "DR") totals.totalDebit += Math.abs(amount);
      if (customer.balanceSide?.toUpperCase() === "CR") totals.totalCredit += Math.abs(amount);
      return totals;
    },
    { totalDebit: 0, totalCredit: 0 }
  );
  const netBalance = totalDebit - totalCredit;

  const exportVisibleCustomers = () => {
    // Export the current client-side view without touching accounting data.
    // Escape spreadsheet formulas in user-provided text to avoid CSV injection.
    const csvCell = (value: string | number) => {
      const raw = String(value ?? "");
      const safe = /^[\s]*[=+@-]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const rows = [
      ["Customer Name", "Code", "Phone", "Balance", "Balance Type"],
      ...visibleCustomers.map((customer) => [
        customer.legalName,
        customer.code,
        customer.phone ?? "",
        customer.balance == null ? "" : String(customer.balance),
        customer.balanceSide?.toUpperCase() === "CR"
          ? "Credit"
          : customer.balanceSide?.toUpperCase() === "DR"
            ? "Debit"
            : "",
      ]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadBlob(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }), "factory-customers.csv");
  };
  return {
    balanceFilter,
    createMutation,
    customers,
    deleteMutation,
    deletedCustomers,
    deletingCustomer,
    editingCustomer,
    error,
    exportVisibleCustomers,
    formData,
    formatCashAmount,
    handleCreate,
    handleUpdate,
    isCreateOpen,
    isError,
    isLoading,
    navigate,
    netBalance,
    openCreate,
    openEdit,
    pageSize,
    pagedCustomers,
    prefs,
    recordChanges,
    refetchCustomers,
    resetForm,
    restoreMutation,
    safePage,
    saving,
    search,
    setBalanceFilter,
    setColumnVisible,
    setDeletingCustomer,
    setEditingCustomer,
    setFormData,
    setIsCreateOpen,
    setPage,
    setPrefs,
    setSearch,
    setShowZeroBalance,
    showActionsColumn,
    showBalanceColumn,
    showDeleted,
    showZeroBalance,
    totalCredit,
    totalDebit,
    totalPages,
    updateMutation,
    visibleCustomers,
    zeroBalanceCount,
  };
}
