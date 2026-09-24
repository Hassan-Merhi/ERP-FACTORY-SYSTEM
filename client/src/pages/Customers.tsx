import { searchIncludes } from "@shared/searchNormalization";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { customersApi } from "@/api/customersApi";
import { drCrClass } from "@/lib/formatNumber";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import {
  Plus,
  Search,
  Building2,
  Pencil,
  Users,
  Wallet,
  TrendingUp,
  TrendingDown,
  EyeOff,
  Eye,
  Printer,
} from "lucide-react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocation } from "wouter";
import { useState, useEffect } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { insertCustomerSchema, type Customer } from "@shared/schema";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { z } from "zod";
import { usePaginatedFilterState } from "@/hooks/use-paginated-filter-state";

const formSchema = insertCustomerSchema.extend({
  legalName: z.string().min(1, "Legal name is required"),
});

const typeBadgeClass: Record<string, string> = {
  Payment: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  Receipt: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  Journal: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  "Credit Note": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  "Debit Note": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  Transfer: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
  Adjustment: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
};

type CustomerCurrencyBalances = Record<string, { debit: number; credit: number; net: number }>;

function getCustomerCurrencyBalances(customer: unknown): CustomerCurrencyBalances | undefined {
  if (!customer || typeof customer !== "object") return undefined;
  const balances = (customer as { balancesByCurrency?: unknown }).balancesByCurrency;
  return balances && typeof balances === "object" ? (balances as CustomerCurrencyBalances) : undefined;
}

