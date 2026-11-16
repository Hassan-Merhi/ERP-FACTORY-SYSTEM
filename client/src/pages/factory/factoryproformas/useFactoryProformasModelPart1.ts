// Extracted from ./useFactoryProformasModel.ts to keep that module under the source-size cap.
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { keyStartsWith, queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { factoryRecordChangeAccess } from "../factoryRecordChangeAccess";
import type { CatalogStockItem, Customer, Proforma, ProformaLine } from "./types";

export function useFactoryProformasModelPart1() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const { formatAmount } = useCurrencyContext();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [, navigate] = useLocation();
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("customerId") || "";
  });
  const [expandedProformaIds, setExpandedProformaIds] = useState<Set<number>>(() => {
    const params = new URLSearchParams(window.location.search);
    const ep = params.get("expandProformaId");
    return ep ? new Set([parseInt(ep, 10)]) : new Set();
  });
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newProformaName, setNewProformaName] = useState("");
  const [newDestination, setNewDestination] = useState("");
  const [isAddLineOpen, setIsAddLineOpen] = useState(false);
  const [addLineProformaId, setAddLineProformaId] = useState<number | null>(null);
  const [newLine, setNewLine] = useState({ articleCode: "", productName: "", quantity: "", pricePerBale: "" });
  const [editingLine, setEditingLine] = useState<ProformaLine | null>(null);
  const [editLineValues, setEditLineValues] = useState({
    productName: "",
    quantity: "",
    pricePerBale: "",
    weightPerBaleKg: "",
  });
  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);
  const [inlineQtyLineId, setInlineQtyLineId] = useState<number | null>(null);
  const [inlineQtyValue, setInlineQtyValue] = useState<string>("");
  const [renamingProforma, setRenamingProforma] = useState<Proforma | null>(null);
  const [destinationProforma, setDestinationProforma] = useState<Proforma | null>(null);
  const [destinationValue, setDestinationValue] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [addLineMode, setAddLineMode] = useState<"manual" | "catalog">("catalog");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogSelectedItem, setCatalogSelectedItem] = useState<CatalogStockItem | null>(null);
  const [createLoadingProforma, setCreateLoadingProforma] = useState<Proforma | null>(null);
  const [createLoadingLocationId, setCreateLoadingLocationId] = useState<string>("");
  const [transferProforma, setTransferProforma] = useState<Proforma | null>(null);
  const [transferTargetCustomerId, setTransferTargetCustomerId] = useState<string>("");
  const [showInactive, setShowInactive] = useState(false);
  const [proformaSearch, setProformaSearch] = useState("");

  // Excel import state
  const [isExcelImportOpen, setIsExcelImportOpen] = useState(false);
  const [excelImportName, setExcelImportName] = useState("");
  const [excelImportDestination, setExcelImportDestination] = useState("");
  const [excelImportLines, setExcelImportLines] = useState<
    { articleCode: string; productName: string; quantity: string; pricePerBale: string }[]
  >([]);
  const [excelImportErrors, setExcelImportErrors] = useState<string[]>([]);
  const [excelImportLoading, setExcelImportLoading] = useState(false);
  const excelFileInputRef = useRef<HTMLInputElement>(null);

  const customerId = selectedCustomerId ? parseInt(selectedCustomerId) : null;

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  // Cost visibility is fail-closed until the chosen-company access response arrives.
  const accessReady = Boolean(myAccess && myAccess.companyId === selectedCompany?.id && myAccess.hasFactoryAccess);
  const hideProformaPrice =
    !accessReady ||
    myAccess?.hideAllCosts === true ||
    myAccess?.hiddenCostFields?.includes("hide_proforma_price") === true;

  const { data: currentUser } = useQuery<{ role: string }>({ queryKey: ["/api/auth/me"] });
  // View Only and Create Only company roles never change existing proformas.
  const recordChanges = factoryRecordChangeAccess(selectedCompany?.role);
  const canEdit = recordChanges.allowed && ["Admin", "Owner", "Developer"].includes(currentUser?.role || "");

  const { data: customers = [], isLoading: customersLoading } = useQuery<Customer[]>({
    queryKey: companyQueryKey("/api/factory/customers", selectedCompany?.id),
  });

  // Phase 3: list cards use a genuinely compact summary contract. Individual
  // line arrays are fetched only for cards the user explicitly expands.
  const { data: proformas = [], isLoading: proformasLoading } = useQuery<Proforma[]>({
    queryKey: companyQueryKey(
      `/api/factory/customer-proformas?customerId=${customerId}&profile=summary`,
      selectedCompany?.id,
      customerId
    ),
    queryFn: async () => {
      if (!customerId) return [];
      const response = await modeApiRequest(
        "GET",
        `/api/factory/customer-proformas?customerId=${customerId}&profile=summary`
      );
      if (!response.ok) throw new Error("Failed to load proformas");
      return response.json();
    },
    enabled: !!customerId && Boolean(selectedCompany?.id),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const expandedProformaIdList = Array.from(expandedProformaIds).sort((a, b) => a - b);
  const expandedProformaQueries = useQueries({
    queries: expandedProformaIdList.map((proformaId) => ({
      queryKey: companyQueryKey("/api/factory/customer-proformas", selectedCompany?.id, proformaId),
      queryFn: async () => {
        const response = await modeApiRequest("GET", `/api/factory/customer-proformas/${proformaId}`);
        if (!response.ok) throw new Error("Failed to load proforma items");
        return response.json() as Promise<Proforma>;
      },
      enabled: Boolean(selectedCompany?.id),
      staleTime: 5 * 60_000,
      gcTime: 15 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
    })),
  });
  const expandedProformaStateById = new Map<
    number,
    { data?: Proforma; isLoading: boolean; isError: boolean; refetch: () => unknown }
  >();
  expandedProformaIdList.forEach((proformaId, index) => {
    const query = expandedProformaQueries[index];
    expandedProformaStateById.set(proformaId, {
      data: query?.data as Proforma | undefined,
      isLoading: query?.isLoading ?? false,
      isError: query?.isError ?? false,
      refetch: () => query?.refetch(),
    });
  });

  const invalidateCustomerProformas = () =>
    queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-proformas") });

  // Phase 4: opening/expanding a proforma no longer downloads the ERP stock
  // catalog. The add-item dialog is the only consumer, and it only needs the
  // identity profile (id/code/name/uom).
  const { data: allStockItems = [] } = useQuery<CatalogStockItem[]>({
    queryKey: ["/api/stock-items/light?profile=identity", selectedCompany?.id],
    enabled: isAddLineOpen && !!selectedCompany?.id,
    staleTime: 30 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  // The customer may have different agreed prices at each destination.
  const addLineDestination = proformas.find((p) => p.id === addLineProformaId)?.destination;
  const { data: customerPriceList = [] } = useQuery<{ article_code: string; price_per_bale: string }[]>({
    queryKey: companyQueryKey("/api/factory/customer-price-lists", selectedCompany?.id, customerId, addLineDestination),
    queryFn: async () => {
      const response = await modeApiRequest(
        "GET",
        `/api/factory/customer-price-lists/${customerId}?destination=${encodeURIComponent(addLineDestination || "")}`
      );
      if (!response.ok) throw new Error("Failed to load destination prices");
      return response.json();
    },
    enabled: !!customerId && isAddLineOpen && !!addLineDestination && Boolean(selectedCompany?.id),
  });

  const priceListMap = Object.fromEntries(customerPriceList.map((p) => [p.article_code, p.price_per_bale]));

  const { data: locations = [] } = useQuery<{ id: number; name: string; code: string }[]>({
    queryKey: companyQueryKey("/api/locations", selectedCompany?.id),
    enabled: !!createLoadingProforma && Boolean(selectedCompany?.id),
  });

  const createLoadingMutation = useMutation({
    mutationFn: async ({ proformaId, locationId }: { proformaId: number; locationId: string }) => {
      const res = await modeApiRequest("POST", `/api/factory/customer-proformas/${proformaId}/create-loading`, {
        locationId: parseInt(locationId),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      const balesAdded = data.balesAdded ?? 0;
      toast({
        title: "Pending Loading Created",
        description: `Loading #${data.order.id} created — ${balesAdded} bale${balesAdded !== 1 ? "s" : ""} added from stock`,
      });
      queryClient.invalidateQueries({ predicate: keyStartsWith("/api/factory/customer-orders") });
      setCreateLoadingProforma(null);
      setCreateLoadingLocationId("");
      navigate("/factory/sales/loadings");
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createProformaMutation = useMutation({
    mutationFn: async (data: { customerId: number; name: string; destination: string; isActive: boolean }) => {
      return await modeApiRequest("POST", "/api/factory/customer-proformas", data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Proforma created successfully" });
      invalidateCustomerProformas();
      setIsCreateOpen(false);
      setNewProformaName("");
      setNewDestination("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });
  return {
    addLineMode,
    addLineProformaId,
    allStockItems,
    canEdit,
    catalogSearch,
    catalogSelectedItem,
    createLoadingLocationId,
    createLoadingMutation,
    createLoadingProforma,
    createProformaMutation,
    customerId,
    customers,
    customersLoading,
    destinationProforma,
    destinationValue,
    editLineValues,
    editingLine,
    excelFileInputRef,
    excelImportDestination,
    excelImportErrors,
    excelImportLines,
    excelImportLoading,
    excelImportName,
    expandedProformaIds,
    expandedProformaStateById,
    formatAmount,
    hideProformaPrice,
    inlineQtyLineId,
    inlineQtyValue,
    invalidateCustomerProformas,
    isAddLineOpen,
    isCreateOpen,
    isExcelImportOpen,
    locations,
    modeApiRequest,
    navigate,
    newDestination,
    newLine,
    newProformaName,
    pendingDelete,
    priceListMap,
    proformaSearch,
    proformas,
    proformasLoading,
    recordChanges,
    renameValue,
    renamingProforma,
    selectedCustomerId,
    setAddLineMode,
    setAddLineProformaId,
    setCatalogSearch,
    setCatalogSelectedItem,
    setCreateLoadingLocationId,
    setCreateLoadingProforma,
    setDestinationProforma,
    setDestinationValue,
    setEditLineValues,
    setEditingLine,
    setExcelImportDestination,
    setExcelImportErrors,
    setExcelImportLines,
    setExcelImportLoading,
    setExcelImportName,
    setExpandedProformaIds,
    setInlineQtyLineId,
    setInlineQtyValue,
    setIsAddLineOpen,
    setIsCreateOpen,
    setIsExcelImportOpen,
    setNewDestination,
    setNewLine,
    setNewProformaName,
    setPendingDelete,
    setProformaSearch,
    setRenameValue,
    setRenamingProforma,
    setSelectedCustomerId,
    setShowInactive,
    setTransferProforma,
    setTransferTargetCustomerId,
    showInactive,
    toast,
    transferProforma,
    transferTargetCustomerId,
  };
}
