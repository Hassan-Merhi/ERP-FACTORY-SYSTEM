import { searchAny } from "@shared/searchNormalization";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useAdminOverride } from "@/hooks/use-admin-override";
import type { BaleProduct } from "@shared/schema";
import type { WeightEditBale } from "@/components/BaleWeightEditDialog";
import type {
  ArticleLookupResult,
  ReferenceLookupResult,
  ReturnToStockOrderInfo,
  ReturnToStockResult,
  SearchMode,
  SwapPreview,
  SwapResult,
} from "./types";

function isGloballyHandledError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_handledGlobally" in error &&
    (error as { _handledGlobally?: boolean })._handledGlobally === true
  );
}

async function readError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = (await response.json()) as { message?: string };
    return new Error(body.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export function useBarcodeLookupModel() {
  const [searchMode, setSearchMode] = useState<SearchMode>("reference");
  const [searchValue, setSearchValue] = useState("");
  const [articleResult, setArticleResult] = useState<ArticleLookupResult | null>(null);
  const [referenceResult, setReferenceResult] = useState<ReferenceLookupResult | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showChangeProductDialog, setShowChangeProductDialog] = useState(false);
  const [changeProductSearch, setChangeProductSearch] = useState("");
  const [selectedNewProductId, setSelectedNewProductId] = useState<number | null>(null);
  const [showReturnToStockDialog, setShowReturnToStockDialog] = useState(false);
  const [showSwapDialog, setShowSwapDialog] = useState(false);
  const [swapRef, setSwapRef] = useState("");
  const [swapPreview, setSwapPreview] = useState<SwapPreview | null>(null);
  const [weightEditBale, setWeightEditBale] = useState<WeightEditBale | null>(null);

  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { wrapAdminAction, AdminDialog } = useAdminOverride();

  const referenceLookup = useMutation({
    mutationFn: async (refNum: string): Promise<ReferenceLookupResult> => {
      const response = await modeApiRequest("GET", `/api/lookup/reference/${encodeURIComponent(refNum)}`);
      if (!response.ok) throw await readError(response, "Lookup failed");
      return (await response.json()) as ReferenceLookupResult;
    },
    onSuccess: (data) => {
      setReferenceResult(data);
      setArticleResult(null);
    },
    onError: (error: unknown) => {
      if (isGloballyHandledError(error)) return;
      toast({
        title: "Not Found",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
      setReferenceResult(null);
    },
  });

  const articleLookup = useMutation({
    mutationFn: async (articleCode: string): Promise<ArticleLookupResult> => {
      const response = await modeApiRequest("GET", `/api/lookup/article/${encodeURIComponent(articleCode)}`);
      if (!response.ok) throw await readError(response, "Lookup failed");
      return (await response.json()) as ArticleLookupResult;
    },
    onSuccess: (data) => {
      setArticleResult(data);
      setReferenceResult(null);
    },
    onError: (error: unknown) => {
      if (isGloballyHandledError(error)) return;
      toast({
        title: "Not Found",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
      setArticleResult(null);
    },
  });

  const markScanned = useMutation({
    mutationFn: async (refNum: string) => {
      const response = await modeApiRequest("POST", `/api/lookup/reference/${encodeURIComponent(refNum)}/scan`, {});
      if (!response.ok) throw await readError(response, "Failed to mark as scanned");
      return (await response.json()) as {
        scannedAt: string;
        scannedByUserId?: number | string | null;
        scannedByName?: string | null;
      };
    },
    onSuccess: (data) => {
      setReferenceResult((previous) =>
        previous?.labelPrint
          ? {
              ...previous,
              labelPrint: {
                ...previous.labelPrint,
                scannedAt: data.scannedAt,
                scannedByUserId: data.scannedByUserId == null ? null : String(data.scannedByUserId),
                scannedByName: data.scannedByName ?? null,
              },
            }
          : previous
      );
      toast({ title: "Scanned", description: "Label marked as scanned" });
    },
    onError: (error: unknown) => {
      if (isGloballyHandledError(error)) return;
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
    },
  });

  const { data: currentUser } = useQuery<{ role: string }>({ queryKey: ["/api/auth/me"] });
  const isAdmin = currentUser?.role === "Admin" || currentUser?.role === "Owner" || currentUser?.role === "Developer";

  const { data: baleProductsList } = useQuery<BaleProduct[]>({
    queryKey: ["/api/factory/bale-products?profile=picker"],
    enabled: showChangeProductDialog,
  });

  const filteredBaleProducts = (baleProductsList || []).filter((product) => {
    if (!changeProductSearch.trim()) return true;
    return searchAny(changeProductSearch, product.name, product.articleCode, product.code);
  });

  const deleteBaleMutation = useMutation({
    mutationFn: async (refNum: string) => {
      const response = await modeApiRequest(
        "DELETE",
        `/api/lookup/reference/${encodeURIComponent(refNum)}/delete-everywhere`,
        {}
      );
      if (!response.ok) throw await readError(response, "Failed to delete bale");
      return response.json();
    },
    onSuccess: () => {
      setShowDeleteDialog(false);
      setReferenceResult(null);
      setSearchValue("");
      toast({ title: "Deleted", description: "Bale has been deleted from all linked records." });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
    },
  });

  const changeProductMutation = useMutation({
    mutationFn: async ({ refNum, newProductId }: { refNum: string; newProductId: number }) => {
      const response = await modeApiRequest(
        "PATCH",
        `/api/lookup/reference/${encodeURIComponent(refNum)}/change-product`,
        { newProductId }
      );
      if (!response.ok) throw await readError(response, "Failed to change product");
      return response.json();
    },
    onSuccess: (_data, { refNum }) => {
      setShowChangeProductDialog(false);
      setSelectedNewProductId(null);
      setChangeProductSearch("");
      referenceLookup.mutate(refNum);
      toast({ title: "Updated", description: "Bale product changed successfully." });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
    },
  });

  const restoreDeletedMutation = useMutation({
    mutationFn: async (baleId: number) => {
      const response = await modeApiRequest("PATCH", `/api/factory/bales/${baleId}/status`, { status: "IN_STOCK" });
      if (!response.ok) throw await readError(response, "Failed to return bale to stock");
      return response.json();
    },
    onSuccess: () => {
      const referenceNumber = referenceResult?.labelPrint?.referenceNumber;
      if (referenceNumber) referenceLookup.mutate(referenceNumber);
      toast({ title: "Returned to Stock", description: "Bale status set back to In Stock." });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
    },
  });

  const returnableBaleId = (() => {
    const status = referenceResult?.baleInfo?.status;
    return (status === "RESERVED_FOR_ORDER" || status === "RESERVED" || status === "SOLD") && showReturnToStockDialog
      ? referenceResult?.baleInfo?.id
      : null;
  })();

  const { data: returnToStockOrderInfo, isLoading: orderInfoLoading } = useQuery<ReturnToStockOrderInfo | null>({
    queryKey: ["/api/factory/bales", returnableBaleId, "order-info"],
    queryFn: async () => {
      const response = await modeApiRequest("GET", `/api/factory/bales/${returnableBaleId}/order-info`);
      if (!response.ok) return null;
      return (await response.json()) as ReturnToStockOrderInfo;
    },
    enabled: !!returnableBaleId,
  });

  const returnToStockMutation = useMutation({
    mutationFn: async (baleId: number): Promise<ReturnToStockResult> => {
      const response = await modeApiRequest("POST", `/api/factory/bales/${baleId}/return-to-stock`, {});
      if (!response.ok) throw await readError(response, "Failed to return bale to stock");
      return (await response.json()) as ReturnToStockResult;
    },
    onSuccess: (data) => {
      setShowReturnToStockDialog(false);
      const referenceNumber = referenceResult?.labelPrint?.referenceNumber;
      if (referenceNumber) referenceLookup.mutate(referenceNumber);
      const invoiceMessage = data.invoiceNumber
        ? ` Invoice ${data.invoiceNumber} updated to $${parseFloat(data.newGrandTotal || "0").toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`
        : "";
      toast({ title: "Bale returned to stock", description: `Bale removed from order.${invoiceMessage}` });
    },
    onError: (error: unknown) => {
      if (isGloballyHandledError(error)) return;
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
    },
  });

  const swapPreviewMutation = useMutation({
    mutationFn: async (ref: string): Promise<ReferenceLookupResult> => {
      const response = await modeApiRequest("GET", `/api/lookup/reference/${encodeURIComponent(ref.trim())}`);
      if (!response.ok) throw await readError(response, "Bale not found");
      return (await response.json()) as ReferenceLookupResult;
    },
    onSuccess: (data) => {
      const bale = data.baleInfo;
      if (!bale) {
        setSwapPreview(null);
        toast({ title: "Lookup Failed", description: "Bale not found", variant: "destructive" });
        return;
      }
      setSwapPreview({
        referenceNumber: data.labelPrint?.referenceNumber || swapRef.trim(),
        productName: bale.productName,
        weightKg: bale.weightKg,
        status: bale.status,
        articleCode: data.labelPrint?.articleCode ?? null,
      });
    },
    onError: (error: unknown) => {
      if (isGloballyHandledError(error)) return;
      setSwapPreview(null);
      toast({
        title: "Lookup Failed",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
    },
  });

  const swapMutation = useMutation({
    mutationFn: async ({
      currentBaleRef,
      replacementBaleRef,
    }: {
      currentBaleRef: string;
      replacementBaleRef: string;
    }): Promise<SwapResult> => {
      const response = await modeApiRequest("POST", "/api/factory/bales/swap", { currentBaleRef, replacementBaleRef });
      if (!response.ok) throw await readError(response, "Swap failed");
      return (await response.json()) as SwapResult;
    },
    onSuccess: (data) => {
      setShowSwapDialog(false);
      setSwapRef("");
      setSwapPreview(null);
      const referenceNumber = referenceResult?.labelPrint?.referenceNumber;
      if (referenceNumber) referenceLookup.mutate(referenceNumber);
      const invoiceMessage = data.invoiceNumber
        ? ` Invoice ${data.invoiceNumber} updated to $${parseFloat(data.newGrandTotal || "0").toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`
        : "";
      toast({
        title: "Bale swapped",
        description: `${data.replacedRef} → ${data.replacementRef} in the order.${invoiceMessage}`,
      });
    },
    onError: (error: unknown) => {
      if (isGloballyHandledError(error)) return;
      toast({
        title: "Swap Failed",
        description: error instanceof Error ? error.message : "Request failed",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    const value = searchValue.trim().toUpperCase();
    if (value.startsWith("REF")) setSearchMode("reference");
    else if (value.length > 0) setSearchMode("article");
  }, [searchValue]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    if (ref) {
      setSearchValue(ref);
      setTimeout(() => referenceLookup.mutate(ref), 0);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => {
    const value = searchValue.trim();
    if (!value) return;
    if (searchMode === "article") articleLookup.mutate(value);
    else referenceLookup.mutate(value);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") handleSearch();
  };

  const formatDate = (dateValue: string | Date | null | undefined) => {
    if (!dateValue) return null;
    return (dateValue instanceof Date ? dateValue : new Date(dateValue)).toLocaleString();
  };

  const formatDateOnly = (dateValue: string | Date | null | undefined) => {
    if (!dateValue) return null;
    return (dateValue instanceof Date ? dateValue : new Date(dateValue)).toLocaleDateString();
  };

  const smartNum = (value: string | number) => {
    const number = parseFloat(String(value));
    if (Number.isNaN(number)) return String(value);
    if (number % 1 === 0) return number.toLocaleString();
    return number.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  };

  return {
    searchMode,
    setSearchMode,
    searchValue,
    setSearchValue,
    articleResult,
    referenceResult,
    showDeleteDialog,
    setShowDeleteDialog,
    showChangeProductDialog,
    setShowChangeProductDialog,
    changeProductSearch,
    setChangeProductSearch,
    selectedNewProductId,
    setSelectedNewProductId,
    showReturnToStockDialog,
    setShowReturnToStockDialog,
    showSwapDialog,
    setShowSwapDialog,
    swapRef,
    setSwapRef,
    swapPreview,
    setSwapPreview,
    weightEditBale,
    setWeightEditBale,
    AdminDialog,
    wrapAdminAction,
    referenceLookup,
    articleLookup,
    markScanned,
    isAdmin,
    filteredBaleProducts,
    deleteBaleMutation,
    changeProductMutation,
    restoreDeletedMutation,
    returnToStockOrderInfo,
    orderInfoLoading,
    returnToStockMutation,
    swapPreviewMutation,
    swapMutation,
    handleSearch,
    handleKeyDown,
    formatDate,
    formatDateOnly,
    smartNum,
    isLoading: referenceLookup.isPending || articleLookup.isPending,
  };
}
