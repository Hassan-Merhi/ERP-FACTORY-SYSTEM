// Extracted from ./ContainerVerification.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import * as XLSX from "@/lib/excelHelper";
import type { LoadedItem, LoadedItemDraft, VerificationResult } from "./containerverification/types";
import type { ContainerDetailData } from "./containers/types";
import type { Supplier, SupplierProforma } from "@shared/schema";
import type { AuthMe } from "@shared/apiTypes";
import type { LoadedItemSyncResult, SupplierDetailResponse } from "./ContainerVerificationTypes";

export function useContainerVerificationStatePart1() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const autoCompare = new URLSearchParams(searchString).get("autoCompare") === "true";
  const autoSupplierId = new URLSearchParams(searchString).get("supplierId") || "";
  const params = useParams<{ containerId: string }>();
  useEscapeToParent();
  const containerId = parseInt(params.containerId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep barcode-conflict diagnostics visible only to the Developer role.
  const { data: currentUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";

  const [selectedSupplierId, setSelectedSupplierId] = useState<string>("");
  const [selectedProformaId, setSelectedProformaId] = useState<string>("");
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null);
  const [autoCompareTriggered, setAutoCompareTriggered] = useState(false);
  const [viewMode, setViewMode] = useState<"detailed" | "summary">("detailed");

  const { data: containerData } = useQuery<ContainerDetailData>({
    queryKey: [`/api/containers/${containerId}`],
    enabled: !!containerId,
  });

  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ["/api/suppliers", "allowParentFallback"],
    queryFn: async () => {
      const res = await fetch("/api/suppliers?allowParentFallback=true", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch suppliers");
      return res.json();
    },
  });

  const { data: selectedSupplierData } = useQuery<SupplierDetailResponse | null>({
    queryKey: ["/api/suppliers", selectedSupplierId],
    queryFn: async () => {
      if (!selectedSupplierId) return null;
      const res = await fetch(`/api/suppliers/${selectedSupplierId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!selectedSupplierId && !suppliers.some((s) => String(s.id) === selectedSupplierId),
  });

  const { data: proformas = [] } = useQuery<SupplierProforma[]>({
    queryKey: ["/api/suppliers", selectedSupplierId, "proformas"],
    queryFn: async () => {
      if (!selectedSupplierId) return [];
      const res = await fetch(`/api/suppliers/${selectedSupplierId}/proformas`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch proformas");
      return res.json();
    },
    enabled: !!selectedSupplierId,
  });

  const { data: loadedItems = [] } = useQuery<LoadedItem[]>({
    queryKey: ["/api/containers", containerId, "loaded-items"],
    queryFn: async () => {
      const res = await fetch(`/api/containers/${containerId}/loaded-items`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch loaded items");
      return res.json();
    },
    enabled: !!containerId && !!containerData?.container,
  });

  const addItemMutation = useMutation({
    mutationFn: async (data: LoadedItemDraft) => {
      const res = await apiRequest("POST", `/api/containers/${containerId}/loaded-items`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers", containerId, "loaded-items"] });
      if (verificationResult) generateComparison();
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    },
  });

  const updateItemMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: LoadedItemDraft }) => {
      const res = await apiRequest("PATCH", `/api/container-loaded-items/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers", containerId, "loaded-items"] });
      if (verificationResult) generateComparison();
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  const deleteItemMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/container-loaded-items/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers", containerId, "loaded-items"] });
      if (verificationResult) generateComparison();
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    },
  });

  const syncLoadedItemsFromContainer = useCallback(async (): Promise<LoadedItemSyncResult> => {
    const res = await apiRequest("POST", `/api/containers/${containerId}/auto-populate-loaded-items?replace=true`);
    return res.json() as Promise<LoadedItemSyncResult>;
  }, [containerId]);

  const autoPopulateMutation = useMutation({
    mutationFn: async (_showToast: boolean) => syncLoadedItemsFromContainer(),
    onSuccess: (data, showToast) => {
      queryClient.setQueryData<LoadedItem[]>(["/api/containers", containerId, "loaded-items"], data.items);
      if (!showToast) return;
      const skippedMsg = data.skipped > 0 ? ` (${data.skipped} skipped - missing barcodes)` : "";
      toast({
        title: "Container items refreshed",
        description: `${data.imported} current item lines loaded from the latest container details${skippedMsg}`,
      });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (
      items: { barcode: string; itemName: string; qty: number; weightPerBale: string; pricePerBale: string }[]
    ) => {
      const res = await apiRequest("POST", `/api/containers/${containerId}/import-loaded-items`, { items });
      return res.json() as Promise<{ imported: number; items: LoadedItem[] }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers", containerId, "loaded-items"] });
      toast({ title: "Import complete", description: `${data.imported} items imported` });
      if (verificationResult) generateComparison();
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Import error", description: e.message, variant: "destructive" });
    },
  });

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const wb = await XLSX.read(data, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws);
        const items = rows
          .map((r) => ({
            barcode: String(r.Barcode || r.barcode || "").trim(),
            itemName: String(r["Item Name"] || r.itemName || r.Name || "").trim(),
            qty: parseInt(String(r.Qty || r.qty || r.Quantity || 0), 10) || 0,
            weightPerBale: String(r["Weight per Bale"] || r.weightPerBale || r.Weight || "0"),
            pricePerBale: String(r["Price per Bale"] || r.pricePerBale || r.Price || "0"),
          }))
          .filter((l) => l.barcode);
        if (items.length === 0) {
          toast({ title: "No data found", variant: "destructive" });
          return;
        }
        importMutation.mutate(items);
      } catch (err) {
        toast({ title: "Parse error", description: getErrorDetails(err).message, variant: "destructive" });
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  const generateComparison = useCallback(
    async (supplierId?: string, proformaId?: string, refreshContainerItems = true) => {
      const sid = supplierId ?? selectedSupplierId;
      const pid = proformaId ?? selectedProformaId;
      if (!sid || !pid) {
        toast({ title: "Select supplier and proforma first", variant: "destructive" });
        return;
      }
      try {
        if (refreshContainerItems) {
          const syncResult = await syncLoadedItemsFromContainer();
          queryClient.setQueryData<LoadedItem[]>(["/api/containers", containerId, "loaded-items"], syncResult.items);
        }

        const res = await fetch(
          `/api/suppliers/${sid}/containers/${containerId}/verification-summary?proformaId=${pid}`,
          { credentials: "include", cache: "no-store" }
        );
        if (!res.ok) {
          const e = await res.json();
          throw new Error(e.message);
        }
        const data = await res.json();
        setVerificationResult(data);
      } catch (err) {
        toast({ title: "Load failed", description: getErrorDetails(err).message, variant: "destructive" });
      }
    },
    [selectedSupplierId, selectedProformaId, containerId, toast, syncLoadedItemsFromContainer]
  );
  return {
    addItemMutation,
    autoCompare,
    autoCompareTriggered,
    autoPopulateMutation,
    autoSupplierId,
    containerData,
    containerId,
    deleteItemMutation,
    fileInputRef,
    generateComparison,
    handleFileImport,
    isDeveloper,
    loadedItems,
    navigate,
    proformas,
    selectedProformaId,
    selectedSupplierData,
    selectedSupplierId,
    setAutoCompareTriggered,
    setSelectedProformaId,
    setSelectedSupplierId,
    setVerificationResult,
    setViewMode,
    suppliers,
    toast,
    updateItemMutation,
    verificationResult,
    viewMode,
  };
}
