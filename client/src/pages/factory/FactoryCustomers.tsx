import { downloadBlob } from "@/lib/downloadBlob";
import { searchAny } from "@shared/searchNormalization";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { drCrClass } from "@/lib/formatNumber";
import { factoryApiRequest } from "@/lib/factoryApi";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { useLocation } from "wouter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Plus,
  Pencil,
  Trash2,
  FileText,
  RotateCcw,
  History,
  Eye,
  EyeOff,
  Users,
  Wallet,
  Scale,
  SlidersHorizontal,
  Columns3,
  Download,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useSingleFlightAction } from "@/hooks/use-single-flight-action";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { PageHeader } from "@/components/PageHeader";
import { ErrorState } from "@/components/ui/page-state";
import { DataTableToolbar } from "@/components/DataTableToolbar";
import { PaginationBar } from "@/components/PaginationBar";
import { useTablePrefs } from "@/hooks/use-table-prefs";
import { useClientTablePagination } from "@/hooks/use-client-table-pagination";
import { useCompany } from "@/contexts/CompanyContext";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { FactoryCustomerFormDialogs } from "./factorycustomers/FactoryCustomerFormDialogs";
import type { Customer } from "./factorycustomers/types";

export default function FactoryCustomers() {
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
    queryKey: ["/api/factory/customers"],
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
    queryKey: ["/api/factory/customers/deleted"],
    enabled: showDeleted,
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

  if (isLoading) {
    return (
      <div className="flex flex-col h-full p-6 gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col h-full p-6 gap-4">
        <PageHeader title="Customers" />
        <ErrorState
          title="Customers could not be loaded"
          description={error?.message || "Please try again."}
          actionLabel="Retry"
          onAction={() => {
            void refetchCustomers();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6" data-testid="factory-customers-directory">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="customer-balance-summary">
        <div className="rounded-2xl border border-blue-500/25 bg-blue-500/5 p-3 shadow-sm sm:p-4 dark:border-blue-400/30 dark:bg-blue-500/10">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-blue-500/15 p-2.5 text-blue-600 dark:text-blue-400">
              <Users className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total Customers</p>
              <p className="mt-1 text-xl font-bold tabular-nums sm:text-2xl" data-testid="metric-customers-total">
                {customers.length}
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-3 shadow-sm sm:p-4 dark:border-emerald-400/30 dark:bg-emerald-500/10">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-emerald-500/15 p-2.5 text-emerald-600 dark:text-emerald-400">
              <Wallet className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total Debit</p>
              <p
                className="mt-1 break-all text-base font-bold tabular-nums text-emerald-600 sm:text-xl dark:text-emerald-400"
                data-testid="metric-customers-debit"
              >
                {formatCashAmount(totalDebit)}
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-rose-500/25 bg-rose-500/5 p-3 shadow-sm sm:p-4 dark:border-rose-400/30 dark:bg-rose-500/10">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-rose-500/15 p-2.5 text-rose-600 dark:text-rose-400">
              <Wallet className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total Credit</p>
              <p
                className="mt-1 break-all text-base font-bold tabular-nums text-rose-600 sm:text-xl dark:text-rose-400"
                data-testid="metric-customers-credit"
              >
                {formatCashAmount(totalCredit)}
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-violet-500/25 bg-violet-500/5 p-3 shadow-sm sm:p-4 dark:border-violet-400/30 dark:bg-violet-500/10">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-violet-500/15 p-2.5 text-violet-600 dark:text-violet-400">
              <Scale className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Net Balance</p>
              <p
                className={`mt-1 break-all text-base font-bold tabular-nums sm:text-xl ${netBalance < -0.001 ? "text-rose-600 dark:text-rose-400" : netBalance > 0.001 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"}`}
                data-testid="metric-customers-net"
              >
                {netBalance < -0.001 ? "−" : ""}
                {formatCashAmount(Math.abs(netBalance))}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-blue-500/10 p-2.5 text-blue-600 dark:text-sky-400">
            <Users className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">
              Customers
            </h1>
            <p className="text-sm text-muted-foreground">{customers.length} total customers</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {zeroBalanceCount > 0 && (
            <Button
              variant="outline"
              onClick={() => {
                setShowZeroBalance((visible) => !visible);
                setPage(1);
              }}
              aria-pressed={showZeroBalance}
              data-testid="button-toggle-zero-balance"
              size="sm"
              className="h-9 gap-2 rounded-lg px-4"
            >
              {showZeroBalance ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              {showZeroBalance ? "Hide 0 Balance" : `Show 0 Balance (${zeroBalanceCount})`}
            </Button>
          )}
          {!recordChanges.isCreateOnly && (
            <Button
              onClick={openCreate}
              data-testid="button-add-customer"
              size="sm"
              className="h-10 gap-2 rounded-xl bg-blue-600 px-4 text-white shadow-sm hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" />
              Add Customer
            </Button>
          )}
        </div>
      </div>

      <DataTableToolbar
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchPlaceholder="Search by name, code, or phone..."
        searchTestId="input-search-customers"
        className="mb-0"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-2 rounded-xl"
                  data-testid="button-customer-balance-filter"
                >
                  <SlidersHorizontal className="h-4 w-4" /> Filters <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Balance side</DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={() => {
                    setBalanceFilter("all");
                    setPage(1);
                  }}
                >
                  All balances {balanceFilter === "all" ? "✓" : ""}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setBalanceFilter("Dr");
                    setPage(1);
                  }}
                >
                  Debit balances {balanceFilter === "Dr" ? "✓" : ""}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    setBalanceFilter("Cr");
                    setPage(1);
                  }}
                >
                  Credit balances {balanceFilter === "Cr" ? "✓" : ""}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-2 rounded-xl"
                  data-testid="button-customer-columns"
                >
                  <Columns3 className="h-4 w-4" /> Columns <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Visible columns (saved)</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem checked disabled>
                  Name
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={showBalanceColumn}
                  onCheckedChange={(checked) => setColumnVisible("balance", checked)}
                >
                  Balance
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={showActionsColumn}
                  onCheckedChange={(checked) => setColumnVisible("actions", checked)}
                >
                  Actions
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 rounded-xl"
              onClick={exportVisibleCustomers}
              data-testid="button-export-customers"
            >
              <Download className="h-4 w-4" /> Export
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 rounded-xl"
              onClick={() => void refetchCustomers()}
              title="Refresh customers"
              aria-label="Refresh customers"
              data-testid="button-refresh-customers"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        }
      />

      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm dark:border-blue-400/20 dark:bg-slate-950/40">
        <div className="table-responsive">
          <Table mobileLayout="cards" density={prefs.density} wrapperClassName="border-0 rounded-none dark:border-0">
            <TableHeader className="sticky top-0 z-30">
              <TableRow className="bg-muted/65 hover:bg-muted/65 dark:bg-blue-900/25 dark:hover:bg-blue-900/25">
                <TableHead className="py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Name
                </TableHead>
                {showBalanceColumn && (
                  <TableHead className="py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Balance
                  </TableHead>
                )}
                {showActionsColumn && (
                  <TableHead className="w-[144px] py-3 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleCustomers.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={1 + Number(showBalanceColumn) + Number(showActionsColumn)}
                    className="text-center py-8 text-muted-foreground"
                  >
                    {search
                      ? "No customers match your search"
                      : zeroBalanceCount > 0
                        ? "All customers currently have a zero balance"
                        : "No customers yet"}
                  </TableCell>
                </TableRow>
              ) : (
                pagedCustomers.map((customer) => (
                  <TableRow
                    key={customer.id}
                    className="hover:bg-blue-500/5 dark:hover:bg-blue-500/10"
                    data-testid={`row-customer-${customer.id}`}
                  >
                    <TableCell className="py-3 font-medium sm:py-3" data-testid={`text-customer-name-${customer.id}`}>
                      <div className="flex items-center gap-3">
                        <div
                          aria-hidden="true"
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600/10 text-xs font-bold text-blue-600 dark:bg-blue-400/15 dark:text-blue-300"
                        >
                          {(customer.legalName ?? "")
                            .trim()
                            .split(/\s+/)
                            .slice(0, 2)
                            .map((part) => part.charAt(0))
                            .join("")
                            .toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <button
                            className="text-left font-semibold text-foreground hover:underline"
                            onClick={() => navigate(`/factory/customers/${customer.id}`)}
                            data-testid={`button-open-statement-${customer.id}`}
                          >
                            {customer.legalName}
                          </button>
                          {customer.phone && <p className="mt-0.5 text-xs text-muted-foreground">{customer.phone}</p>}
                        </div>
                      </div>
                    </TableCell>
                    {showBalanceColumn && (
                      <TableCell className="py-3 text-right font-mono sm:py-3">
                        {customer.balance !== undefined ? (
                          <span
                            className={`text-sm font-bold tabular-nums ${Math.abs(customer.balance) <= 0.001 ? "text-muted-foreground" : drCrClass(customer.balanceSide)}`}
                            data-testid={`text-customer-balance-${customer.id}`}
                            title={customer.balanceSide?.toUpperCase() === "CR" ? "Credit balance" : "Debit balance"}
                            aria-label={`${formatCashAmount(customer.balance)} ${customer.balanceSide?.toUpperCase() === "CR" ? "credit" : "debit"} balance`}
                          >
                            {formatCashAmount(customer.balance)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    )}
                    {showActionsColumn && (
                      <TableCell className="py-3 sm:py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => navigate(`/factory/invoicing?tab=proformas&customerId=${customer.id}`)}
                            title="View Proformas"
                            aria-label={`View proformas for ${customer.legalName}`}
                            className="h-9 w-9 rounded-xl border border-border/60 hover:border-blue-400/60 hover:text-blue-500"
                            data-testid={`button-proformas-customer-${customer.id}`}
                          >
                            <FileText className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEdit(customer)}
                            disabled={!recordChanges.allowed}
                            title={recordChanges.reason ?? "Edit Customer"}
                            aria-label={recordChanges.reason ?? `Edit ${customer.legalName}`}
                            className="h-9 w-9 rounded-xl border border-border/60 hover:border-blue-400/60 hover:text-blue-500"
                            data-testid={`button-edit-customer-${customer.id}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <div className="w-px h-5 bg-border mx-0.5" />
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeletingCustomer(customer)}
                            disabled={!recordChanges.allowed}
                            title={recordChanges.reason ?? "Delete Customer"}
                            aria-label={recordChanges.reason ?? `Delete ${customer.legalName}`}
                            className="h-9 w-9 rounded-xl border border-destructive/20 text-destructive hover:border-destructive/50 hover:bg-destructive/10"
                            data-testid={`button-delete-customer-${customer.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      <PaginationBar
        page={safePage}
        totalPages={totalPages}
        total={visibleCustomers.length}
        pageSize={pageSize}
        onPageChange={setPage}
        noun="customers"
        onPageSizeChange={(size) => {
          setPrefs({ pageSize: size });
          setPage(1);
        }}
      />

      {showDeleted && (
        <div className="rounded-xl border overflow-hidden mt-6">
          <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
            <History className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Deleted Customers</span>
            {deletedCustomers.length > 0 && (
              <Badge variant="secondary" className="no-default-hover-elevate no-default-active-elevate text-xs">
                {deletedCustomers.length}
              </Badge>
            )}
          </div>
          {deletedCustomers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8 px-4">No deleted customers found</p>
          ) : (
            <div className="table-responsive">
              <Table mobileLayout="cards">
                <TableHeader className="sticky top-0 z-30">
                  <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
                    <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
                      Name
                    </TableHead>
                    <TableHead className="w-[80px] py-2"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deletedCustomers.map((customer) => (
                    <TableRow key={customer.id} data-testid={`row-deleted-customer-${customer.id}`}>
                      <TableCell className="font-medium text-muted-foreground">{customer.legalName}</TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => restoreMutation.mutate(customer.id)}
                          disabled={restoreMutation.isPending || !recordChanges.allowed}
                          title={recordChanges.reason ?? undefined}
                          data-testid={`button-restore-customer-${customer.id}`}
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Restore
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <FactoryCustomerFormDialogs
        isCreateOpen={isCreateOpen}
        editingCustomer={editingCustomer}
        formData={formData}
        setFormData={setFormData}
        saving={saving}
        createPending={createMutation.isPending}
        updatePending={updateMutation.isPending}
        onCloseCreate={() => {
          setIsCreateOpen(false);
          resetForm();
        }}
        onCloseEdit={() => {
          setEditingCustomer(null);
          resetForm();
        }}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
      />

      <ConfirmDialog
        open={!!deletingCustomer}
        onOpenChange={(open) => {
          if (!open) setDeletingCustomer(null);
        }}
        title="Delete Customer"
        tone="destructive"
        confirmText={deleteMutation.isPending ? "Deleting..." : "Delete"}
        loading={deleteMutation.isPending}
        onConfirm={async () => {
          if (deletingCustomer) await deleteMutation.mutateAsync(deletingCustomer.id);
        }}
        description={
          <span>
            Are you sure you want to delete <strong>{deletingCustomer?.legalName}</strong>? They will be hidden from the
            customers list. You can restore them later from the "Deleted Customers" section.
          </span>
        }
      />
    </div>
  );
}
