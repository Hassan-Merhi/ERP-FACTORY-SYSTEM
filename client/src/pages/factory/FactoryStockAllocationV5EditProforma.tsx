import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { AlertTriangle, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import EditProformaV5Drawer from "./EditProformaV5Drawer";
import { fetchAllV5AllocationData, type V5AllocationData } from "@/lib/v5AllocationPaginationClient";

/** Full-page V5 proforma editor, using the complete unfiltered allocation snapshot. */
export default function FactoryStockAllocationV5EditProforma() {
  const { id } = useParams<{ id: string }>();
  const proformaId = Number(id);
  const validId = /^[1-9]\d*$/.test(id ?? "") && Number.isSafeInteger(proformaId);
  const [, navigate] = useLocation();
  const back = () => navigate(validId
    ? `/factory/stock-allocation-v5?proformaId=${proformaId}`
    : "/factory/stock-allocation-v5");

  const query = useQuery<V5AllocationData>({
    queryKey: ["/api/factory/v5/stock-allocation/all-for-edit", proformaId],
    queryFn: () => fetchAllV5AllocationData(),
    enabled: validId,
    staleTime: 15000,
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

  if (!validId || query.isError) {
    return (
      <div className="flex h-full flex-col gap-4 p-4" data-testid="page-v5-edit-error">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={back}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Back to Stock Allocation
          </Button>
          <PageHeader title="Edit Proforma" />
        </div>
        <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {validId ? query.error?.message : "Invalid proforma ID."}
        </p>
        {validId && (
          <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching} className="w-fit">
            <RefreshCw className="mr-2 h-4 w-4" /> Retry
          </Button>
        )}
      </div>
    );
  }

  if (query.isPending) {
    return (
      <div className="flex h-full items-center justify-center" data-testid="page-v5-edit-loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="border-b px-4 py-2">
        <Button variant="ghost" size="sm" onClick={back} data-testid="button-v5-edit-back">
          <ArrowLeft className="mr-2 h-4 w-4" /> Stock Allocation
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <EditProformaV5Drawer open onClose={back} onSuccess={back} proformaId={proformaId} articleRows={articleRows} />
      </div>
    </div>
  );
}
