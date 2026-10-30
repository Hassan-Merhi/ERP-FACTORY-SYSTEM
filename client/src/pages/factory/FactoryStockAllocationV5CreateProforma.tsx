import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import CreateProformaV5Drawer from "./CreateProformaV5Drawer";
import { fetchAllV5AllocationData, type V5AllocationData } from "@/lib/v5AllocationPaginationClient";

/**
 * Full-page proforma creation reuses the exact V5 stock allocation figures,
 * regardless of the filters selected on the listing page.
 */
export default function FactoryStockAllocationV5CreateProforma() {
  const [, navigate] = useLocation();
  const back = () => navigate("/factory/stock-allocation-v5");

  const query = useQuery<V5AllocationData>({
    queryKey: ["/api/factory/v5/stock-allocation/all-for-create"],
    queryFn: () => fetchAllV5AllocationData(),
    staleTime: 2 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const articleRows = useMemo(
    () =>
      (query.data?.rows ?? [])
        .map((row) => ({
          articleCode: row.articleCode,
          productName: row.productName,
          categoryName: row.categoryName,
          stockAvailable: row.stockAvailable,
          totalLoaded: row.totalLoaded,
          expectedToLoad: row.expectedToLoad,
          freeToPromise: row.freeToPromise,
        }))
        .sort((a, b) => a.productName.localeCompare(b.productName)),
    [query.data?.rows]
  );

  if (query.isPending) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="page-v5-create-loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex h-full flex-col gap-4 p-4" data-testid="page-v5-create-error">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={back}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Back to Stock Allocation
          </Button>
          <PageHeader title="Create Proforma" />
        </div>
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {query.error.message}
        </p>
        <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching} className="w-fit">
          <RefreshCw className="mr-2 h-4 w-4" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      <div className="border-b bg-card/40 px-3 py-3 sm:px-5">
        <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg" onClick={back} data-testid="button-v5-create-back">
          <ArrowLeft className="mr-2 h-4 w-4" /> Stock Allocation
        </Button>
      </div>
      <div className="min-w-0 flex-1">
        <CreateProformaV5Drawer open onClose={back} articleRows={articleRows} onSuccess={back} />
      </div>
    </div>
  );
}
