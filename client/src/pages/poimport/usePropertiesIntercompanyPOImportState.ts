// Extracted from ./PropertiesIntercompanyPOImport.tsx to keep that module under the source-size cap.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguageCode } from "@/contexts/ApplicationLanguageContext";
import { useToast } from "@/hooks/use-toast";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PROPERTIES_PO_IMPORT_ERRORS, propertiesPoImportText } from "@/i18n/propertiesPoImportTranslations";
import {
  initializePropertiesDestinations,
  type PropertiesContainerDestinations,
  updatePropertiesDefaultDestination,
  validatePropertiesImportSelections,
} from "./propertiesDestinationSelections";
import {
  API,
  postForm,
  type AutoRelationship,
  type ImportOutcome,
  type StockVerification,
  type TradingSetup,
  type WorkbookPreview,
} from "./PropertiesIntercompanyPOImportTypes";

export function usePropertiesIntercompanyPOImportState() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const copy = propertiesPoImportText(useApplicationLanguageCode());
  const companyId = selectedCompany?.id ?? 0;
  const activeCompanyId = useRef(companyId);
  activeCompanyId.current = companyId;

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<WorkbookPreview | null>(null);
  const [previewCompanyId, setPreviewCompanyId] = useState<number | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [importDate, setImportDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [defaultDestinationId, setDefaultDestinationId] = useState("");
  const [destinations, setDestinations] = useState<PropertiesContainerDestinations>({});
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [fileInputVersion, setFileInputVersion] = useState(0);
  const [stockReview, setStockReview] = useState<{ signature: string; data: StockVerification } | null>(null);
  const stockSignature = JSON.stringify({
    companyId,
    fileSha256: preview?.sha256 ?? "",
    destinations: Object.entries(destinations)
      .map(([containerNumber, selection]) => [containerNumber, selection.destinationCompanyId])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  });
  const activeStockSignature = useRef(stockSignature);
  activeStockSignature.current = stockSignature;
  const currentStockReview = stockReview?.signature === stockSignature ? stockReview.data : null;

  const {
    data: setup,
    isPending: setupLoading,
    error: setupError,
  } = useQuery<TradingSetup>({
    queryKey: companyQueryKey(`${API}/setup`, companyId),
    enabled: companyId > 0 && selectedCompany?.companyType === "properties",
    queryFn: async () => {
      const response = await fetch(`${API}/setup`, { credentials: "include" });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: PROPERTIES_PO_IMPORT_ERRORS.setupUnavailable }));
        throw new Error(error.message || PROPERTIES_PO_IMPORT_ERRORS.setupUnavailable);
      }
      return (await response.json()) as TradingSetup;
    },
    staleTime: 0,
  });

  // A preview is never carried into a different company or restored from
  // session storage: the original bytes must accompany the verified import.
  useEffect(() => {
    setFile(null);
    setPreview(null);
    setPreviewCompanyId(null);
    setSupplierId("");
    setDefaultDestinationId("");
    setDestinations({});
    setOutcome(null);
    setStockReview(null);
  }, [companyId]);

  const previewMutation = useMutation({
    mutationFn: async ({ selectedFile }: { selectedFile: File; requestedCompanyId: number }) => {
      const body = new FormData();
      body.append("file", selectedFile);
      return postForm<WorkbookPreview>(`${API}/preview`, body);
    },
    onSuccess: (parsed, variables) => {
      if (variables.requestedCompanyId !== activeCompanyId.current) return;
      setPreview(parsed);
      setPreviewCompanyId(variables.requestedCompanyId);
      setDestinations(
        initializePropertiesDestinations(
          parsed.containers.map((container) => container.containerNumber),
          defaultDestinationId
        )
      );
      setOutcome(null);
      toast({ title: copy.parsed, description: [parsed.containers.length, copy.container.toLowerCase()].join(" ") });
    },
    onError: (error: Error) => toast({ title: copy.failure, description: error.message, variant: "destructive" }),
  });

  const verifyStockMutation = useMutation({
    mutationFn: async ({ requestedCompanyId, signature }: { requestedCompanyId: number; signature: string }) => {
      if (
        requestedCompanyId !== activeCompanyId.current ||
        !file ||
        !preview ||
        previewCompanyId !== requestedCompanyId ||
        !setup
      ) {
        throw new Error(copy.stale);
      }
      const verified = validatePropertiesImportSelections(
        preview.containers,
        destinations,
        new Set(setup.destinations.map((destination) => destination.id))
      );
      const body = new FormData();
      body.append("file", file);
      body.append(
        "selections",
        JSON.stringify(
          verified.map((row) => ({
            containerNumber: row.containerNumber,
            destinationCompanyId: row.destinationCompanyId,
          }))
        )
      );
      return {
        signature,
        requestedCompanyId,
        result: await postForm<StockVerification>(`${API}/stock-preview`, body),
      };
    },
    onSuccess: ({ signature, requestedCompanyId, result }) => {
      if (
        requestedCompanyId !== activeCompanyId.current ||
        preview?.sha256 !== result.fileSha256 ||
        signature !== activeStockSignature.current
      )
        return;
      setStockReview({ signature, data: result });
    },
    onError: (error: Error) => {
      setStockReview(null);
      toast({ title: copy.stockReviewFailed, description: error.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (requestedCompanyId: number) => {
      if (requestedCompanyId !== activeCompanyId.current || !preview || previewCompanyId !== requestedCompanyId) {
        throw new Error(copy.stale);
      }
      if (!file) throw new Error(copy.noFile);
      if (
        !supplierId ||
        !setup?.suppliers.some(
          (supplier) => supplier.companyId === requestedCompanyId && supplier.id === Number(supplierId)
        )
      ) {
        throw new Error(copy.missingSupplier);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(importDate)) throw new Error(copy.importDate);
      const permitted = new Set(setup.destinations.map((destination) => destination.id));
      const validated = validatePropertiesImportSelections(preview.containers, destinations, permitted);
      const usedDestinations = [...new Set(validated.map((entry) => entry.destinationCompanyId))];
      const relationshipIds = new Map<number, number>();

      // Provision only the destinations the user selected. These transactions
      // create master data, never cash/stock/vouchers. The financial import
      // below remains one all-or-nothing multi-company PostgreSQL transaction.
      for (const destinationCompanyId of usedDestinations) {
        if (activeCompanyId.current !== requestedCompanyId) throw new Error(copy.stale);
        const response = await apiRequest("POST", `${API}/relationships/auto`, { destinationCompanyId });
        const result = (await response.json()) as AutoRelationship;
        if (!result.tradeEnabled || result.destinationCompanyId !== destinationCompanyId) {
          throw new Error(copy.setupFailed);
        }
        relationshipIds.set(destinationCompanyId, result.relationshipId);
      }
      if (activeCompanyId.current !== requestedCompanyId) throw new Error(copy.stale);
      const body = new FormData();
      body.append("file", file);
      body.append("externalSupplierId", supplierId);
      body.append("importDate", importDate);
      body.append(
        "selections",
        JSON.stringify(
          validated.map((entry) => ({
            containerNumber: entry.containerNumber,
            relationshipId: relationshipIds.get(entry.destinationCompanyId),
            chargesConfirmed: entry.chargesConfirmed,
            ...(entry.chargeEvidenceReference ? { chargeEvidenceReference: entry.chargeEvidenceReference } : {}),
          }))
        )
      );
      return { result: await postForm<ImportOutcome>(`${API}/import`, body), requestedCompanyId };
    },
    onSuccess: async ({ result, requestedCompanyId }) => {
      if (activeCompanyId.current !== requestedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: companyQueryKey(`${API}/trades`, requestedCompanyId) });
        return;
      }
      setOutcome(result);
      setPreview(null);
      setFile(null);
      setFileInputVersion((version) => version + 1);
      setDestinations({});
      setStockReview(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: companyQueryKey(`${API}/setup`, companyId) }),
        queryClient.invalidateQueries({ queryKey: ["/api/containers"] }),
        queryClient.invalidateQueries({ queryKey: companyQueryKey(`${API}/trades`, companyId) }),
      ]);
      toast({ title: copy.imported, description: copy.completeMessage });
    },
    onError: (error: Error) => toast({ title: copy.failure, description: error.message, variant: "destructive" }),
  });

  const changeFile = (next: File | null) => {
    setFile(next);
    setStockReview(null);
    setPreview(null);
    setPreviewCompanyId(null);
    setDestinations({});
    setOutcome(null);
  };
  const changeDefault = (next: string) => {
    setDefaultDestinationId(next);
    setDestinations((previous) => updatePropertiesDefaultDestination(previous, next));
  };

  const canPost =
    Boolean(file && preview && previewCompanyId === companyId && supplierId) &&
    Boolean(setup?.destinations.length) &&
    !importMutation.isPending &&
    !previewMutation.isPending &&
    !verifyStockMutation.isPending &&
    !setupLoading;
  const readyToPost = (() => {
    if (!canPost || !preview || !setup) return false;
    try {
      validatePropertiesImportSelections(
        preview.containers,
        destinations,
        new Set(setup.destinations.map((destination) => destination.id))
      );
      return true;
    } catch {
      return false;
    }
  })();
  return {
    changeDefault,
    changeFile,
    companyId,
    copy,
    currentStockReview,
    defaultDestinationId,
    destinations,
    file,
    fileInputVersion,
    importDate,
    importMutation,
    navigate,
    outcome,
    preview,
    previewCompanyId,
    previewMutation,
    readyToPost,
    setDestinations,
    setImportDate,
    setPreview,
    setPreviewCompanyId,
    setSupplierId,
    setup,
    setupError,
    setupLoading,
    stockSignature,
    supplierId,
    verifyStockMutation,
  };
}
