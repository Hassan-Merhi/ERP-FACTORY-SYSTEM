import { useQuery } from "@tanstack/react-query";
import type { Container, Supplier } from "@shared/schema";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { SoldContainer, SpContainerWithLines } from "./types";

interface SelectedCompany {
  id: number;
  companyType?: string;
}

export function useContainerQueries(
  selectedCompany: SelectedCompany | null | undefined,
  isSupplierPartner: boolean,
  isFactory: boolean
) {
  const { data: myErpPages } = useQuery<{ hiddenErpCostFields?: string[] }>({
    queryKey: ["/api/my-erp-pages"],
  });
  const hideContainerCosts = (myErpPages?.hiddenErpCostFields ?? []).includes("container_costs");

  const { data: currentUser } = useQuery<{ role?: string; currentRole?: string | null }>({
    queryKey: ["/api/auth/me"],
  });
  const _allowedRoles = ["Admin", "Owner", "Developer"];
  const isPrivilegedRole =
    _allowedRoles.includes(currentUser?.currentRole ?? "") || _allowedRoles.includes(currentUser?.role ?? "");
  const isDeveloper = currentUser?.role === "Developer";

  const { data: rawContainers = [], isLoading } = useQuery<Container[]>({
    queryKey: ["/api/containers/active", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
  });
  const allContainers = rawContainers
    .slice()
    .sort((a, b) => new Date(b.importDate).getTime() - new Date(a.importDate).getTime());

  const { data: soldContainers = [], isLoading: isSoldLoading } = useQuery<SoldContainer[]>({
    queryKey: ["/api/containers/sold", selectedCompany?.id],
    enabled: !!selectedCompany?.id && !isSupplierPartner,
  });

  const { data: spContainersList = [], isLoading: spContainersLoading } = useQuery<SpContainerWithLines[]>({
    queryKey: ["/api/sp/containers"],
    queryFn: () => fetch("/api/sp/containers", { credentials: "include" }).then((r) => r.json()),
    enabled: !!selectedCompany?.id && isSupplierPartner,
  });

  const suppliersPath = isSupplierPartner ? "/api/suppliers" : "/api/suppliers?allowParentFallback=true";
  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: companyQueryKey(
      "/api/suppliers",
      selectedCompany?.id,
      isSupplierPartner ? "strict" : "allow-parent-fallback"
    ),
    queryFn: async () => {
      const res = await fetch(suppliersPath, { credentials: "include" });
      if (!res.ok) throw res;
      return res.json();
    },
    enabled: !!selectedCompany?.id,
  });

  const { data: freightStatusMap = {} } = useQuery<
    Record<number, { totalFreight: number; totalPaid: number; status: string }>
  >({
    queryKey: ["/api/factory/containers/freight-status"],
    queryFn: async () => {
      const res = await fetch("/api/factory/containers/freight-status");
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!selectedCompany?.id && isFactory,
  });

  return {
    allContainers,
    soldContainers,
    spContainersList,
    suppliers,
    freightStatusMap,
    isLoading,
    isSoldLoading,
    spContainersLoading,
    hideContainerCosts,
    isDeveloper,
    isPrivilegedRole,
  };
}
