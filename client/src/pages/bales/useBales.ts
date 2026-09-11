import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import type { Bale } from "@shared/schema";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";

/**
 * Provides the bales and containers data queries.
 * Mutations (createBale, deleteBale) stay in the Bales page because they need
 * access to component state (form, refs, dialog toggles, pendingBarcodeToMark).
 */
export function useBales() {
  const { selectedCompany } = useCompany();

  const { data: bales = [], isLoading } = useQuery<Bale[]>({
    queryKey: ["/api/bales", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const { data: containers = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/containers", selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  return { bales, containers, isLoading };
}
