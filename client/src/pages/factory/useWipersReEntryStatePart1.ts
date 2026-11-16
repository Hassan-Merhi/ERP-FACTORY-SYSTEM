// Extracted from ./WipersReEntry.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { isZebraMode, printRawZpl } from "@/lib/zebraPrint";
import { buildZplBatch } from "@/lib/zplBuilder";
import { getPaperFormat } from "@/components/LabelPrintSettings";
import type { A4DesignColor, LabelData } from "@/lib/labelHtml";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import type { FactoryBale, FactoryBaleProduct, FactoryCategory, Location } from "@shared/schema";
import type { CartItem, CreatedBale } from "./wipersreentry/types";
import { exportCreatedBalesWorkbook } from "./wipersreentry/exportWorkbook";
import { isWipers, isWipersBale } from "./wipersreentry/utils";
import { preparePriorityWipersLabels, printLabelsInBrowser } from "./wipersreentry/printUtils";
import { productMatchesSearch } from "@shared/factoryProductSearch";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

export function useWipersReEntryStatePart1() {
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { colors } = useLabelDesignColors();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const accessReady = Boolean(
    selectedCompany?.id && myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
  );
  const hiddenTabs = accessReady ? (myAccess?.hiddenCostFields ?? []) : [];
  const showRelabeling = accessReady && !hiddenTabs.includes("hide_tab_relabeling_main");
  const showWipersReEntry = accessReady && !hiddenTabs.includes("hide_tab_relabeling_wipers");
  const [entryDate, setEntryDate] = useState<string>(new Date().toLocaleDateString("en-CA"));
  const [selectedLocationId, setSelectedLocationId] = useState<string>("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [createdBales, setCreatedBales] = useState<CreatedBale[] | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupSelectedIds, setCleanupSelectedIds] = useState<Set<number>>(new Set());
  const [supervisorUsername, setSupervisorUsername] = useState("");
  const [supervisorPassword, setSupervisorPassword] = useState("");
  const [designPickerOpen, setDesignPickerOpen] = useState(false);
  const [pendingLabels, setPendingLabels] = useState<LabelData[] | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const { data: baleProducts, isLoading: productsLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: companyQueryKey("/api/factory/bale-products?profile=picker", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  const { data: locations } = useQuery<Location[]>({
    queryKey: companyQueryKey("/api/locations", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  const { data: categories = [] } = useQuery<FactoryCategory[]>({
    queryKey: companyQueryKey("/api/factory/categories", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  interface WorkerOption {
    id: number;
    fullName?: string;
    name?: string;
  }
  const { data: workers = [] } = useQuery<WorkerOption[]>({
    queryKey: companyQueryKey("/api/factory/workers?profile=picker", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });
  interface BaleListRow {
    bale: FactoryBale;
    product: FactoryBaleProduct;
  }
  const { data: allBalesData = [], isLoading: balesLoading } = useQuery<BaleListRow[]>({
    queryKey: companyQueryKey("/api/factory/bales", selectedCompany?.id),
    enabled: cleanupOpen && Boolean(selectedCompany?.id),
  });
  useEffect(() => {
    setSelectedLocationId("");
    setCart([]);
    setCleanupSelectedIds(new Set());
    setCreatedBales(null);
    setConfirmOpen(false);
    setCleanupOpen(false);
    setSupervisorUsername("");
    setSupervisorPassword("");
    setPendingLabels(null);
  }, [selectedCompany?.id]);
  const activeLocations = locations?.filter((l) => l.active) ?? [];
  const wiperProducts = baleProducts?.filter((p) => p.active && isWipers(p, categories)) ?? [];
  const currentWipersBales = allBalesData
    .filter((row) => isWipersBale(row))
    .map((row) => ({ ...row.bale, _product: row.product }));
  const filteredProducts =
    searchInput.trim().length > 0
      ? wiperProducts.filter((p) => productMatchesSearch(p, searchInput)).slice(0, 20)
      : wiperProducts.slice(0, 20);
  const totalQty = cart.reduce((s, i) => s + i.qty, 0);
  const totalKg = cart.reduce((s, i) => s + i.qty * i.weightPerBaleKg, 0);
  const cleanupTotalKg = currentWipersBales.reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0);
  const addToCart = (product: FactoryBaleProduct) => {
    const defaultWeight = product.weightPerBaleKg ? parseFloat(product.weightPerBaleKg) : 25;
    setCart((prev) => {
      const existing = prev.find((i) => i.productId === product.id);
      if (existing) return prev.map((i) => (i.productId === product.id ? { ...i, qty: i.qty + 1 } : i));
      return [...prev, { productId: product.id, product, qty: 1, weightPerBaleKg: defaultWeight, finalizedBy: null }];
    });
    setSearchInput("");
    setShowDropdown(false);
    setSearchError("");
    setTimeout(() => scanRef.current?.focus(), 50);
  };
  const updateQty = (productId: number, delta: number) => {
    setCart((prev) => prev.map((i) => (i.productId === productId ? { ...i, qty: Math.max(1, i.qty + delta) } : i)));
  };
  const setQtyDirect = (productId: number, val: string) => {
    const n = parseInt(val);
    if (!isNaN(n) && n >= 1) {
      setCart((prev) => prev.map((i) => (i.productId === productId ? { ...i, qty: n } : i)));
    }
  };
  const updateWeight = (productId: number, val: string) => {
    const n = parseFloat(val);
    if (!isNaN(n) && n > 0) {
      setCart((prev) => prev.map((i) => (i.productId === productId ? { ...i, weightPerBaleKg: n } : i)));
    }
  };

  const removeItem = (productId: number) => {
    setCart((prev) => prev.filter((i) => i.productId !== productId));
  };

  const assignWorker = (productId: number, workerId: number | null) => {
    setCart((prev) => prev.map((i) => (i.productId === productId ? { ...i, finalizedBy: workerId } : i)));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && filteredProducts.length > 0) {
      e.preventDefault();
      addToCart(filteredProducts[0]);
    }
  };

  const toggleCleanupSelect = (id: number) => {
    setCleanupSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (cleanupSelectedIds.size === currentWipersBales.length) {
      setCleanupSelectedIds(new Set());
    } else {
      setCleanupSelectedIds(new Set(currentWipersBales.map((b) => b.id)));
    }
  };

  const stockEntryMutation = useMutation({
    mutationFn: async () => {
      const items = cart.map((item) => ({
        productId: item.productId,
        quantity: item.qty,
        weightPerBale: item.weightPerBaleKg.toString(),
        finalizedBy: item.finalizedBy,
      }));
      const body = { items, erpLocationId: parseInt(selectedLocationId), entryDate };
      const response = await modeApiRequest("POST", "/api/factory/stock-entry", body);
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Failed to create bales");
      }
      return await response.json();
    },
    onSuccess: (data) => {
      setCreatedBales(data.bales || []);
      setCart([]);
      setConfirmOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products?profile=picker"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      toast({ title: "Bales Created", description: `${data.bales?.length || 0} bales entered under ${entryDate}` });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const cleanupMutation = useMutation({
    mutationFn: async () => {
      const baleIds = Array.from(cleanupSelectedIds);
      const response = await modeApiRequest("POST", "/api/factory/stock-entry/remove", {
        baleIds,
        supervisorUsername,
        supervisorPassword,
        reason: "Wipers stock cleanup before re-entry",
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Failed to remove bales");
      }
      return await response.json();
    },
    onSuccess: (data) => {
      setCleanupSelectedIds(new Set());
      setSupervisorUsername("");
      setSupervisorPassword("");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
      toast({
        title: "Bales Removed",
        description: `${data.removed} bales removed from stock`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Removal Failed", description: err.message, variant: "destructive" });
    },
  });
  return {
    activeLocations,
    addToCart,
    assignWorker,
    balesLoading,
    cart,
    cleanupMutation,
    cleanupOpen,
    cleanupSelectedIds,
    cleanupTotalKg,
    colors,
    confirmOpen,
    createdBales,
    currentWipersBales,
    designPickerOpen,
    entryDate,
    filteredProducts,
    handleKeyDown,
    modeApiRequest,
    navigate,
    pendingLabels,
    productsLoading,
    removeItem,
    scanRef,
    searchError,
    searchInput,
    selectedLocationId,
    setCart,
    setCleanupOpen,
    setConfirmOpen,
    setDesignPickerOpen,
    setEntryDate,
    setPendingLabels,
    setQtyDirect,
    setSearchError,
    setSearchInput,
    setSelectedLocationId,
    setShowDropdown,
    setSupervisorPassword,
    setSupervisorUsername,
    showDropdown,
    showRelabeling,
    showWipersReEntry,
    stockEntryMutation,
    supervisorPassword,
    supervisorUsername,
    toast,
    toggleCleanupSelect,
    toggleSelectAll,
    totalKg,
    totalQty,
    updateQty,
    updateWeight,
    wiperProducts,
    workers,
  };
}

export function useWipersReEntryStatePart2({
  createdBales,
  entryDate,
  modeApiRequest,
  setDesignPickerOpen,
  setPendingLabels,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useWipersReEntryStatePart1>>,
  "createdBales" | "entryDate" | "modeApiRequest" | "setDesignPickerOpen" | "setPendingLabels" | "toast"
>) {
  const openBrowserPrint = (labels: LabelData[], format: "A4" | "A5" | "sticker", designColor?: A4DesignColor) => {
    if (printLabelsInBrowser(labels, format, designColor)) return;
    setPendingLabels(labels);
    setDesignPickerOpen(true);
  };

  const handlePrint = async (format: "A4" | "A5" | "sticker") => {
    if (!createdBales || createdBales.length === 0) return;
    const labels = await preparePriorityWipersLabels(createdBales, modeApiRequest, toast);
    if (!labels) return;

    if (isZebraMode() && format === "sticker" && !labels.some((label) => label.priorityColor)) {
      try {
        const zpl = buildZplBatch(labels, true);
        await printRawZpl(zpl);
        toast({ title: "Labels sent to Zebra printer" });
        return;
      } catch (err) {
        toast({
          title: "Zebra failed",
          description: getErrorDetails(err).message + " — using browser print",
          variant: "destructive",
        });
      }
    }
    openBrowserPrint(labels, format);
  };

  const handlePrintAll = async () => {
    if (!createdBales || createdBales.length === 0) return;
    const labels = await preparePriorityWipersLabels(createdBales, modeApiRequest, toast);
    if (!labels) return;
    const paperFormat = getPaperFormat();
    if (paperFormat === "A4") {
      setPendingLabels(labels);
      setDesignPickerOpen(true);
    } else {
      openBrowserPrint(labels, "sticker");
    }
  };

  const exportCsv = async () => {
    if (!createdBales) return;
    try {
      await exportCreatedBalesWorkbook(createdBales, entryDate);
    } catch (err) {
      toast({
        title: "Export failed",
        description: getErrorDetails(err).optionalMessage || "Could not generate Excel file.",
        variant: "destructive",
      });
    }
  };
  return { exportCsv, handlePrint, handlePrintAll, openBrowserPrint };
}
