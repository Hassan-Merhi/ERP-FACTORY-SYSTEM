// Extracted from ./POSItemReplacement.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClientErrorLike } from "@/lib/clientError";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import {
  displayQty,
  initialDateRange,
  type CandidateResponse,
  type LastSoldPriceResponse,
  type Location,
  type ReplacementCandidate,
  type ReplacementResult,
  type StockItem,
} from "./POSItemReplacementTypes";

export function usePOSItemReplacementState() {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const queryClient = useQueryClient();
  const initialDates = useMemo(initialDateRange, []);

  const [locationId, setLocationId] = useState<number | null>(null);
  const [sourceItem, setSourceItem] = useState<{ id: number; name: string } | null>(null);
  const [replacementItem, setReplacementItem] = useState<{ id: number; name: string } | null>(null);
  const [fromDate, setFromDate] = useState(initialDates.from);
  const [toDate, setToDate] = useState(initialDates.to);
  const [replaceQuantities, setReplaceQuantities] = useState<Record<number, string>>({});

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: stockItems = [] } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light"],
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: replacementLastSoldPriceData, isLoading: replacementLastSoldPriceLoading } =
    useQuery<LastSoldPriceResponse>({
      queryKey:
        locationId && replacementItem
          ? ["/api/pos/item-replacements/last-sold-price", locationId, replacementItem.id]
          : [],
      queryFn: async () => {
        if (!locationId || !replacementItem) return { sellingPrice: null };
        const params = new URLSearchParams({
          locationId: String(locationId),
          stockItemId: String(replacementItem.id),
        });
        const response = await fetch(`/api/pos/item-replacements/last-sold-price?${params.toString()}`, {
          credentials: "include",
        });
        if (!response.ok) return { sellingPrice: null };
        return response.json();
      },
      enabled: Boolean(locationId && replacementItem),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    });

  const candidateKey = [
    "/api/pos/item-replacements/candidates",
    locationId,
    sourceItem?.id ?? null,
    fromDate,
    toDate,
  ] as const;

  const {
    data: candidateData,
    isLoading: candidatesLoading,
    isFetching: candidatesFetching,
    refetch: refetchCandidates,
  } = useQuery<CandidateResponse>({
    queryKey: candidateKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        locationId: String(locationId),
        stockItemId: String(sourceItem?.id),
      });
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      const response = await fetch(`/api/pos/item-replacements/candidates?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(body.message || response.statusText);
      }
      return response.json();
    },
    enabled: Boolean(locationId && sourceItem?.id),
    refetchOnWindowFocus: false,
  });

  const visibleLocations = useMemo(
    () => locations.filter((location) => location.active !== false && !location.deletedAt),
    [locations]
  );
  const activeStockItems = useMemo(() => stockItems.filter((item) => item.active !== false), [stockItems]);
  const replacementStockItems = useMemo(
    () => activeStockItems.filter((item) => item.id !== sourceItem?.id),
    [activeStockItems, sourceItem?.id]
  );
  const rows = useMemo(() => candidateData?.rows ?? [], [candidateData]);
  const replacementLastSoldPrice = replacementLastSoldPriceData?.sellingPrice ?? null;

  const selectedReplacements = useMemo(() => {
    if (!replacementItem) return [];
    return rows.flatMap((row) => {
      const requested = Number(replaceQuantities[row.saleItemId] || 0);
      if (!Number.isFinite(requested) || requested <= 0) return [];
      return [
        {
          saleItemId: row.saleItemId,
          replacementStockItemId: replacementItem.id,
          quantity: requested,
        },
      ];
    });
  }, [replacementItem, replaceQuantities, rows]);

  const invalidRows = useMemo(
    () =>
      rows.filter((row) => {
        const requested = Number(replaceQuantities[row.saleItemId] || 0);
        return Number.isFinite(requested) && requested > Number(row.quantity);
      }),
    [replaceQuantities, rows]
  );

  const totalReplaceQty = selectedReplacements.reduce((sum, row) => sum + row.quantity, 0);
  const affectedVoucherCount = new Set(
    selectedReplacements.map((replacement) => rows.find((row) => row.saleItemId === replacement.saleItemId)?.voucherId)
  ).size;

  const replacementMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/pos/item-replacements", {
        locationId,
        replacements: selectedReplacements,
      });
      return (await response.json()) as ReplacementResult;
    },
    onSuccess: (result) => {
      toast({
        title: "POS items corrected",
        description: `${displayQty(result.replacedQuantity)} qty replaced across ${result.updatedVoucherIds.length} sale${result.updatedVoucherIds.length === 1 ? "" : "s"}.`,
      });
      setReplaceQuantities({});
      queryClient.invalidateQueries({ queryKey: ["/api/pos/item-replacements/candidates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pos/item-replacements/last-sold-price"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-query"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sales-report"] });
      void refetchCandidates();
    },
    onError: (error: ClientErrorLike) => {
      toast({
        title: "Replacement failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateQty = (row: ReplacementCandidate, value: string) => {
    if (value === "") {
      setReplaceQuantities((current) => ({ ...current, [row.saleItemId]: "" }));
      return;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setReplaceQuantities((current) => ({ ...current, [row.saleItemId]: value }));
  };

  const canSubmit =
    Boolean(locationId && sourceItem && replacementItem) &&
    selectedReplacements.length > 0 &&
    invalidRows.length === 0 &&
    !replacementMutation.isPending;
  return {
    activeStockItems,
    affectedVoucherCount,
    canSubmit,
    candidateData,
    candidatesFetching,
    candidatesLoading,
    fromDate,
    locationId,
    recordChanges,
    refetchCandidates,
    replaceQuantities,
    replacementItem,
    replacementLastSoldPrice,
    replacementLastSoldPriceLoading,
    replacementMutation,
    replacementStockItems,
    rows,
    selectedReplacements,
    setFromDate,
    setLocationId,
    setReplaceQuantities,
    setReplacementItem,
    setSourceItem,
    setToDate,
    sourceItem,
    toDate,
    totalReplaceQty,
    updateQty,
    visibleLocations,
  };
}
