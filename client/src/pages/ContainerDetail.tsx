import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Package } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useCompany } from "@/contexts/CompanyContext";
import type { Supplier } from "@shared/schema";
import { useContainerDetailModel } from "./containerdetail/useContainerDetailModel";
import { ContainerDetailSpView } from "./containerdetail/components/ContainerDetailSpView";
import { ContainerDetailErpView } from "./containerdetail/components/ContainerDetailErpView";

export default function ContainerDetail({ id: idProp, forceErp }: { id?: string; forceErp?: boolean }) {
  const model = useContainerDetailModel({ id: idProp, forceErp });
  const { selectedCompany } = useCompany();
  const { data: containerSuppliers = [] } = useQuery<Supplier[]>({
    queryKey: companyQueryKey("/api/suppliers", selectedCompany?.id, "allow-parent-fallback"),
    queryFn: async () => {
      const res = await fetch("/api/suppliers?allowParentFallback=true", { credentials: "include" });
      if (!res.ok) throw res;
      return res.json();
    },
    enabled: Boolean(selectedCompany?.id) && !model.isSupplierPartner,
  });
  const { isSupplierPartner, containerData, isLoading, backUrl } = model;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!containerData && !isSupplierPartner) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <Package className="w-16 h-16 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">Container not found</h2>
        <Link href={backUrl}>
          <Button variant="outline">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Containers
          </Button>
        </Link>
      </div>
    );
  }

  // ── SP early return — all hooks already called above ─────────────────────
  if (isSupplierPartner) {
    return <ContainerDetailSpView model={model} />;
  }

  const erpModel = {
    ...model,
    suppliers: containerSuppliers.length > 0 ? containerSuppliers : model.suppliers,
  };
  return <ContainerDetailErpView model={erpModel} />;
}
