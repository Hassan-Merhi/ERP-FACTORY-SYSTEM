// Extracted from ./Customers.tsx to keep that module under the source-size cap.
import { searchIncludes } from "@shared/searchNormalization";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { customersApi } from "@/api/customersApi";
import { fetchRetailCustomerHistory } from "./pos/retailPosApi";
import type { RetailCustomerHistory } from "./pos/retailTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useEffect, useState } from "react";
import {
  ErpFormActions,
  ErpPendingButton,
  useErpRecordChangeAccess as useExistingRecordChangeAccess,
} from "@/erp-core";
import { erpCompanyDataKey, invalidateErpDataFamilies } from "@/erp-core/erpData";
import { type Customer, insertCustomerSchema } from "@shared/schema";
import { useForm } from "react-hook-form";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { zodResolver } from "@/lib/form-resolver";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { z } from "zod";
import { usePaginatedFilterState } from "@/hooks/use-paginated-filter-state";

const formSchema = insertCustomerSchema.extend({
  legalName: z.string().min(1, "Legal name is required"),
});

export const typeBadgeClass: Record<string, string> = {
  Payment: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  Receipt: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  Journal: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  "Credit Note": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  "Debit Note": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  Transfer: "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300",
  Adjustment: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
};

export function useCompanyCustomersState() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { formatHistoricalBaseAmount } = useCurrencyContext();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const recordChanges = useExistingRecordChangeAccess();
  const {
    filters: { searchQuery, hideZero },
    setFilter,
    resetFilters,
    hasActiveFilters,
  } = usePaginatedFilterState<{ searchQuery: string; hideZero: boolean }>({
    // Retail customers are often first created with zero balance at checkout;
    // show them in Parties immediately, while preserving the optional Hide Zero control.
    createInitialFilters: () => ({ searchQuery: "", hideZero: selectedCompany?.companyType !== "retail" }),
    storageKey: selectedCompany?.id
      ? `${selectedCompany.companyType === "retail" ? "erp-retail-customers-filters-v1" : "erp-customers-filters-v1"}:${selectedCompany.id}`
      : undefined,
  });
  const [statementCustomer, setStatementCustomer] = useState<
    (Customer & { balance: number; balanceSide: string }) | null
  >(null);

  const statementUrl = `/api/customers/${statementCustomer?.id ?? "no-customer"}/transactions`;
  const { data: ledgerTxns = [], isLoading: txnsLoading } = useQuery({
    queryKey: erpCompanyDataKey(statementUrl, selectedCompany?.id),
    queryFn: () => fetch(statementUrl).then((r) => r.json()),
    enabled: selectedCompany?.id != null && statementCustomer?.id != null,
  });

  // Paid retail sales do not generate customer receivables, but they are
  // still linked purchases. Show them separately from the account ledger.
  const {
    data: retailHistory,
    isLoading: retailHistoryLoading,
    isError: retailHistoryError,
  } = useQuery<RetailCustomerHistory>({
    queryKey: ["retail-accounting-customer-history", selectedCompany?.id, statementCustomer?.id],
    queryFn: () => fetchRetailCustomerHistory(statementCustomer!.id, 100),
    enabled: selectedCompany?.companyType === "retail" && Boolean(statementCustomer?.id),
    staleTime: 15_000,
  });
  const {
    data: customers = [],
    isLoading,
    isError: customersError,
    refetch: refetchCustomers,
  } = useQuery<(Customer & { balance: number; balanceSide: string })[]>({
    queryKey: erpCompanyDataKey("/api/customers/stats", selectedCompany?.id),
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
      toast({ title: "Created", description: "Customer created successfully" });
      void invalidateErpDataFamilies(queryClient, ["/api/customers", "/api/accounts/all", "/api/ledger-accounts"]);
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
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: z.infer<typeof formSchema> & { id: number }) => {
      return await customersApi.update(data.id, data);
    },
    onSuccess: () => {
      toast({ title: "Updated", description: "Customer updated successfully" });
      void invalidateErpDataFamilies(queryClient, ["/api/customers", "/api/accounts/all", "/api/ledger-accounts"]);
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
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
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
        {/* Create Only adds customers without an opening balance (refused by the server). */}
        {!recordChanges.isCreateOnly && (
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
        )}
        <ErpFormActions>
          <Button
            type="button"
            variant="outline"
            onClick={() => (isEdit ? setIsEditOpen(false) : setIsCreateOpen(false))}
            data-testid={isEdit ? "button-edit-cancel" : "button-cancel"}
          >
            Cancel
          </Button>
          <ErpPendingButton
            type="submit"
            pending={isEdit ? updateMutation.isPending : createMutation.isPending}
            pendingLabel={isEdit ? "Updating..." : "Creating..."}
            data-testid={isEdit ? "button-submit-edit-customer" : "button-submit-customer"}
          >
            {isEdit ? "Update Customer" : "Create Customer"}
          </ErpPendingButton>
        </ErpFormActions>
      </form>
    </Form>
  );
  return {
    customers,
    refetchCustomers,
    customersError,
    CustomerForm,
    filteredCustomers,
    form,
    formatHistoricalBaseAmount,
    handleEditClick,
    hasActiveFilters,
    hideZero,
    isCreateOpen,
    isEditOpen,
    isLoading,
    ledgerTxns,
    recordChanges,
    resetFilters,
    retailHistory,
    retailHistoryError,
    retailHistoryLoading,
    searchQuery,
    selectedCompany,
    setEditingCustomer,
    setFilter,
    setIsCreateOpen,
    setIsEditOpen,
    setStatementCustomer,
    statementCustomer,
    totalCustomers,
    totalPayable,
    totalReceivable,
    txnsLoading,
    withBalance,
  };
}