export default function Customers() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { formatHistoricalBaseAmount } = useCurrencyContext();
  const [, _navigate] = useLocation();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const {
    filters: { searchQuery, hideZero },
    setFilter,
    resetFilters,
    hasActiveFilters,
  } = usePaginatedFilterState<{ searchQuery: string; hideZero: boolean }>({
    createInitialFilters: () => ({ searchQuery: "", hideZero: true }),
    storageKey: selectedCompany?.id ? `erp-customers-filters-v1:${selectedCompany.id}` : undefined,
  });
  const [statementCustomer, setStatementCustomer] = useState<
    (Customer & { balance: number; balanceSide: string }) | null
  >(null);

  const { data: ledgerTxns = [], isLoading: txnsLoading } = useQuery({
    queryKey: ["/api/customers", statementCustomer?.id, "transactions"],
    queryFn: () => fetch(`/api/customers/${statementCustomer!.id}/transactions`).then((r) => r.json()),
    enabled: !!statementCustomer?.id,
  });

  const { data: customers = [], isLoading } = useQuery<(Customer & { balance: number; balanceSide: string })[]>({
    queryKey: ["/api/customers/stats", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      companyId: selectedCompany?.id || 0,
      legalName: "",
      phone: "",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    },
  });

  useEffect(() => {
    if (selectedCompany?.id) {
      form.reset({
        companyId: selectedCompany.id,
        legalName: "",
        phone: "",
        openingBalance: "0",
        openingBalanceSide: "Dr",
      });
    }
  }, [selectedCompany?.id, form]);

  const createMutation = useMutation({
    mutationFn: async (data: z.infer<typeof formSchema>) => {
      return await customersApi.create(data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Customer created successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/stats", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts", selectedCompany?.id] });
      setIsCreateOpen(false);
      form.reset({
        companyId: selectedCompany?.id || 0,
        legalName: "",
        phone: "",
        openingBalance: "0",
        openingBalanceSide: "Dr",
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: z.infer<typeof formSchema> & { id: number }) => {
      return await customersApi.update(data.id, data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Customer updated successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/customers/stats", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts", selectedCompany?.id] });
      setIsEditOpen(false);
      setEditingCustomer(null);
      form.reset({
        companyId: selectedCompany?.id || 0,
        legalName: "",
        phone: "",
        openingBalance: "0",
        openingBalanceSide: "Dr",
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: z.infer<typeof formSchema>) => {
    if (editingCustomer) {
      updateMutation.mutate({ ...data, id: editingCustomer.id });
    } else {
      createMutation.mutate(data);
    }
  };

  const handleEditClick = (customer: Customer) => {
    setEditingCustomer(customer);
    form.reset({
      companyId: customer.companyId,
      legalName: customer.legalName,
      phone: customer.phone || "",
      openingBalance: customer.openingBalance || "0",
      openingBalanceSide:
        customer.openingBalanceSide === "Dr" || customer.openingBalanceSide === "Cr"
          ? customer.openingBalanceSide
          : "Dr",
    });
    setIsEditOpen(true);
  };

  const filteredCustomers = customers.filter((customer) => {
    const matchesSearch = searchIncludes(customer.legalName, searchQuery);
    const hasBalance = (customer.balance || 0) !== 0;
    if (!matchesSearch) return false;
    if (hideZero && !hasBalance && !searchQuery) return false;
    return true;
  });

  // Stats
  const totalCustomers = customers.length;
  const withBalance = customers.filter((c) => (c.balance || 0) !== 0).length;
  const totalReceivable = customers
    .filter((c) => c.balanceSide === "Dr" && (c.balance || 0) > 0)
    .reduce((s, c) => s + (c.balance || 0), 0);
  const totalPayable = customers
    .filter((c) => c.balanceSide === "Cr" && (c.balance || 0) > 0)
    .reduce((s, c) => s + (c.balance || 0), 0);

  const CustomerForm = ({ isEdit }: { isEdit: boolean }) => (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormField
          control={form.control}
          name="legalName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Legal Name *</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder="ABC Company Ltd."
                  data-testid={isEdit ? "input-edit-legal-name" : "input-legal-name"}
                />
              </FormControl>
              {!isEdit && <FormDescription>Customer code will be auto-generated</FormDescription>}
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Phone Number</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  value={field.value || ""}
                  placeholder="+1234567890"
                  data-testid={isEdit ? "input-edit-phone" : "input-phone"}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="openingBalance"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Opening Balance</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    value={field.value || "0"}
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    data-testid={isEdit ? "input-edit-opening-balance" : "input-opening-balance"}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="openingBalanceSide"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Balance Side</FormLabel>
                <Select onValueChange={field.onChange} value={field.value || "Dr"}>
                  <FormControl>
                    <SelectTrigger data-testid={isEdit ? "select-edit-balance-side" : "select-balance-side"}>
                      <SelectValue placeholder="Select side" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="Dr">Dr (Debit)</SelectItem>
                    <SelectItem value="Cr">Cr (Credit)</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => (isEdit ? setIsEditOpen(false) : setIsCreateOpen(false))}
            data-testid={isEdit ? "button-edit-cancel" : "button-cancel"}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isEdit ? updateMutation.isPending : createMutation.isPending}
            data-testid={isEdit ? "button-submit-edit-customer" : "button-submit-customer"}
          >
            {isEdit
              ? updateMutation.isPending
                ? "Updating..."
                : "Update Customer"
              : createMutation.isPending
                ? "Creating..."
                : "Create Customer"}
          </Button>
        </div>
      </form>
    </Form>
  );

  return (
    <div className="flex flex-col h-full gap-5 py-3 sm:p-6">
      {/* Header */}
      <PageHeader title="Customers" subtitle="Manage customer accounts and receivables" showBackButton={false}>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-create-customer">
              <Plus className="mr-2 h-4 w-4" />
              New Customer
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Create New Customer</DialogTitle>
            </DialogHeader>
            <CustomerForm isEdit={false} />
          </DialogContent>
        </Dialog>
      </PageHeader>

      {/* Stats pills */}
      <div className="flex flex-wrap gap-3">
        {isLoading ? (
          <>
            <Skeleton className="h-10 w-40 rounded-lg" />
            <Skeleton className="h-10 w-40 rounded-lg" />
            <Skeleton className="h-10 w-44 rounded-lg" />
            <Skeleton className="h-10 w-44 rounded-lg" />
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Total Customers</span>
              <span className="font-semibold">{totalCustomers}</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <Wallet className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">With Balance</span>
              <span className="font-semibold">{withBalance}</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <TrendingUp className="h-4 w-4 text-blue-500" />
              <span className="text-muted-foreground">Receivable</span>
              <span className="font-semibold font-mono">{formatHistoricalBaseAmount(totalReceivable)}</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
              <TrendingDown className="h-4 w-4 text-red-500" />
              <span className="text-muted-foreground">Payable</span>
              <span className="font-semibold font-mono">{formatHistoricalBaseAmount(totalPayable)}</span>
            </div>
          </>
        )}
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search customers..."
            value={searchQuery}
            onChange={(e) => setFilter("searchQuery", e.target.value)}
            className="pl-9"
            data-testid="input-search-customers"
          />
        </div>
        <Button
          variant="outline"
          onClick={() => setFilter("hideZero", !hideZero)}
          data-testid="button-toggle-hide-zero"
        >
          {hideZero ? <Eye className="mr-2 h-4 w-4" /> : <EyeOff className="mr-2 h-4 w-4" />}
          {hideZero ? "Show Zero" : "Hide Zero"}
        </Button>
        {hasActiveFilters && (
          <Button variant="outline" type="button" onClick={resetFilters} data-testid="button-reset-filters">
            Reset filters
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="border rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="text-xs h-9 font-semibold">Customer</TableHead>
              <TableHead className="text-xs h-9 font-semibold text-right">Balance</TableHead>
              <TableHead className="text-xs h-9 font-semibold w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [...Array(6)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Skeleton className="h-4 w-40" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-28" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-28 ml-auto" />
                  </TableCell>
                  <TableCell></TableCell>
                </TableRow>
              ))
            ) : filteredCustomers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium">No customers found</p>
                    <p className="text-xs text-muted-foreground">
                      {searchQuery ? "Try a different search term" : "Add your first customer to get started"}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filteredCustomers.map((customer) => (
                <TableRow
                  key={customer.id}
                  className="group cursor-pointer hover:bg-muted/40"
                  data-testid={`row-customer-${customer.id}`}
                  onClick={() => setStatementCustomer(customer)}
                >
                  <TableCell className="py-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="font-medium text-sm" data-testid={`text-customer-name-${customer.id}`}>
                        {customer.legalName}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span className={`font-mono font-semibold text-sm ${drCrClass(customer.balanceSide || "Dr")}`}>
                        {formatHistoricalBaseAmount(customer.balance || 0)}
                      </span>
                      <Badge variant="secondary" className={`text-xs ${drCrClass(customer.balanceSide || "Dr")}`}>
                        {customer.balanceSide || "Dr"}
                      </Badge>
                    </div>
                    {getCustomerCurrencyBalances(customer) &&
                      Object.keys(getCustomerCurrencyBalances(customer)!).length > 0 && (
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          Native:{" "}
                          {Object.entries(getCustomerCurrencyBalances(customer)!)
                            .map(
                              ([currency, value]) =>
                                `${currency} ${Math.abs(value.net).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                            )
                            .join(" · ")}
                        </div>
                      )}
                  </TableCell>
                  <TableCell className="py-3">
                    <div className="flex items-center justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditClick(customer);
                        }}
                        data-testid={`button-edit-customer-${customer.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Edit Dialog */}
      <Dialog
        open={isEditOpen}
        onOpenChange={(open) => {
          setIsEditOpen(open);
          if (!open) {
            setEditingCustomer(null);
            form.reset({
              companyId: selectedCompany?.id || 0,
              legalName: "",
              phone: "",
              openingBalance: "0",
              openingBalanceSide: "Dr",
            });
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Customer</DialogTitle>
          </DialogHeader>
          <CustomerForm isEdit={true} />
        </DialogContent>
      </Dialog>

      {/* Statement Dialog */}
      <Dialog open={!!statementCustomer} onOpenChange={(open) => !open && setStatementCustomer(null)}>
        <DialogContent className="max-w-3xl w-[95vw] max-h-[85vh] overflow-hidden flex flex-col gap-4">
          <DialogHeader className="pb-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              {statementCustomer?.legalName}
            </DialogTitle>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
                <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">Balance</span>
                <span className={`font-mono font-semibold ${drCrClass(statementCustomer?.balanceSide || "Dr")}`}>
                  {formatHistoricalBaseAmount(statementCustomer?.balance || 0)}
                </span>
                <Badge variant="secondary" className={`text-xs ${drCrClass(statementCustomer?.balanceSide || "Dr")}`}>
                  {statementCustomer?.balanceSide || "Dr"}
                </Badge>
              </div>
              {!txnsLoading && (
                <span className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground font-medium">
                  {ledgerTxns.length} transaction{ledgerTxns.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto min-h-0">
            {txnsLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : (
              (() => {
                const sorted = [...ledgerTxns].sort(
                  (a, b) => new Date(a.voucherDate).getTime() - new Date(b.voucherDate).getTime()
                );
                const totalDr = sorted.reduce((s, t) => s + parseFloat(t.debitAmount || "0"), 0);
                const totalCr = sorted.reduce((s, t) => s + parseFloat(t.creditAmount || "0"), 0);
                const closingBalance = statementCustomer?.balance || 0;
                const openingBalance = closingBalance - totalDr + totalCr;
                let running = openingBalance;

                return sorted.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium">No transactions</p>
                    <p className="text-xs text-muted-foreground">No ledger entries found for this customer</p>
                  </div>
                ) : (
                  <div className="border rounded-xl overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableHead className="text-xs h-9 font-semibold">Date</TableHead>
                          <TableHead className="text-xs h-9 font-semibold">Type</TableHead>
                          <TableHead className="text-xs h-9 font-semibold">Description</TableHead>
                          <TableHead className="text-xs h-9 font-semibold text-right">Debit</TableHead>
                          <TableHead className="text-xs h-9 font-semibold text-right">Credit</TableHead>
                          <TableHead className="text-xs h-9 font-semibold text-right">Balance</TableHead>
                          <TableHead className="text-xs h-9 w-8"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {openingBalance !== 0 && (
                          <TableRow className="text-muted-foreground text-xs italic">
                            <TableCell className="py-2">—</TableCell>
                            <TableCell className="py-2"></TableCell>
                            <TableCell className="py-2">Opening Balance</TableCell>
                            <TableCell className="py-2"></TableCell>
                            <TableCell className="py-2"></TableCell>
                            <TableCell className="py-2 text-right font-mono font-medium">
                              {formatHistoricalBaseAmount(Math.abs(openingBalance))}
                            </TableCell>
                            <TableCell className="py-2"></TableCell>
                          </TableRow>
                        )}
                        {sorted.map((t, i) => {
                          const dr = parseFloat(t.debitAmount || "0");
                          const cr = parseFloat(t.creditAmount || "0");
                          running = running + dr - cr;
                          const isSale = t.voucherType === "Sales" && t.voucherId;
                          return (
                            <TableRow key={t.entryId ?? i} className="text-xs hover:bg-muted/40">
                              <TableCell className="py-2 font-mono whitespace-nowrap">
                                {t.voucherDate ? format(new Date(t.voucherDate), "yyyy-MM-dd") : "—"}
                              </TableCell>
                              <TableCell className="py-2">
                                {t.voucherType ? (
                                  <Badge
                                    variant="secondary"
                                    className={`text-xs ${typeBadgeClass[t.voucherType] || ""}`}
                                  >
                                    {t.voucherType}
                                  </Badge>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                              <TableCell className="py-2 text-muted-foreground max-w-[160px] truncate">
                                {t.narration || t.voucherDescription || "—"}
                              </TableCell>
                              <TableCell className="py-2 text-right font-mono">
                                {dr > 0 ? formatHistoricalBaseAmount(dr) : ""}
                              </TableCell>
                              <TableCell className="py-2 text-right font-mono">
                                {cr > 0 ? formatHistoricalBaseAmount(cr) : ""}
                              </TableCell>
                              <TableCell className="py-2 text-right font-mono font-medium">
                                {formatHistoricalBaseAmount(Math.abs(running))}
                                <span className={`text-xs font-semibold ml-1 ${drCrClass(running >= 0 ? "Dr" : "Cr")}`}>
                                  {running >= 0 ? "Dr" : "Cr"}
                                </span>
                              </TableCell>
                              <TableCell className="py-2">
                                {isSale ? (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-6 w-6"
                                    title="Print Invoice"
                                    data-testid={`btn-print-invoice-${t.voucherId}`}
                                    onClick={() => window.open(`/api/pos/invoice/${t.voucherId}/pdf`, "_blank")}
                                  >
                                    <Printer className="h-3 w-3" />
                                  </Button>
                                ) : null}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                      <TableFooter className="bg-muted/40">
                        <TableRow className="font-semibold text-xs">
                          <TableCell colSpan={3}>Total</TableCell>
                          <TableCell className="text-right font-mono">{formatHistoricalBaseAmount(totalDr)}</TableCell>
                          <TableCell className="text-right font-mono">{formatHistoricalBaseAmount(totalCr)}</TableCell>
                          <TableCell className="text-right font-mono">
                            {formatHistoricalBaseAmount(Math.abs(closingBalance))}
                            <span
                              className={`text-xs font-semibold ml-1 ${drCrClass(statementCustomer?.balanceSide || "Dr")}`}
                            >
                              {statementCustomer?.balanceSide || "Dr"}
                            </span>
                          </TableCell>
                          <TableCell></TableCell>
                        </TableRow>
                      </TableFooter>
                    </Table>
                  </div>
                );
              })()
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
