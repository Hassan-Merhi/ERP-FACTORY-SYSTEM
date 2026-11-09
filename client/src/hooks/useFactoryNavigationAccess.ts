import { useQuery } from "@tanstack/react-query";
import type { AuthMe, FactoryMyAccess } from "@shared/apiTypes";
import { factoryPageAllowsRole, hasFactoryPageKey, resolveFactoryPage } from "@/app/factoryAccessRegistry";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { accessQueryPolicy } from "@/lib/queryPolicies";

/** Match the Factory route guard when linking to or embedding another Factory page. */
export function useFactoryNavigationAccess() {
  const { selectedCompany } = useCompany();
  const { data: user } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const { data: access } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    ...accessQueryPolicy,
    enabled: !!user && !!selectedCompany?.id,
  });
  const ready = !!user && !!selectedCompany?.id && !!access && access.companyId === selectedCompany.id;
  const canOpen = (url: string): boolean => {
    if (!ready) return false;
    const page = resolveFactoryPage(url);
    if (!page || !factoryPageAllowsRole(page, user.role ?? "")) return false;
    if (page.hideKey && access.hiddenCostFields?.includes(page.hideKey)) return false;
    if (["Admin", "Owner", "Developer"].includes(user.role ?? "")) return true;
    return !!access.fullAccess || hasFactoryPageKey(page, access.pageKeys ?? []);
  };
  return { ready, canOpen, access };
}
