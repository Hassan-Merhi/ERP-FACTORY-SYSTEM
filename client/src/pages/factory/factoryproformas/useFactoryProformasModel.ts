import { getErrorDetails } from "@shared/errorUtils";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient, keyStartsWith } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import { read as readExcel, utils as excelUtils, writeFile as writeExcel } from "@/lib/excelHelper";
import type { CatalogStockItem, Customer, Proforma, ProformaLine } from "./types";

export function useFactoryProformasModel() {
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
  const [excelImportLines, setExcelImportLines] = useState<
    { articleCode: string; productName: string; quantity: string; pricePerBale: string }[]
  >([]);
  const [excelImportErrors, setExcelImportErrors] = useState<string[]>([]);
  const [excelImportLoading, setExcelImportLoading] = useState(false);
  const excelFileInputRef = useRef<HTMLInputElement>(null);

  const customerId = selectedCustomerId ? parseInt(selectedCustomerId) : null;

  const { data: myAccess } = useQuery<{ fullAccess: boolean; hiddenCostFields: string[] }>({
    queryKey: ["/api/factory/my-access"],
  });
  const hideProformaPrice = myAccess?.hiddenCostFields?.includes("hide_proforma_price") ?? false;

  const { data: currentUser } = useQuery<{ role: string }>({ queryKey: ["/api/auth/me"] });
  const canEdit = ["Admin", "Owner", "Developer"].includes(currentUser?.role || "");

  const { data: customers = [], isLoading: customersLoading } = useQuery<Customer[]>({
    queryKey: ["/api/factory/customers"],
  });

  // Phase 3: list cards use a genuinely compact summary contract. Individual
  // line arrays are fetched only for cards the user explicitly expands.
  const { data: proformas = [], isLoading: proformasLoading } = useQuery<Proforma[]>({
    queryKey: [`/api/factory/customer-proformas?customerId=${customerId}&profile=summary`, customerId],
    queryFn: async () => {
      if (!customerId) return [];
      const response = await modeApiRequest(
        "GET",
        `/api/factory/customer-proformas?customerId=${customerId}&profile=summary`
      );
      if (!response.ok) throw new Error("Failed to load proformas");
      return response.json();
    },
    enabled: !!customerId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const expandedProformaIdList = Array.from(expandedProformaIds).sort((a, b) => a - b);
  const expandedProformaQueries = useQueries({
    queries: expandedProformaIdList.map((proformaId) => ({
      queryKey: ["/api/factory/customer-proformas", proformaId] as const,
      queryFn: async () => {
        const response = await modeApiRequest("GET", `/api/factory/customer-proformas/${proformaId}`);
        if (!response.ok) throw new Error("Failed to load proforma items");
        return response.json() as Promise<Proforma>;
      },
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

  // Customer price list — used to auto-fill price when adding a new line
  const { data: customerPriceList = [] } = useQuery<{ articleCode: string; pricePerBale: string }[]>({
    queryKey: [`/api/factory/customer-price-lists/${customerId}`, customerId],
    enabled: !!customerId && isAddLineOpen,
  });

  const priceListMap = Object.fromEntries(customerPriceList.map((p) => [p.articleCode, p.pricePerBale]));

  const { data: locations = [] } = useQuery<{ id: number; name: string; code: string }[]>({
    queryKey: ["/api/locations"],
    enabled: !!createLoadingProforma,
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
    mutationFn: async (data: { customerId: number; name: string; isActive: boolean }) => {
      return await modeApiRequest("POST", "/api/factory/customer-proformas", data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Proforma created successfully" });
      invalidateCustomerProformas();
      setIsCreateOpen(false);
      setNewProformaName("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      return await modeApiRequest("PUT", `/api/factory/customer-proformas/${id}`, { isActive });
    },
    onSuccess: (_, vars) => {
      toast({ title: vars.isActive ? "Proforma activated" : "Proforma deactivated" });
      invalidateCustomerProformas();
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      const msg = error.message || "";
      const isStockError = msg.includes("insufficient") || msg.includes("free stock") || msg.includes("needs");
      toast({
        title: isStockError ? "Cannot activate — insufficient stock" : "Error",
        description: isStockError
          ? "One or more articles don't have enough available stock to fulfil this proforma."
          : msg.slice(0, 200),
        variant: "destructive",
      });
    },
  });

  const deleteProformaMutation = useMutation({
    mutationFn: async (id: number) => {
      return await modeApiRequest("DELETE", `/api/factory/customer-proformas/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Proforma deleted" });
      invalidateCustomerProformas();
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const renameProformaMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      return await modeApiRequest("PUT", `/api/factory/customer-proformas/${id}`, { name });
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Proforma renamed successfully" });
      invalidateCustomerProformas();
      setRenamingProforma(null);
      setRenameValue("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const transferProformaMutation = useMutation({
    mutationFn: async ({ id, targetCustomerId }: { id: number; targetCustomerId: number }) => {
      const res = await modeApiRequest("PATCH", `/api/factory/customer-proformas/${id}/transfer`, {
        targetCustomerId,
      });
      return (await res.json()) as { targetCustomerName?: string };
    },
    onSuccess: (data: { targetCustomerName?: string }) => {
      toast({ title: "Proforma transferred", description: `Proforma moved to ${data.targetCustomerName}` });
      invalidateCustomerProformas();
      setTransferProforma(null);
      setTransferTargetCustomerId("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Transfer failed", description: error.message, variant: "destructive" });
    },
  });

  const addLineMutation = useMutation({
    mutationFn: async (data: {
      proformaId: number;
      articleCode: string;
      productName: string;
      quantity: number;
      pricePerBale: string;
    }) => {
      return await modeApiRequest("POST", "/api/factory/customer-proforma-lines", data);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Line added" });
      invalidateCustomerProformas();
      queryClient.invalidateQueries({ queryKey: [`/api/factory/customer-price-lists/${customerId}`, customerId] });
      setIsAddLineOpen(false);
      setAddLineProformaId(null);
      setNewLine({ articleCode: "", productName: "", quantity: "", pricePerBale: "" });
      setCatalogSelectedItem(null);
      setCatalogSearch("");
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const editLineMutation = useMutation({
    mutationFn: async (data: {
      id: number;
      pricePerBale: string;
      productName: string;
      quantity: string;
      weightPerBaleKg: string;
    }) => {
      return await modeApiRequest("PUT", `/api/factory/customer-proforma-lines/${data.id}`, {
        pricePerBale: data.pricePerBale,
        productName: data.productName,
        quantity: data.quantity,
        weightPerBaleKg: data.weightPerBaleKg !== "" ? data.weightPerBaleKg : undefined,
      });
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Line updated" });
      invalidateCustomerProformas();
      queryClient.invalidateQueries({ queryKey: [`/api/factory/customer-price-lists/${customerId}`, customerId] });
      setEditingLine(null);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteLineMutation = useMutation({
    mutationFn: async (id: number) => {
      return await modeApiRequest("DELETE", `/api/factory/customer-proforma-lines/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Line deleted" });
      invalidateCustomerProformas();
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const inlineQtyMutation = useMutation({
    mutationFn: async ({ id, quantity }: { id: number; quantity: number }) => {
      const res = await modeApiRequest("PUT", `/api/factory/customer-proforma-lines/${id}`, { quantity });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
    },
    onSuccess: () => {
      invalidateCustomerProformas();
      setInlineQtyLineId(null);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
      setInlineQtyLineId(null);
    },
  });

  const commitInlineQty = (lineId: number) => {
    const qty = parseInt(inlineQtyValue);
    if (!isNaN(qty) && qty >= 1) {
      inlineQtyMutation.mutate({ id: lineId, quantity: qty });
    } else {
      setInlineQtyLineId(null);
    }
  };

  const formatProformaDate = (createdAt: string | null, updatedAt: string | null): { label: string; value: string } => {
    const created = createdAt ? new Date(createdAt) : null;
    const updated = updatedAt ? new Date(updatedAt) : null;
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    if (updated && created && updated.getTime() - created.getTime() > 60_000) {
      return { label: "Edited", value: fmt(updated) };
    }
    if (created) {
      return { label: "Created", value: fmt(created) };
    }
    return { label: "", value: "" };
  };

  const bulkImportMutation = useMutation({
    mutationFn: async (data: { customerId: number; name: string; isActive: boolean; lines: unknown[] }) => {
      const res = await modeApiRequest("POST", "/api/factory/customer-proformas/bulk", data);
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Proforma created", description: "Excel data imported successfully" });
      invalidateCustomerProformas();
      setIsExcelImportOpen(false);
      setExcelImportName("");
      setExcelImportLines([]);
      setExcelImportErrors([]);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    },
  });

  const downloadProformaTemplate = async () => {
    const wb = excelUtils.book_new();
    const sampleData = [
      { "Article Code": "A001", "Product Name": "Mixed Cotton Bales", Quantity: 50, "Price Per Bale": 45.0 },
      { "Article Code": "A002", "Product Name": "White Cotton Bales", Quantity: 30, "Price Per Bale": 52.5 },
      { "Article Code": "B001", "Product Name": "Polyester Mix Bales", Quantity: 20, "Price Per Bale": 38.0 },
    ];
    const sheet = excelUtils.json_to_sheet(sampleData);
    excelUtils.book_append_sheet(wb, sheet, "Proforma");
    await writeExcel(wb, "proforma_template.xlsx");
  };

  const handleExcelFile = async (file: File) => {
    setExcelImportLoading(true);
    setExcelImportErrors([]);
    setExcelImportLines([]);
    try {
      const workbook = await readExcel(file);
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!firstSheet) {
        setExcelImportErrors(["No sheets found in this file"]);
        return;
      }
      const rows = excelUtils.sheet_to_json(firstSheet);
      if (rows.length === 0) {
        setExcelImportErrors(["The sheet appears to be empty"]);
        return;
      }

      // Smart column detection — case-insensitive, multiple aliases
      const normalize = (s: string) =>
        String(s ?? "")
          .toLowerCase()
          .replace(/[\s_-]/g, "");
      const findCol = (row: Record<string, unknown>, aliases: string[]): string => {
        const keys = Object.keys(row);
        for (const alias of aliases) {
          const found = keys.find((k) => normalize(k) === alias);
          if (found) return String(row[found] ?? "").trim();
        }
        return "";
      };

      const parsed: { articleCode: string; productName: string; quantity: string; pricePerBale: string }[] = [];
      const errors: string[] = [];

      rows.forEach((row, i) => {
        const articleCode = findCol(row, ["articlecode", "code", "article", "artcode", "sku", "ref"]);
        const productName = findCol(row, ["productname", "name", "product", "description", "item", "itemname"]);
        const quantity = findCol(row, ["quantity", "qty", "bales", "count"]);
        const pricePerBale = findCol(row, ["priceperbale", "price", "rate", "unitprice", "saleprice", "sellingprice"]);

        if (!articleCode && !productName) {
          errors.push(`Row ${i + 2}: Missing article code and product name — skipped`);
          return;
        }
        if (!articleCode) {
          errors.push(`Row ${i + 2}: Missing article code — skipped`);
          return;
        }
        if (!productName) {
          errors.push(`Row ${i + 2}: Missing product name — skipped`);
          return;
        }
        const qty = parseInt(quantity);
        if (isNaN(qty) || qty <= 0) {
          errors.push(`Row ${i + 2}: Invalid quantity "${quantity}" — skipped`);
          return;
        }

        parsed.push({ articleCode, productName, quantity: String(qty), pricePerBale: pricePerBale || "0" });
      });

      if (errors.length > 0) setExcelImportErrors(errors);
      if (parsed.length === 0) {
        setExcelImportErrors((prev) => [
          ...prev,
          "No valid rows found. Check that columns are named: Article Code, Product Name, Quantity, Price Per Bale",
        ]);
        return;
      }
      setExcelImportLines(parsed);
      // Suggest a proforma name from the filename
      if (!excelImportName) {
        const base = file.name
          .replace(/\.(xlsx?|csv)$/i, "")
          .replace(/[_-]+/g, " ")
          .trim();
        setExcelImportName(base || "Imported Proforma");
      }
    } catch (err) {
      setExcelImportErrors([`Failed to read file: ${getErrorDetails(err).optionalMessage || "Unknown error"}`]);
    } finally {
      setExcelImportLoading(false);
    }
  };

  const saveAgreedPricesMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      if (!customerId) throw new Error("No customer selected");
      const res = await modeApiRequest(
        "POST",
        `/api/factory/customer-price-lists/${customerId}/from-proforma/${proformaId}`,
        {}
      );
      return res.json();
    },
    onSuccess: (result) => {
      invalidateCustomerProformas();
      const backfillNote =
        result.backfilled > 0
          ? ` Updated ${result.backfilled} line${result.backfilled !== 1 ? "s" : ""} across all existing proformas.`
          : "";
      toast({
        title: "Agreed prices saved",
        description: `${result.saved} price${result.saved !== 1 ? "s" : ""} saved.${backfillNote}`,
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const applyCatalogPricesMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      const res = await modeApiRequest(
        "POST",
        `/api/factory/customer-proformas/${proformaId}/apply-catalog-prices`,
        {}
      );
      return res.json();
    },
    onSuccess: (result) => {
      invalidateCustomerProformas();
      const msg =
        result.skipped > 0
          ? `${result.updated} line(s) updated, ${result.skipped} skipped (no selling price)`
          : `${result.updated} line(s) updated with selling prices`;
      toast({ title: "Selling Prices Applied", description: msg });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const applyProductionPricesMutation = useMutation({
    mutationFn: async (proformaId: number) => {
      const res = await modeApiRequest(
        "POST",
        `/api/factory/customer-proformas/${proformaId}/apply-production-prices`,
        {}
      );
      return res.json();
    },
    onSuccess: (result) => {
      invalidateCustomerProformas();
      const msg =
        result.skipped > 0
          ? `${result.updated} line(s) updated, ${result.skipped} skipped (no production price)`
          : `${result.updated} line(s) updated with production prices`;
      toast({ title: "Production Prices Applied", description: msg });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleCreateProforma = () => {
    if (!newProformaName.trim() || !customerId) return;
    createProformaMutation.mutate({
      customerId,
      name: newProformaName.trim(),
      isActive: false,
    });
  };

  const handleAddLine = () => {
    if (
      !addLineProformaId ||
      !newLine.articleCode.trim() ||
      !newLine.productName.trim() ||
      !newLine.quantity ||
      !newLine.pricePerBale
    )
      return;
    addLineMutation.mutate({
      proformaId: addLineProformaId,
      articleCode: newLine.articleCode.trim(),
      productName: newLine.productName.trim(),
      quantity: parseInt(newLine.quantity),
      pricePerBale: newLine.pricePerBale,
    });
  };

  const handleEditLine = () => {
    if (!editingLine || !editLineValues.pricePerBale || !editLineValues.quantity) return;
    editLineMutation.mutate({
      id: editingLine.id,
      pricePerBale: editLineValues.pricePerBale,
      productName: editLineValues.productName,
      quantity: editLineValues.quantity,
      weightPerBaleKg: editLineValues.weightPerBaleKg,
    });
  };

  return {
    formatAmount,
    navigate,
    selectedCustomerId,
    setSelectedCustomerId,
    expandedProformaIds,
    setExpandedProformaIds,
    isCreateOpen,
    setIsCreateOpen,
    newProformaName,
    setNewProformaName,
    isAddLineOpen,
    setIsAddLineOpen,
    addLineProformaId,
    setAddLineProformaId,
    newLine,
    setNewLine,
    editingLine,
    setEditingLine,
    editLineValues,
    setEditLineValues,
    pendingDelete,
    setPendingDelete,
    inlineQtyLineId,
    setInlineQtyLineId,
    inlineQtyValue,
    setInlineQtyValue,
    renamingProforma,
    setRenamingProforma,
    renameValue,
    setRenameValue,
    addLineMode,
    setAddLineMode,
    catalogSearch,
    setCatalogSearch,
    catalogSelectedItem,
    setCatalogSelectedItem,
    createLoadingProforma,
    setCreateLoadingProforma,
    createLoadingLocationId,
    setCreateLoadingLocationId,
    transferProforma,
    setTransferProforma,
    transferTargetCustomerId,
    setTransferTargetCustomerId,
    showInactive,
    setShowInactive,
    proformaSearch,
    setProformaSearch,
    isExcelImportOpen,
    setIsExcelImportOpen,
    excelImportName,
    setExcelImportName,
    excelImportLines,
    setExcelImportLines,
    excelImportErrors,
    setExcelImportErrors,
    excelImportLoading,
    excelFileInputRef,
    customerId,
    hideProformaPrice,
    canEdit,
    customers,
    customersLoading,
    proformas,
    proformasLoading,
    expandedProformaStateById,
    allStockItems,
    priceListMap,
    locations,
    createLoadingMutation,
    createProformaMutation,
    toggleActiveMutation,
    deleteProformaMutation,
    renameProformaMutation,
    transferProformaMutation,
    addLineMutation,
    editLineMutation,
    deleteLineMutation,
    inlineQtyMutation,
    commitInlineQty,
    formatProformaDate,
    bulkImportMutation,
    downloadProformaTemplate,
    handleExcelFile,
    saveAgreedPricesMutation,
    applyCatalogPricesMutation,
    applyProductionPricesMutation,
    handleCreateProforma,
    handleAddLine,
    handleEditLine,
  };
}
