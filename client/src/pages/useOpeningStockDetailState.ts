// Extracted from ./OpeningStockDetail.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { type StockGroupItemsData, type DebugData } from "./OpeningStockDetailHelpers";

export function useOpeningStockDetailState() {
  const [, navigate] = useLocation();
  const params = useParams<{ groupId: string }>();
  useEscapeToParent();
  const searchString = useSearch();
  const { selectedCompany } = useCompany();
  const { formatAmount } = useCurrencyContext();
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);

  const searchParams = new URLSearchParams(searchString);
  const groupName = searchParams.get("name") || "Stock Group";

  const { data, isLoading, isError, refetch } = useQuery<StockGroupItemsData>({
    queryKey: [`/api/reports/opening-stock-summary/${params.groupId}/items`, selectedCompany?.id],
    enabled: !!selectedCompany?.id && !!params.groupId,
  });

  const { data: debugData, isLoading: debugLoading } = useQuery<DebugData>({
    queryKey: [`/api/debug/inventory/${selectedItemId}`, selectedCompany?.id],
    enabled: !!selectedCompany?.id && !!selectedItemId,
  });

  // Calculate grand total rates
  const openingRate =
    data?.grandTotal?.opening?.quantity && data.grandTotal.opening.quantity > 0
      ? data.grandTotal.opening.value / data.grandTotal.opening.quantity
      : 0;
  const closingRate =
    data?.grandTotal?.closing?.quantity && data.grandTotal.closing.quantity > 0
      ? data.grandTotal.closing.value / data.grandTotal.closing.quantity
      : 0;

  const handleItemClick = (itemId: number) => {
    setSelectedItemId(itemId);
  };

  const selectedItem = data?.items.find((i) => i.id === selectedItemId);
  return {
    navigate,
    selectedCompany,
    formatAmount,
    selectedItemId,
    setSelectedItemId,
    groupName,
    data,
    isLoading,
    isError,
    refetch,
    debugLoading,
    debugData,
    openingRate,
    closingRate,
    handleItemClick,
    selectedItem,
  };
}
