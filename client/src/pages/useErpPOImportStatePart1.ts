// Extracted from ./POImport.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useCompany } from "@/contexts/CompanyContext";
import type { Supplier } from "@shared/schema";
import {
  draftStorageKey,
  type POImportContainer,
  type POImportDraft,
  type POImportPayload,
  type POImportPreview,
  type POValidationResult,
  withResolvedStockItems,
} from "./poimport/poImportShared";

export function useErpPOImportStatePart1() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<POImportPreview | null>(null);
  const [previewCompanyId, setPreviewCompanyId] = useState<number | null>(null);
  const [validationResult, setValidationResult] = useState<POValidationResult | null>(null);
  const [selectedSupplier, setSelectedSupplier] = useState<string>("");
  const [containerNumber, setContainerNumber] = useState<string>("");
  const [importDate, setImportDate] = useState<string>(new Date().toLocaleDateString("en-CA"));
  const [freightPaidBy, setFreightPaidBy] = useState<"supplier" | "parent">("supplier");
  const [freightParentAccountId, setFreightParentAccountId] = useState<string>("");
  // A USD-base / ZMW-display company must state its invoice currency; a sheet
  // without a Currency column is otherwise read as USD and Kwacha prices would
  // be posted as dollars. Mali and other companies keep the sheet's labels.
  const requiresImportCurrency = selectedCompany?.displayCurrency?.toUpperCase() === "ZMW";
  const [importCurrency, setImportCurrency] = useState<"" | "USD" | "ZMW">("");
  useEffect(() => {
    setImportCurrency("");
    setValidationResult(null);
  }, [selectedCompany?.id]);

  // Keep the parsed PO draft across navigation to Stock and back (and a tab
  // refresh). The uploaded Excel bytes are no longer needed after parsing.
  // Only restore a draft for the active company, never another company's data.
  useEffect(() => {
    const companyId = selectedCompany?.id;
    if (!companyId) return;
    setFile(null);
    setValidationResult(null);
    try {
      const saved = window.sessionStorage.getItem(draftStorageKey(companyId));
      if (saved) {
        const draft = JSON.parse(saved) as POImportDraft;
        if (draft.preview && Array.isArray(draft.preview.preview)) {
          setPreview(draft.preview);
          setPreviewCompanyId(companyId);
          setSelectedSupplier(draft.selectedSupplier || "");
          setContainerNumber(draft.containerNumber || "");
          setImportDate(draft.importDate || new Date().toLocaleDateString("en-CA"));
          setFreightPaidBy(draft.freightPaidBy === "parent" ? "parent" : "supplier");
          setFreightParentAccountId(draft.freightParentAccountId || "");
          setImportCurrency(draft.importCurrency || "");
          return;
        }
      }
    } catch {
      // Storage can be unavailable (private browsing or quota); regular
      // in-memory imports still work.
    }
    setPreview(null);
    setPreviewCompanyId(companyId);
    setSelectedSupplier("");
    setContainerNumber("");
    setFreightParentAccountId("");
    setImportCurrency("");
  }, [selectedCompany?.id]);

  useEffect(() => {
    const companyId = selectedCompany?.id;
    if (!companyId || previewCompanyId !== companyId || !preview) return;
    const draft: POImportDraft = {
      preview,
      selectedSupplier,
      containerNumber,
      importDate,
      freightPaidBy,
      freightParentAccountId,
      importCurrency,
    };
    try {
      window.sessionStorage.setItem(draftStorageKey(companyId), JSON.stringify(draft));
    } catch {
      // Browser storage is optional; the active preview remains intact.
    }
  }, [
    selectedCompany?.id,
    previewCompanyId,
    preview,
    selectedSupplier,
    containerNumber,
    importDate,
    freightPaidBy,
    freightParentAccountId,
    importCurrency,
  ]);

  const {
    data: suppliers = [],
    isLoading: suppliersLoading,
    isError: suppliersError,
  } = useQuery<Supplier[]>({
    queryKey: companyQueryKey("/api/suppliers?allowParentFallback=true", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    // Parent-company assignment can change while this page's company-scoped
    // supplier cache is still inside the normal 30-minute reference-data
    // stale window. PO Import must always re-check the server relationship on
    // entry so a newly created/linked child immediately inherits its parent's
    // suppliers instead of reusing an old empty list.
    staleTime: 0,
    refetchOnMount: "always",
  });

  const { data: parentFreightAccounts = [] } = useQuery<{ id: number; name: string; code: string }[]>({
    queryKey: companyQueryKey("/api/purchase-orders/parent-freight-accounts", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    retry: false,
  });

  // Keep the parsed preview usable while a stock item is created elsewhere in
  // the app. StockItemCreateDialog invalidates this shared query key, which
  // gives the import screen a signal to re-check missing item references.
  const { dataUpdatedAt: stockItemsUpdatedAt } = useQuery({
    queryKey: ["/api/stock-items"],
    enabled: Boolean(selectedCompany?.id),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [validatedAgainstStockItemsAt, setValidatedAgainstStockItemsAt] = useState(0);
  const refreshInFlight = useRef(false);

  const parseMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      const res = await fetch("/api/po-import/parse", { method: "POST", body: formData });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed to parse file");
      }
      return await res.json();
    },
    onSuccess: (data) => {
      setPreview(data);
      setPreviewCompanyId(selectedCompany?.id ?? null);
      setValidationResult(null);
      if (data.preview.length > 0) setContainerNumber(data.preview[0].containerNumber || "");
      toast({
        title: "File parsed successfully",
        description: `Found ${data.preview.length} container(s) with ${data.preview.reduce(
          (sum: number, p: POImportContainer) => sum + p.itemsCount,
          0
        )} items. Click Validate to check the data.`,
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Parse error", description: error.message, variant: "destructive" });
    },
  });

  const validateMutation = useMutation({
    mutationFn: async (data: POImportPayload) => {
      const res = await apiRequest("POST", "/api/po-import/validate", data);
      return await res.json();
    },
    onSuccess: (data: POValidationResult, payload: POImportPayload) => {
      setPreview((current) => withResolvedStockItems(current, payload, data));
      setValidationResult(data);
      const errorCount = data.errors?.length || 0;
      toast({
        title: errorCount === 0 ? "Validation passed" : "Validation failed",
        description:
          errorCount === 0
            ? "All items validated successfully. You can now import the data."
            : `Found ${errorCount} error(s). Please fix them before importing.`,
        variant: errorCount === 0 ? "default" : "destructive",
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Validation error", description: error.message, variant: "destructive" });
    },
  });

  // Silent refresh: the already-parsed spreadsheet stays in memory while newly
  // created stock items are resolved against current server data.
  const refreshStockItemsMutation = useMutation({
    mutationFn: async (payload: POImportPayload): Promise<POValidationResult> => {
      const res = await apiRequest("POST", "/api/po-import/validate", payload);
      return await res.json();
    },
    onSuccess: (data, payload) => {
      setPreview((current) => withResolvedStockItems(current, payload, data));
      // Don't turn a background lookup into an explicit user validation.
      setValidationResult((previous) => (previous === null ? null : data));
    },
    onSettled: () => {
      refreshInFlight.current = false;
    },
  });

  const importMutation = useMutation({
    mutationFn: async (data: POImportPayload) => {
      const res = await apiRequest("POST", "/api/po-import/import", data);
      return await res.json();
    },
    onSuccess: (data) => {
      if (selectedCompany?.id) {
        try {
          window.sessionStorage.removeItem(draftStorageKey(selectedCompany.id));
        } catch {
          // The successful server import is authoritative.
        }
      }
      toast({
        title: data.factoryDispatchReceipt ? "Factory truck PO imported" : "Import successful",
        description: data.factoryDispatchReceipt
          ? `Factory dispatch ${data.factoryDispatchReceipt.origin.factoryDispatchId} linked to ERP container ${data.containerNumber}. Supplier purchase recorded through the existing ERP workflow.`
          : `Container ${data.containerNumber} imported with ${data.itemsCount} items`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/containers"] });
      navigate("/containers");
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Import error", description: error.message, variant: "destructive" });
    },
  });
  return {
    containerNumber,
    file,
    freightPaidBy,
    freightParentAccountId,
    importCurrency,
    importDate,
    importMutation,
    parentFreightAccounts,
    parseMutation,
    preview,
    refreshInFlight,
    refreshStockItemsMutation,
    requiresImportCurrency,
    selectedCompany,
    selectedSupplier,
    setContainerNumber,
    setFile,
    setFreightPaidBy,
    setFreightParentAccountId,
    setImportCurrency,
    setImportDate,
    setPreview,
    setSelectedSupplier,
    setValidatedAgainstStockItemsAt,
    setValidationResult,
    stockItemsUpdatedAt,
    suppliers,
    suppliersError,
    suppliersLoading,
    toast,
    validateMutation,
    validatedAgainstStockItemsAt,
    validationResult,
  };
}
