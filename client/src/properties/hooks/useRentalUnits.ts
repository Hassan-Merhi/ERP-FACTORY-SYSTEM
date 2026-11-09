import { useQuery } from "@tanstack/react-query";
import type { CashAccount, Unit } from "@/pages/properties/property-rental/types";

/** Company-scoped read queries; the server remains authoritative for billing and posting. */
export function useRentalUnits(apiBase: string, companyId: number | undefined, unitType: "WAREHOUSE" | "SHOP") {
  return useQuery<Unit[]>({
    queryKey: [apiBase + "/units", { unitType, companyId }],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/units?unitType=${unitType}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load units");
      return res.json();
    },
    enabled: !!companyId,
  });
}

export function useRentalCashAccounts(apiBase: string, companyId: number | undefined) {
  return useQuery<CashAccount[]>({
    queryKey: [apiBase + "/cash-accounts", companyId],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/cash-accounts`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cash accounts");
      return res.json();
    },
    enabled: !!companyId,
  });
}

export function useWarehousePaidTotals(apiBase: string, companyId: number | undefined, enabled: boolean) {
  return useQuery<Array<{ totalPaid?: number | null }>>({
    queryKey: [apiBase + "/units", { unitType: "WAREHOUSE", companyId }],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/units?unitType=WAREHOUSE`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load warehouse rent totals");
      return res.json();
    },
    enabled: !!companyId && enabled,
  });
}
