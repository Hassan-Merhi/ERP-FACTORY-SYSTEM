import { useQuery } from "@tanstack/react-query";
import type { Container, Supplier } from "@shared/schema";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
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
    ...erpPageAccessQueryOptions(selectedCompany?.id, true),
  });
  const hideContainerCosts = (myErpPages?.hiddenErpCostFields ?? []).includes("container_costs");

  const { data: currentUser } = useQuery<{ role?: string; currentRole?: string | null }>({
    queryKey: ["/api/auth/me"],
  });
  const _allowedRoles = ["Admin", "Owner", "Developer"];
  const isPrivilegedRole =
    _allowedRoles.includes(currentUser?.currentRole ?? "") || _allowedRoles.includes(currentUser?.role ?? "");
  const isDeveloper = currentUser?.role === "Developer";

  const {
    data: rawContainers = [],
    isLoading,
    error: containersError,
    refetch: refetchContainers,
  } = useQuery<Container[]>({
    queryKey: ["/api/containers/active", selectedCompany?.id],
    queryFn: async () => {
      const response = await fetch("/api/containers/active", { credentials: "include" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || "Unable to load container list");
      }
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error("Container API returned an invalid list");
      return data as Container[];
    },
    staleTime: 0,
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
    containersError,
    refetchContainers,
    isSoldLoading,
    spContainersLoading,
    hideContainerCosts,
    isDeveloper,
    isPrivilegedRole,
  };
}
