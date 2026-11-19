// Extracted from ./RetailSalesHistory.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { getJson, type Location } from "./retailInventoryTypes";
import {
  fetchRetailCustomerHistory,
  searchRetailCustomers,
  searchRetailSalesHistory,
} from "@/pages/pos/retailWave2Api";
import type { RetailCustomerSummary } from "@/pages/pos/retailWave2Types";

export function useRetailSalesHistoryState() {
  const { selectedCompany } = useCompany();
  const retailEnabled = selectedCompany?.companyType === "retail";
  const [filters, setFilters] = useState({
    receipt: "",
    search: "",
    barcode: "",
    dateFrom: "",
    dateTo: "",
    locationId: "" as number | "",
  });
  const [submittedFilters, setSubmittedFilters] = useState<typeof filters | null>(null);
  const [customerTerm, setCustomerTerm] = useState("");
  const [customer, setCustomer] = useState<RetailCustomerSummary | null>(null);

  const locationsQuery = useQuery({
    queryKey: ["retail-history-locations"],
    queryFn: () => getJson<Location[]>("/api/locations"),
    enabled: retailEnabled,
  });

  const customersQuery = useQuery({
    queryKey: ["retail-history-customers", customerTerm],
    queryFn: () => searchRetailCustomers(customerTerm, 10),
    enabled: retailEnabled && !customer && customerTerm.trim().length > 1,
  });

  const historyQuery = useQuery({
    queryKey: ["retail-history-sales", submittedFilters, customer?.id],
    queryFn: () =>
      searchRetailSalesHistory({
        receipt: submittedFilters?.receipt || undefined,
        search: submittedFilters?.search || undefined,
        barcode: submittedFilters?.barcode || undefined,
        dateFrom: submittedFilters?.dateFrom || undefined,
        dateTo: submittedFilters?.dateTo || undefined,
        locationId: submittedFilters?.locationId || undefined,
        customerId: customer?.id,
        limit: 50,
      }),
    enabled: retailEnabled && (Boolean(submittedFilters) || Boolean(customer)),
  });

  const customerHistoryQuery = useQuery({
    queryKey: ["retail-customer-history", customer?.id],
    queryFn: () => fetchRetailCustomerHistory(customer!.id),
    enabled: retailEnabled && Boolean(customer),
  });
  return {
    retailEnabled,
    filters,
    setFilters,
    setSubmittedFilters,
    submittedFilters,
    customerTerm,
    setCustomerTerm,
    customer,
    setCustomer,
    locationsQuery,
    customersQuery,
    historyQuery,
    customerHistoryQuery,
  };
}
