import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation, useSearch } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { ArrowLeft, Download, FileCheck, List, Star } from "lucide-react";
import * as XLSX from "@/lib/excelHelper";
import { PageHeader } from "@/components/PageHeader";

import { AliasConflictAlert, ComparisonCards } from "./containerverification/ComparisonCards";
import { LoadedItemsCard } from "./containerverification/LoadedItemsCard";
import { SummaryCards } from "./containerverification/SummaryCards";
import type { LoadedItem, LoadedItemDraft, VerificationResult } from "./containerverification/types";
import type { ContainerDetailData } from "./containers/types";
import type { Supplier, SupplierProforma } from "@shared/schema";

type SupplierIdentity = {
  id?: number;
  legalName?: string | null;
  name?: string | null;
  code?: string | null;
};

type SupplierDetailResponse = SupplierIdentity & {
  supplier?: SupplierIdentity;
};

export default function ContainerVerification() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const autoCompare = new URLSearchParams(searchString).get("autoCompare") === "true";
  const autoSupplierId = new URLSearchParams(searchString).get("supplierId") || "";
  const params = useParams<{ containerId: string }>();
  useEscapeToParent();
  const containerId = parseInt(params.containerId);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const { data: loadedItems = [], isLoading: loadingItems } = useQuery<LoadedItem[]>({
    queryKey: ["/api/containers", containerId, "loaded-items"],
    queryFn: async () => {
      const res = await fetch(`/api/containers/${containerId}/loaded-items`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch loaded items");
      return res.json();
    },
    enabled: !!containerId,
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
      toast({ title: "Error", description: e.message, variant: "destructive" });
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
      toast({ title: "Error", description: e.message, variant: "destructive" });
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
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const autoPopulateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/containers/${containerId}/auto-populate-loaded-items`);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers", containerId, "loaded-items"] });
      const skippedMsg = data.skipped > 0 ? ` (${data.skipped} skipped - missing barcodes)` : "";
      toast({
        title: "Items loaded",
        description: `${data.imported} items imported from purchase orders${skippedMsg}`,
      });
      if (verificationResult) generateComparison();
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Error", description: e.message, variant: "destructive" });
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
    async (supplierId?: string, proformaId?: string) => {
      const sid = supplierId ?? selectedSupplierId;
      const pid = proformaId ?? selectedProformaId;
      if (!sid || !pid) {
        toast({ title: "Select supplier and proforma first", variant: "destructive" });
        return;
      }
      try {
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
        toast({ title: "Error", description: getErrorDetails(err).message, variant: "destructive" });
      }
    },
    [selectedSupplierId, selectedProformaId, containerId, toast]
  );

  const exportToExcel = () => {
    if (!selectedSupplierId || !selectedProformaId) return;
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Exports require a connection" });
      return;
    }
    window.open(
      `/api/suppliers/${selectedSupplierId}/containers/${containerId}/verification-export.xlsx?proformaId=${selectedProformaId}`,
      "_blank"
    );
  };

  const exportSummaryExcel = () => {
    if (!selectedSupplierId || !selectedProformaId) return;
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Exports require a connection" });
      return;
    }
    window.open(
      `/api/suppliers/${selectedSupplierId}/containers/${containerId}/verification-summary-export.xlsx?proformaId=${selectedProformaId}`,
      "_blank"
    );
  };

  const requestAutoPopulate = () => {
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Auto-populate requires a connection" });
      return;
    }
    autoPopulateMutation.mutate();
  };

  useEffect(() => {
    const supplierId = containerData?.container?.supplierId;
    if (supplierId && !selectedSupplierId) {
      setSelectedSupplierId(String(supplierId));
    }
  }, [containerData, selectedSupplierId]);

  useEffect(() => {
    if (
      loadedItems.length === 0 &&
      !loadingItems &&
      containerData?.container &&
      !autoPopulateMutation.isPending &&
      !autoPopulateMutation.isSuccess &&
      navigator.onLine
    ) {
      autoPopulateMutation.mutate();
    }
  }, [loadedItems, loadingItems, containerData, autoPopulateMutation]);

  // Auto-select supplier when opened via "Compare" from Daybook (supplierId URL param).
  // Do not require the supplier to exist in the active company's list: containers can
  // legitimately reference a supplier visible through the parent-company fallback.
  useEffect(() => {
    if (!autoSupplierId || selectedSupplierId) return;
    setSelectedSupplierId(autoSupplierId);
  }, [autoSupplierId, selectedSupplierId]);

  // Auto-select proforma when opened via "Compare" button from Daybook.
  // Prefers the starred proforma; falls back to the most recent if none is starred.
  useEffect(() => {
    if (!autoCompare || !selectedSupplierId || proformas.length === 0 || selectedProformaId) return;
    const starred = proformas.find((p) => p.isStarred);
    const pick = starred ?? proformas[proformas.length - 1];
    if (pick) setSelectedProformaId(String(pick.id));
  }, [autoCompare, selectedSupplierId, proformas, selectedProformaId]);

  // Auto-generate comparison once supplier + proforma are both set
  useEffect(() => {
    if (!autoCompare || !selectedSupplierId || !selectedProformaId || autoCompareTriggered) return;
    setAutoCompareTriggered(true);
    generateComparison(selectedSupplierId, selectedProformaId);
  }, [autoCompare, selectedSupplierId, selectedProformaId, autoCompareTriggered, generateComparison]);

  const container = containerData?.container;
  const selectedSupplier = selectedSupplierData?.supplier ?? selectedSupplierData;
  const selectedSupplierMissingFromList =
    !!selectedSupplierId && !suppliers.some((supplier) => String(supplier.id) === selectedSupplierId);
  const overloaded = verificationResult?.comparison.filter((c) => c.statusQty === "OVER_LOADED") || [];
  const lessLoaded =
    verificationResult?.comparison.filter(
      (c) => c.statusQty === "UNDER_LOADED" || c.statusQty === "MISSING_FROM_LOADED"
    ) || [];
  const notRequested = verificationResult?.comparison.filter((c) => c.statusQty === "LOADED_NOT_IN_PROFORMA") || [];
  const priceDiffs = verificationResult?.comparison.filter((c) => c.priceStatus === "PRICE_DIFF") || [];

  return (
    <div className="flex flex-col h-full p-4 lg:p-6 overflow-y-auto">
      <input ref={fileInputRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={handleFileImport} />

      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(`/containers/${containerId}`)}
            data-testid="button-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <PageHeader title="Container Verification" />
            <p className="text-muted-foreground text-sm">
              {container?.containerNumber || `Container #${containerId}`} - Proforma vs Loaded Items
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
        <LoadedItemsCard
          items={loadedItems}
          autoPopulatePending={autoPopulateMutation.isPending}
          onAutoPopulate={requestAutoPopulate}
          onImportClick={() => fileInputRef.current?.click()}
          onAdd={(draft: LoadedItemDraft) => addItemMutation.mutateAsync(draft)}
          onUpdate={(id: number, draft: LoadedItemDraft) => updateItemMutation.mutateAsync({ id, data: draft })}
          onDelete={(id: number) => deleteItemMutation.mutate(id)}
        />

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Generate Comparison</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-xs font-medium mb-1 block">Supplier</label>
              <Select
                value={selectedSupplierId}
                onValueChange={(v) => {
                  setSelectedSupplierId(v);
                  setSelectedProformaId("");
                  setVerificationResult(null);
                }}
              >
                <SelectTrigger data-testid="select-supplier">
                  <SelectValue placeholder="Select supplier" />
                </SelectTrigger>
                <SelectContent>
                  {selectedSupplierMissingFromList && (
                    <SelectItem value={selectedSupplierId}>
                      {selectedSupplier?.legalName ||
                        selectedSupplier?.name ||
                        selectedSupplier?.code ||
                        `Supplier #${selectedSupplierId}`}
                    </SelectItem>
                  )}
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.legalName || s.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Proforma</label>
              <Select value={selectedProformaId} onValueChange={setSelectedProformaId} disabled={!selectedSupplierId}>
                <SelectTrigger data-testid="select-proforma">
                  <SelectValue placeholder={selectedSupplierId ? "Select proforma" : "Select a supplier first"} />
                </SelectTrigger>
                <SelectContent>
                  {proformas.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      <span className="flex items-center gap-1.5">
                        {p.isStarred && <Star className="h-3 w-3 fill-amber-400 text-amber-400 shrink-0" />}
                        {p.reference}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {proformas.length > 0 && !proformas.some((p) => p.isStarred) && (
                <p className="text-xs text-muted-foreground mt-1">
                  Tip: star a proforma on the supplier page to auto-select it here
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => generateComparison()}
                disabled={!selectedSupplierId || !selectedProformaId}
                className="flex-1"
                data-testid="button-generate-comparison"
              >
                <FileCheck className="mr-2 h-4 w-4" />
                Generate Comparison
              </Button>
              {verificationResult && (
                <>
                  <Button variant="outline" onClick={exportToExcel} data-testid="button-export-excel">
                    <Download className="mr-1 h-4 w-4" />
                    Excel
                  </Button>
                  <Button variant="outline" onClick={exportSummaryExcel} data-testid="button-export-summary-excel">
                    <Download className="mr-1 h-4 w-4" />
                    Summary
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {verificationResult && (
        <>
          <AliasConflictAlert conflicts={verificationResult.aliasConflicts ?? []} />
          <div className="flex items-center gap-2 mb-4">
            <Button
              variant={viewMode === "summary" ? "default" : "outline"}
              size="sm"
              onClick={() => setViewMode(viewMode === "summary" ? "detailed" : "summary")}
              className="toggle-elevate"
              data-testid="button-toggle-summary"
            >
              <List className="mr-1.5 h-3.5 w-3.5" />
              {viewMode === "summary" ? "Hide Summary" : "Show Summary"}
            </Button>
          </div>

          <ComparisonCards
            overloaded={overloaded}
            lessLoaded={lessLoaded}
            notRequested={notRequested}
            priceDiffs={priceDiffs}
          />

          {viewMode === "summary" && (
            <SummaryCards
              overloaded={overloaded}
              lessLoaded={lessLoaded}
              notRequested={notRequested}
              priceDiffs={priceDiffs}
            />
          )}
        </>
      )}
    </div>
  );
}
