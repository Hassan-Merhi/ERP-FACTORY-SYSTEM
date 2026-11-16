// Extracted from ./POSCustomers.tsx to keep that module under the source-size cap.
import { searchIncludes } from "@shared/searchNormalization";
import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useReactToPrint } from "react-to-print";
import { z } from "zod";
import { usePaginatedFilterState } from "@/hooks/use-paginated-filter-state";

interface POSCustomer {
  id: number;
  legalName: string;
  phone: string | null;
  balance: number;
  balanceSide: string;
}

const formSchema = z.object({
  legalName: z.string().min(1, "Customer name is required"),
  phone: z.string().optional(),
  openingBalance: z.string().optional(),
  openingBalanceSide: z.enum(["Dr", "Cr"]).default("Dr"),
});

type FormData = z.infer<typeof formSchema>;

export function usePOSCustomersState() {
  const { toast } = useToast();
  const { formatCashAmount, formatAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const {
    filters: { searchQuery },
    setFilter,
    resetFilters,
    hasActiveFilters,
  } = usePaginatedFilterState<{ searchQuery: string }>({
    createInitialFilters: () => ({ searchQuery: "" }),
    storageKey: selectedCompany?.id ? `erp-pos-customers-filters-v1:${selectedCompany.id}` : undefined,
  });
  const [statementCustomer, setStatementCustomer] = useState<POSCustomer | null>(null);

  const printRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: `Statement_${statementCustomer?.legalName?.replace(/\s+/g, "_") ?? "Customer"}`,
  });

  const { data: customers = [], isLoading } = useQuery<POSCustomer[]>({
    queryKey: ["/api/pos/customers"],
  });

  // Fetch transactions when a customer is selected — uses POS-specific endpoint
  const { data: ledgerTxnsRaw, isLoading: txnsLoading } = useQuery<unknown>({
    queryKey: ["/api/pos/customers", statementCustomer?.id, "transactions"],
    queryFn: () => fetch(`/api/pos/customers/${statementCustomer!.id}/transactions`).then((r) => r.json()),
    enabled: !!statementCustomer?.id,
  });
  const ledgerTxns = Array.isArray(ledgerTxnsRaw) ? ledgerTxnsRaw : [];

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      legalName: "",
      phone: "",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: FormData) => {
      return await apiRequest("POST", "/api/pos/customers", data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Customer created successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/pos/customers"] });
      setIsCreateOpen(false);
      form.reset({ legalName: "", phone: "", openingBalance: "0", openingBalanceSide: "Dr" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const onSubmit = (data: FormData) => createMutation.mutate(data);

  const filteredCustomers = customers.filter((customer) => searchIncludes(customer.legalName, searchQuery));

  const totalCustomers = customers.length;
  const totalReceivables = customers
    .filter((c) => c.balanceSide === "Dr")
    .reduce((sum, c) => sum + (c.balance || 0), 0);

  // Compute statement rows
  const sorted = [...ledgerTxns].sort((a, b) => new Date(a.voucherDate).getTime() - new Date(b.voucherDate).getTime());
  const totalDr = sorted.reduce((s, t) => s + parseFloat(t.debitAmount || "0"), 0);
  const totalCr = sorted.reduce((s, t) => s + parseFloat(t.creditAmount || "0"), 0);
  const closingBalance = statementCustomer?.balance || 0;
  const openingBalance = closingBalance - totalDr + totalCr;
  return {
    closingBalance,
    createMutation,
    filteredCustomers,
    form,
    formatAmount,
    formatCashAmount,
    handlePrint,
    hasActiveFilters,
    isCreateOpen,
    isLoading,
    onSubmit,
    openingBalance,
    printRef,
    resetFilters,
    searchQuery,
    selectedCompany,
    setFilter,
    setIsCreateOpen,
    setStatementCustomer,
    sorted,
    statementCustomer,
    totalCr,
    totalCustomers,
    totalDr,
    totalReceivables,
    txnsLoading,
  };
}
