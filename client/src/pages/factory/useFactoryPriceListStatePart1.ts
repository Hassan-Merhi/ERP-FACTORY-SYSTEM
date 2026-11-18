// Extracted from ./useFactoryPriceListState.ts
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

interface FactoryBaleProduct {
  id: number;
  code: string;
  articleCode: string | null;
  name: string;
  nameAr: string | null;
  description: string | null;
  weightPerBaleKg: string | null;
  categoryId: number | null;
  categoryName?: string;
  sellingPrice: string | null;
  productionPrice: string | null;
  active: boolean;
}

interface FactoryCategory {
  id: number;
  name: string;
}

export function useFactoryPriceListStatePart1() {
  const mhd = useFactoryMhdView();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  // Prices are edits to existing products; read-only roles see the list and template only.
  const recordChanges = useExistingRecordChangeAccess();

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [showZeroOnly, setShowZeroOnly] = useState(false);
  const [editingCell, setEditingCell] = useState<{
    productId: number;
    field: "sellingPrice" | "productionPrice";
    value: string;
  } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditingCell(null);
  }, [selectedCompany?.id]);

  // Focus only when changing cells, not on every digit typed.
  const editingCellKey = editingCell ? `${editingCell.productId}:${editingCell.field}` : null;
  useEffect(() => {
    if (!editingCellKey) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingCellKey]);
  const {
    data: products = [],
    isLoading,
    isError: productsError,
    refetch: refetchProducts,
  } = useQuery<FactoryBaleProduct[]>({
    queryKey: companyQueryKey("/api/factory/bale-products", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const { data: categories = [] } = useQuery<FactoryCategory[]>({
    queryKey: companyQueryKey("/api/factory/categories", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const updatePriceMutation = useMutation({
    mutationFn: async ({
      id,
      field,
      value,
    }: {
      id: number;
      field: "sellingPrice" | "productionPrice";
      value: string;
      nextCell?: { productId: number; field: "sellingPrice" | "productionPrice"; value: string };
    }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await modeApiRequest("PATCH", `/api/factory/bale-products/${id}`, { [field]: value });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update price");
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      // Do not interrupt a different cell selected while the request was in flight.
      setEditingCell((current) => {
        if (!current || current.productId !== variables.id || current.field !== variables.field) return current;
        return variables.nextCell ?? null;
      });
      toast({ title: "Price Updated", description: "Price has been saved and will take effect everywhere." });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const handleStartEdit = (product: FactoryBaleProduct, field: "sellingPrice" | "productionPrice") => {
    if (!recordChanges.allowed) return;
    const currentValue = field === "sellingPrice" ? product.sellingPrice || "0" : product.productionPrice || "0";
    setEditingCell({ productId: product.id, field, value: currentValue });
  };
  return {
    mhd,
    toast,
    modeApiRequest,
    recordChanges,
    search,
    setSearch,
    categoryFilter,
    setCategoryFilter,
    showZeroOnly,
    setShowZeroOnly,
    editingCell,
    setEditingCell,
    setIsUploading,
    isUploading,
    inputRef,
    fileInputRef,
    products,
    refetchProducts,
    productsError,
    isLoading,
    categories,
    updatePriceMutation,
    handleStartEdit,
  };
}
