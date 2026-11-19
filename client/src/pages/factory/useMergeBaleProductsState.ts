// Extracted from ./MergeBaleProducts.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { productMatchesSearch } from "@shared/factoryProductSearch";

interface BaleProduct {
  id: number;
  code: string;
  articleCode: string | null;
  name: string;
  nameAr: string | null;
  active: boolean;
  totalBales: string;
  inStockBales: string;
}

type Step = "select" | "confirm" | "done";

export function useMergeBaleProductsState() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [step, setStep] = useState<Step>("select");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [targetId, setTargetId] = useState<number | null>(null);
  const [result, setResult] = useState<{ movedBales: number; mergedProducts: number; targetName: string } | null>(null);

  const {
    data: products = [],
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<BaleProduct[]>({
    queryKey: ["/api/factory/bale-products/merge-stats"],
    queryFn: async () => {
      const res = await fetch("/api/factory/bale-products/merge-stats", { credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed to load products");
      }
      return res.json();
    },
    retry: 1,
  });

  const mergeMutation = useMutation({
    mutationFn: async ({ targetId, sourceIds }: { targetId: number; sourceIds: number[] }) => {
      const res = await factoryApiRequest("POST", "/api/factory/bale-products/merge", { targetId, sourceIds });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setResult(data);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products/merge-stats"] });
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Merge failed", description: e.message, variant: "destructive" });
    },
  });

  const reset = () => {
    setStep("select");
    setSearch("");
    setSelected(new Set());
    setTargetId(null);
    setResult(null);
  };

  const { filteredProducts, selectedProducts } = useMemo(() => {
    const filteredProducts = search.trim() ? products.filter((p) => productMatchesSearch(p, search)) : products;
    const selectedProducts = products.filter((p) => selected.has(p.id));
    return { filteredProducts, selectedProducts };
  }, [products, search, selected]);

  const canProceed = selected.size >= 2 && targetId !== null;
  const target = products.find((p) => p.id === targetId);
  const sources = products.filter((p) => selected.has(p.id) && p.id !== targetId);
  return {
    navigate,
    step,
    setStep,
    search,
    setSearch,
    selected,
    setSelected,
    targetId,
    setTargetId,
    result,
    isLoading,
    isError,
    error,
    refetch,
    mergeMutation,
    reset,
    filteredProducts,
    selectedProducts,
    canProceed,
    target,
    sources,
  };
}
