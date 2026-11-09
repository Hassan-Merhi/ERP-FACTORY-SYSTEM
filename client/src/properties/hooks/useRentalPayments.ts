import { useQuery } from "@tanstack/react-query";
import type { PaymentRow } from "@/pages/properties/RentalPaymentsLog";
import type { ReconciliationPayment } from "@/pages/properties/property-rental/components/PaymentsReconciliation";

/** Keep existing query keys, endpoints, and reconciliation read-model contracts unchanged. */
export function rentalPaymentsQueryKey(apiBase: string, companyId: number | undefined, propertiesView: boolean) {
  return [apiBase + "/payments", { companyId, view: propertiesView ? "warehouse-reconciliation" : "default" }] as const;
}

export function useRentalPayments(apiBase: string, companyId: number | undefined, propertiesView: boolean) {
  return useQuery<PaymentRow[]>({
    queryKey: rentalPaymentsQueryKey(apiBase, companyId, propertiesView),
    queryFn: async () => {
      const res = await fetch(`${apiBase}/payments${propertiesView ? "?view=warehouse-reconciliation" : ""}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load payments");
      return res.json();
    },
    enabled: !!companyId,
  });
}

export function useRentalReconciliationPayments(apiBase: string, companyId: number | undefined, enabled: boolean) {
  return useQuery<ReconciliationPayment[]>({
    queryKey: [apiBase + "/payments", { companyId, view: "warehouse-reconciliation" }],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/payments?view=warehouse-reconciliation`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load historical warehouse rent");
      return res.json();
    },
    enabled: !!companyId && enabled,
  });
}
