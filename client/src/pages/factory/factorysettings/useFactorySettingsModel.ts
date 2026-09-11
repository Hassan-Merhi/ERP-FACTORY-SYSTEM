import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { FactorySettingsData, Location, RenamePreviewItem, WaChat } from "./types";
import { defaultSettings } from "./utils";

type OcContainer = {
  containerId: number;
  containerNumber: string;
  charges: { id: number; description: string; amount: string; currencyCode: string }[];
};

type BaleValidationResult = {
  totalRows: number;
  validRows: {
    rowIndex: number;
    articleCode: string;
    productName: string;
    productId: number;
    quantity: number;
    weight: number;
    productionDate: string;
  }[];
  skippedRows: { rowIndex: number; articleCode: string; reason: string }[];
  totalBales: number;
  totalWeight: number;
  totalProducts: number;
};

export function useFactorySettingsModel() {
  const { toast } = useToast();
  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";
  const [settings, setSettings] = useState<FactorySettingsData>(defaultSettings);

  const [prodWaGroupId, setProdWaGroupId] = useState("");
  const [prodWaSearch, setProdWaSearch] = useState("");
  const [prodWaPickerOpen, setProdWaPickerOpen] = useState(false);
  const [weeklyWaGroupId, setWeeklyWaGroupId] = useState("");
  const [weeklyWaSearch, setWeeklyWaSearch] = useState("");
  const [weeklyWaPickerOpen, setWeeklyWaPickerOpen] = useState(false);

  const [codePrefix, setCodePrefix] = useState("HMD13");
  const [findStr, setFindStr] = useState("-");
  const [replaceStr, setReplaceStr] = useState(" ");
  const [renamePreview, setRenamePreview] = useState<RenamePreviewItem[] | null>(null);

  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [excelResult, setExcelResult] = useState<{
    created: number;
    updated: number;
    categoriesCreated: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [baleImportFile, setBaleImportFile] = useState<File | null>(null);
  const [baleImportResult, setBaleImportResult] = useState<{
    totalBalesCreated: number;
    skippedRows: number;
    skippedDetails: string[];
  } | null>(null);
  const baleFileInputRef = useRef<HTMLInputElement>(null);
  const [baleImportLocationId, setBaleImportLocationId] = useState("");
  const [baleValidationResult, setBaleValidationResult] = useState<BaleValidationResult | null>(null);

  const [ocPreview, setOcPreview] = useState<OcContainer[] | null>(null);
  const [ocFixResult, setOcFixResult] = useState<{ fixed: number } | null>(null);

  const ocPreviewMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("GET", "/api/factory/admin/other-charges-currency-preview");
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed");
      }
      return res.json() as Promise<{ containers: OcContainer[] }>;
    },
    onSuccess: (data) => {
      setOcPreview(data.containers);
      setOcFixResult(null);
      if (data.containers.length === 0) {
        toast({ title: "All clear", description: "No other charges found with non-USD currency." });
      }
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const ocFixMutation = useMutation({
    mutationFn: async (containerIds: number[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/admin/fix-other-charges-currency", { containerIds });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed");
      }
      return res.json() as Promise<{ fixed: number }>;
    },
    onSuccess: (data) => {
      setOcFixResult(data);
      setOcPreview(null);
      toast({ title: "Fixed", description: `${data.fixed} container(s) re-posted in USD.` });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/net-profit-statement"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("POST", "/api/factory/bale-products/bulk-rename-preview", {
        codePrefix,
        find: findStr,
        replace: replaceStr,
      });
      return res.json();
    },
    onSuccess: (data: { total: number; matches: RenamePreviewItem[] }) => {
      setRenamePreview(data.matches);
      if (data.matches.length === 0) {
        toast({
          title: "No matches",
          description: `Found ${data.total} products with code prefix "${codePrefix}" but none have "${findStr}" in their name.`,
        });
      }
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const applyMutation = useMutation({
    mutationFn: async (items: RenamePreviewItem[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/bale-products/bulk-rename-apply", { items });
      return res.json();
    },
    onSuccess: (data: { updated: number }) => {
      toast({ title: "Renamed successfully", description: `${data.updated} product name(s) updated.` });
      setRenamePreview(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const excelUploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/factory/bale-products/import-excel", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data: { created: number; updated: number; categoriesCreated: number }) => {
      setExcelResult(data);
      setExcelFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      toast({
        title: "Excel import complete",
        description: `${data.updated} updated, ${data.created} created${data.categoriesCreated > 0 ? `, ${data.categoriesCreated} categories created` : ""}`,
      });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Import error", description: error.message, variant: "destructive" });
    },
  });

  const baleValidateMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/factory/bales/validate-import", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Validation failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setBaleValidationResult(data);
      setBaleImportResult(null);
      if (data.validRows.length === 0) {
        toast({
          title: "No valid rows",
          description: `All ${data.totalRows} rows were skipped. Check the details below.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Validation complete",
          description: `${data.validRows.length} row(s) ready to import (${data.totalBales} bales, ${data.totalWeight.toFixed(1)} kg)`,
        });
      }
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Validation error", description: error.message, variant: "destructive" });
    },
  });

  const baleImportMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      if (baleImportLocationId) formData.append("locationId", baleImportLocationId);
      const res = await fetch("/api/factory/bales/import-excel", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data: { totalBalesCreated: number; skippedRows: number; skippedDetails: string[] }) => {
      setBaleImportResult(data);
      setBaleValidationResult(null);
      setBaleImportFile(null);
      if (baleFileInputRef.current) baleFileInputRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
      toast({
        title: "Bale import complete",
        description: `${data.totalBalesCreated} bale(s) created${data.skippedRows > 0 ? `, ${data.skippedRows} row(s) skipped` : ""}`,
      });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Import error", description: error.message, variant: "destructive" });
    },
  });

  const { data: locations } = useQuery<Location[]>({ queryKey: ["/api/locations"] });
  const { data, isLoading } = useQuery<FactorySettingsData>({ queryKey: ["/api/factory/settings"] });

  useEffect(() => {
    if (data) {
      setSettings({ ...defaultSettings, ...data });
      const waGroupId = (data as FactorySettingsData & { productionWorkerMatrixWhatsappGroupId?: string | null })
        .productionWorkerMatrixWhatsappGroupId;
      setProdWaGroupId(waGroupId ?? "");
    }
  }, [data]);

  const { data: waChats = [], isLoading: waChatsLoading } = useQuery<WaChat[]>({
    queryKey: ["/api/whatsapp/chats/pos"],
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/whatsapp/chats/pos");
      if (!res.ok) throw new Error("Failed to load chats");
      return res.json();
    },
    enabled: prodWaPickerOpen,
    staleTime: 60_000,
    retry: false,
  });

  const { data: weeklyWaChats = [], isLoading: weeklyWaChatsLoading } = useQuery<WaChat[]>({
    queryKey: ["/api/whatsapp/chats"],
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/whatsapp/chats");
      if (!res.ok) throw new Error("Failed to load chats");
      return res.json();
    },
    enabled: weeklyWaPickerOpen,
    staleTime: 60_000,
    retry: false,
  });

  const { data: weeklyWaSettings } = useQuery<{ groupChatId: string; hasCredentials: boolean }>({
    queryKey: ["/api/factory/weekly-report-wa-settings"],
  });

  useEffect(() => {
    if (weeklyWaSettings?.groupChatId) setWeeklyWaGroupId(weeklyWaSettings.groupChatId);
  }, [weeklyWaSettings]);

  const saveWeeklyWaGroupMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await factoryApiRequest("PATCH", "/api/factory/weekly-report-wa-settings", { groupChatId: chatId });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Save failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/weekly-report-wa-settings"] });
      setWeeklyWaPickerOpen(false);
      toast({ title: "Saved", description: "Weekly report WhatsApp group updated." });
    },
    onError: (error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const filteredWeeklyWaChats = weeklyWaChats.filter(
    (chat) => !weeklyWaSearch || chat.name?.toLowerCase().includes(weeklyWaSearch.toLowerCase())
  );

  const saveProdWaGroupMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await factoryApiRequest("PUT", "/api/factory/settings", {
        productionWorkerMatrixWhatsappGroupId: chatId,
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Save failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/settings"] });
      setProdWaPickerOpen(false);
      toast({ title: "Saved", description: "Production WhatsApp group updated." });
    },
    onError: (error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const filteredWaChats = waChats.filter(
    (chat) => !prodWaSearch || chat.name?.toLowerCase().includes(prodWaSearch.toLowerCase())
  );

  const mutation = useMutation({
    mutationFn: async (updated: FactorySettingsData) => {
      const res = await factoryApiRequest("PUT", "/api/factory/settings", updated);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/settings"] });
      toast({ title: "Settings saved", description: "Factory settings have been updated successfully." });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleToggle = (key: keyof FactorySettingsData) => {
    setSettings((previous) => ({ ...previous, [key]: !previous[key] }));
  };

  const handleNumberChange = (key: keyof FactorySettingsData, value: string) => {
    setSettings((previous) => ({ ...previous, [key]: parseFloat(value) || 0 }));
  };

  const handleSave = () => mutation.mutate(settings);

  const handleEnableAll = () => {
    const allEnabled: FactorySettingsData = {
      ...settings,
      dashboardEnabled: true,
      kpisEnabled: true,
      profitabilityEnabled: true,
      alertsEnabled: true,
      supplierScoringEnabled: true,
      mixOptimizerEnabled: true,
      traceabilityEnabled: true,
      balePhotosEnabled: true,
      wasteTrackingEnabled: true,
      cashflowEnabled: true,
      rolesEnabled: true,
      netProfitEnabled: true,
      productionSummaryEnabled: true,
      supplierReportEnabled: true,
      supplierStatementEnabled: true,
      daybookEnabled: true,
      workersTabPayrollEnabled: true,
      workersTabAttendanceEnabled: true,
      workersTabReportEnabled: true,
      workersTabAdvancesEnabled: true,
      workersTabBonusesEnabled: true,
      balesTabBarcodeEnabled: true,
      balesTabRemoveEnabled: true,
      loadingsTabPendingEnabled: true,
      stockEntryTabEntryEnabled: true,
      stockEntryTabHistoryEnabled: true,
      advancesTabRepaymentsEnabled: true,
      kpisTabWorkerPerformanceEnabled: true,
      kpisTabMixEfficiencyEnabled: true,
      payrollTabWorkerMasterEnabled: true,
      profitabilityTabContainersEnabled: true,
      workersTabCategoriesEnabled: true,
      workerDetailTabStatementEnabled: true,
      workerDetailTabAdvancesEnabled: true,
      workerDetailTabBalesEnabled: true,
      workerDetailTabDocumentsEnabled: true,
    };
    setSettings(allEnabled);
    mutation.mutate(allEnabled);
  };

  return {
    isDeveloper,
    settings,
    isLoading,
    mutation,
    handleToggle,
    handleNumberChange,
    handleSave,
    handleEnableAll,
    locations,
    codePrefix,
    setCodePrefix,
    findStr,
    setFindStr,
    replaceStr,
    setReplaceStr,
    renamePreview,
    setRenamePreview,
    previewMutation,
    applyMutation,
    excelFile,
    setExcelFile,
    excelResult,
    setExcelResult,
    fileInputRef,
    excelUploadMutation,
    baleImportFile,
    setBaleImportFile,
    baleImportResult,
    setBaleImportResult,
    baleFileInputRef,
    baleImportLocationId,
    setBaleImportLocationId,
    baleValidationResult,
    setBaleValidationResult,
    baleValidateMutation,
    baleImportMutation,
    ocPreview,
    ocFixResult,
    ocPreviewMutation,
    ocFixMutation,
    prodWaGroupId,
    setProdWaGroupId,
    prodWaSearch,
    setProdWaSearch,
    prodWaPickerOpen,
    setProdWaPickerOpen,
    waChats,
    waChatsLoading,
    filteredWaChats,
    saveProdWaGroupMutation,
    weeklyWaGroupId,
    setWeeklyWaGroupId,
    weeklyWaSearch,
    setWeeklyWaSearch,
    weeklyWaPickerOpen,
    setWeeklyWaPickerOpen,
    weeklyWaChats,
    weeklyWaChatsLoading,
    filteredWeeklyWaChats,
    saveWeeklyWaGroupMutation,
  };
}
