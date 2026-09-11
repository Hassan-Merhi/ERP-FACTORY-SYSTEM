import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import { productMatchesSearch } from "@shared/factoryProductSearch";
import type { FactoryBaleProduct, FactoryCategory } from "@shared/schema";
import type { Cell as ExcelCell, FillPattern } from "exceljs";
import type { GroupedProduct, ImportPreviewRow } from "./types";
import { hmdLogoPath } from "./utils";

export function useBaleProductsModel() {
  const { colors: designColors } = useLabelDesignColors();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [adminAuthOpen, setAdminAuthOpen] = useState(false);
  const [pendingAdminAuth, setPendingAdminAuth] = useState<{ username: string; password: string } | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreviewRow[]>([]);
  const [importError, setImportError] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [condensedView, _setCondensedView] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [showCategories, setShowCategories] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(new Set());
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategory, setEditingCategory] = useState<{ id: number; name: string } | null>(null);
  const [editingProduct, setEditingProduct] = useState<FactoryBaleProduct | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    articleCode: "",
    weightPerBaleKg: "",
    categoryId: "",
    description: "",
    grade: "",
    productionPrice: "",
    sellingPrice: "",
    labelDesignColor: "",
  });
  const [_isGeneratingCode, setIsGeneratingCode] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [showZeroPrice, setShowZeroPrice] = useState(false);
  const [showNoColor, setShowNoColor] = useState(false);
  const [filterCategoryId, setFilterCategoryId] = useState<number | null>(null);
  const [filterWeight, setFilterWeight] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  useEffect(() => {
    if (editingProduct) {
      setEditForm({
        name: editingProduct.name || "",
        articleCode: editingProduct.articleCode || "",
        weightPerBaleKg: editingProduct.weightPerBaleKg ? String(editingProduct.weightPerBaleKg) : "",
        categoryId: editingProduct.categoryId ? String(editingProduct.categoryId) : "",
        description: editingProduct.description || "",
        grade: "",
        productionPrice:
          editingProduct.productionPrice && parseFloat(editingProduct.productionPrice) > 0
            ? String(parseFloat(editingProduct.productionPrice))
            : "",
        sellingPrice:
          editingProduct.sellingPrice && parseFloat(editingProduct.sellingPrice) > 0
            ? String(parseFloat(editingProduct.sellingPrice))
            : "",
        labelDesignColor: editingProduct.labelDesignColor || "",
      });
    }
  }, [editingProduct]);

  const { data: currentUser } = useQuery<any>({ queryKey: ["/api/auth/me"] });
  const isAdmin = ["Admin", "Owner", "Developer"].includes(currentUser?.role || "");

  const { data: myAccess } = useQuery<{ hiddenCostFields: string[] }>({
    queryKey: ["/api/factory/my-access"],
  });
  const { data: factorySettingsData } = useQuery<{ hideAvgCost?: boolean; hideSellingPrice?: boolean }>({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const res = await fetch("/api/factory/settings", { credentials: "include" });
      return res.ok ? res.json() : {};
    },
  });
  const perUserHiddenBP = myAccess?.hiddenCostFields ?? [];
  const hideAvgRate =
    perUserHiddenBP.includes("inventory_avg_rate") ||
    perUserHiddenBP.includes("inventory_total_value") ||
    !!factorySettingsData?.hideAvgCost ||
    perUserHiddenBP.includes("hide_export_cost_price");
  const hideSellingPriceBP =
    !!factorySettingsData?.hideSellingPrice ||
    perUserHiddenBP.includes("inventory_sell_price") ||
    perUserHiddenBP.includes("inventory_sell_value") ||
    perUserHiddenBP.includes("hide_export_selling_price");

  const { data: products, isLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: ["/api/factory/bale-products"],
  });

  const { data: categories } = useQuery<FactoryCategory[]>({
    queryKey: ["/api/factory/categories"],
  });

  const categoryMap = new Map<number, string>();
  categories?.forEach((c) => categoryMap.set(c.id, c.name));

  const allActiveProducts = products?.filter((p) => p.active !== false);
  const noColorCount = allActiveProducts?.filter((p) => !p.labelDesignColor).length ?? 0;
  const distinctWeights = Array.from(
    new Set((allActiveProducts ?? []).map((p) => p.weightPerBaleKg).filter(Boolean) as string[])
  ).sort((a, b) => parseFloat(a) - parseFloat(b));
  const activeProducts = allActiveProducts
    ?.filter((p) => !showZeroPrice || parseFloat(p.sellingPrice || "0") === 0)
    ?.filter((p) => !showNoColor || !p.labelDesignColor)
    ?.filter((p) => filterCategoryId === null || p.categoryId === filterCategoryId)
    ?.filter((p) => filterWeight === null || String(p.weightPerBaleKg) === filterWeight)
    ?.filter((p) => productMatchesSearch(p, searchQuery));
  const hiddenProducts = products?.filter((p) => p.active === false);

  const toggleSelectId = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (list: FactoryBaleProduct[]) => {
    const ids = list.map((p) => p.id);
    const allSelected = ids.every((id) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.add(id));
        return next;
      });
    }
  };

  const selectedActiveIds = Array.from(selectedIds).filter((id) => activeProducts?.some((p) => p.id === id));
  const selectedHiddenIds = Array.from(selectedIds).filter((id) => hiddenProducts?.some((p) => p.id === id));

  const createCategoryMutation = useMutation({
    mutationFn: async (name: string) => {
      const response = await modeApiRequest("POST", "/api/factory/categories", { name });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/categories"] });
      setNewCategoryName("");
      toast({ title: "Category created" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateCategoryMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const response = await modeApiRequest("PATCH", `/api/factory/categories/${id}`, { name });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/categories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      setEditingCategory(null);
      toast({ title: "Category updated" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await modeApiRequest("DELETE", `/api/factory/categories/${id}`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/categories"] });
      toast({ title: "Category deleted" });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/factory/bale-products/import-excel", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Import failed");
      }
      return response.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/categories"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory"], exact: false });

      const cols = result.detectedColumns || {};
      const detectedInfo = [
        cols.articleCode ? `Article Code: "${cols.articleCode}"` : null,
        cols.productionPrice ? `Cost Price: "${cols.productionPrice}"` : null,
        cols.sellingPrice ? `Sell Price: "${cols.sellingPrice}"` : null,
      ]
        .filter(Boolean)
        .join(", ");

      const noPriceColsFound = !cols.productionPrice && !cols.sellingPrice;
      const allSkipped = result.skippedNoArticleCode > 0 && result.created + result.updated === 0;

      if (allSkipped || !cols.articleCode) {
        toast({
          title: "Import Warning",
          description: `No products were matched — article code column not found. Your file must have a column named "Article Code". Columns seen: ${
            Object.keys(result.detectedColumns || {})
              .filter((k) => result.detectedColumns[k])
              .map((k: string) => `"${result.detectedColumns[k]}"`)
              .join(", ") || "none detected"
          }`,
          variant: "destructive",
        });
      } else if (noPriceColsFound) {
        toast({
          title: "Import Complete — No Prices Updated",
          description: `${result.updated || 0} updated, ${result.created || 0} created. Column detected: ${detectedInfo}. No price columns found — add "Production Price" and/or "Selling Price" columns to your file.`,
          variant: "destructive",
        });
      } else {
        const parts = [];
        if (result.created) parts.push(`${result.created} created`);
        if (result.updated) parts.push(`${result.updated} updated`);
        if (result.pricesUpdated) parts.push(`${result.pricesUpdated} with prices`);
        if (result.categoriesCreated) parts.push(`${result.categoriesCreated} categories auto-created`);
        toast({
          title: "Import Complete",
          description:
            (parts.join(", ") || "0 products processed") + (detectedInfo ? ` | Columns: ${detectedInfo}` : ""),
        });
      }

      setImportDialogOpen(false);
      setImportPreview([]);
      setImportFile(null);
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Import Error", description: error.message, variant: "destructive" });
    },
  });

  const editProductMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      weightPerBaleKg: number | null;
      articleCode: string;
      description: string;
      categoryId: number | null;
      labelDesignColor: string | null;
      productionPrice: string;
      sellingPrice: string;
    }) => {
      const response = await modeApiRequest(
        "POST",
        `/api/factory/bale-products/${editingProduct!.id}/cascade-update`,
        data
      );
      return response.json();
    },
    onSuccess: (result: { product: FactoryBaleProduct; balesUpdated: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/location-inventory"], exact: false });
      setEditingProduct(null);
      toast({
        title: "Product updated",
        description: `${result.balesUpdated} bale(s) also updated`,
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const colorUpdateMutation = useMutation({
    mutationFn: async ({ id, labelDesignColor }: { id: number; labelDesignColor: string | null }) => {
      const response = await modeApiRequest("POST", `/api/factory/bale-products/${id}/cascade-update`, {
        labelDesignColor,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteProductMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await modeApiRequest("DELETE", `/api/factory/bale-products/${id}`);
      if (!response.ok) throw new Error("Failed to delete product");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      setEditingProduct(null);
      toast({ title: "Product deleted", description: "The product has been removed." });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const bulkToggleActiveMutation = useMutation({
    mutationFn: async ({ ids, active }: { ids: number[]; active: boolean }) => {
      const response = await modeApiRequest("POST", "/api/factory/bale-products/bulk-toggle-active", { ids, active });
      if (!response.ok) throw new Error("Failed to update products");
      return response.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      setSelectedIds(new Set());
      toast({
        title: variables.active ? "Products unhidden" : "Products hidden",
        description: `${variables.ids.length} product(s) updated.`,
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const _handleGradeChange = async (grade: string) => {
    setEditForm((f) => ({ ...f, grade }));
    if (!grade) return;
    setIsGeneratingCode(true);
    try {
      const response = await modeApiRequest(
        "GET",
        `/api/factory/bale-products/generate-code?grade=${encodeURIComponent(grade)}`
      );
      const data = await response.json();
      if (data.articleCode) setEditForm((f) => ({ ...f, articleCode: data.articleCode }));
    } catch {
      toast({ title: "Error", description: "Could not generate article code", variant: "destructive" });
    } finally {
      setIsGeneratingCode(false);
    }
  };

  const handleEditSubmit = () => {
    if (!editForm.name.trim()) return;
    editProductMutation.mutate({
      name: editForm.name.trim(),
      articleCode: editForm.articleCode.trim(),
      weightPerBaleKg: editForm.weightPerBaleKg ? parseFloat(editForm.weightPerBaleKg) : null,
      categoryId: editForm.categoryId ? parseInt(editForm.categoryId) : null,
      description: editForm.description.trim(),
      productionPrice: editForm.productionPrice,
      sellingPrice: editForm.sellingPrice,
      labelDesignColor: editForm.labelDesignColor || null,
    });
  };

  const handleExportExcel = async (priceType: "selling" | "production") => {
    if (priceType === "selling" && hideSellingPriceBP) {
      toast({ title: "Selling price is hidden for your account", variant: "destructive" });
      return;
    }
    if (priceType === "production" && hideAvgRate) {
      toast({ title: "Production price is hidden for your account", variant: "destructive" });
      return;
    }
    if (!activeProducts || activeProducts.length === 0) {
      toast({ title: "No products to export", variant: "destructive" });
      return;
    }
    try {
      const ExcelJSModule = await import("exceljs");
      const ExcelJS = ExcelJSModule.default ?? ExcelJSModule;

      const priceHeader = priceType === "selling" ? "Selling Price" : "Production Price";
      const today = new Date().toISOString().slice(0, 10);
      const fileName = priceType === "selling" ? "HMD_Order_Selling_Price.xlsx" : "HMD_Order_Production_Price.xlsx";

      const C_NAVY = "FF00205B";
      const C_BLUE = "FF1F3A6B";
      const C_ACCENT = "FF2E75B6";
      const C_ALT_ROW = "FFDCE6F1";
      const C_WHITE = "FFFFFFFF";
      const C_BORDER = "FFBFBFBF";
      const C_MUTED = "FF888888";
      const C_ZERO = "FFBBBBBB";
      const C_TOTAL = "FFE8F0F8";
      const C_TOTAL_LABEL = "FF00205B";

      const wb = new ExcelJS.Workbook();
      wb.creator = "HMD International Group";
      const ws = wb.addWorksheet("Make Your Order");

      ws.columns = [
        { key: "num", width: 6 },
        { key: "article", width: 18, hidden: true },
        { key: "name", width: 42 },
        { key: "category", width: 22 },
        { key: "weight", width: 14 },
        { key: "price", width: 16 },
        { key: "bales", width: 12 },
        { key: "total", width: 18 },
      ];

      try {
        const logoRes = await fetch(hmdLogoPath);
        const logoBuffer = await logoRes.arrayBuffer();
        const imageId = wb.addImage({ buffer: logoBuffer, extension: "png" });
        ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 180, height: 72 } });
      } catch {
        /* logo fetch failed — skip */
      }

      const addHeaderRow = (text: string, height: number, font: any) => {
        const r = ws.addRow(["", "", text, "", "", "", "", ""]);
        r.height = height;
        const cell = r.getCell(3);
        cell.font = font;
        cell.alignment = { vertical: "middle", horizontal: "left" };
        ws.mergeCells(`C${r.number}:H${r.number}`);
        return r;
      };

      addHeaderRow("HMD International Group", 24, { bold: true, size: 16, color: { argb: C_NAVY } });
      addHeaderRow(`Make Your Order – ${priceHeader}`, 20, { bold: true, size: 12, color: { argb: C_ACCENT } });
      addHeaderRow(`Enter quantities in the "Bales" column`, 16, { size: 10, color: { argb: C_MUTED } });
      addHeaderRow(`Generated: ${today}`, 16, { size: 10, color: { argb: C_MUTED } });

      const spacer = ws.addRow(["", "", "", "", "", "", "", ""]);
      spacer.height = 6;
      ws.mergeCells(`A${spacer.number}:H${spacer.number}`);
      spacer.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_NAVY } };

      // ── Table header row 6 ───────────────────────────────────────────
      const hdrRow = ws.addRow([
        "#",
        "Article Code",
        "Name of Item",
        "Category",
        "Weight (kg)",
        priceHeader,
        "Bales",
        "Total",
      ]);
      hdrRow.height = 22;
      hdrRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_BLUE } };
        cell.font = { bold: true, color: { argb: C_WHITE }, size: 11 };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = {
          top: { style: "thin", color: { argb: C_BLUE } },
          bottom: { style: "medium", color: { argb: C_NAVY } },
          left: { style: "thin", color: { argb: C_BLUE } },
          right: { style: "thin", color: { argb: C_BLUE } },
        };
      });

      // ── Data rows (start at row 7) ───────────────────────────────────
      const DATA_START = 7;
      activeProducts.forEach((p, i) => {
        const rawPrice = priceType === "selling" ? p.sellingPrice : p.productionPrice;
        const numPrice = rawPrice ? parseFloat(rawPrice) : 0;
        const categoryName = p.categoryId ? categoryMap.get(p.categoryId) || "" : "";
        const weight = p.weightPerBaleKg != null ? parseFloat(String(p.weightPerBaleKg)) : "";
        const rowNum = DATA_START + i;

        const row = ws.addRow([
          `#${i + 1}`,
          p.articleCode || "",
          p.name || "",
          categoryName,
          weight,
          numPrice,
          "", // Bales — blank for user input
          { formula: `=F${rowNum}*G${rowNum}`, result: 0 }, // Total = Price × Bales
        ]);
        row.height = 18;

        const isAlt = i % 2 === 1;
        const rowFill: FillPattern | undefined = isAlt
          ? { type: "pattern", pattern: "solid", fgColor: { argb: C_ALT_ROW } }
          : undefined;

        row.eachCell((cell: ExcelCell, colNum: number) => {
          if (rowFill) cell.fill = rowFill;
          cell.font = { size: 10 };
          cell.border = { bottom: { style: "hair", color: { argb: C_BORDER } } };
          if (colNum === 1) cell.alignment = { horizontal: "center" };
          if (colNum === 5 || colNum === 6) cell.alignment = { horizontal: "right" };
          if (colNum === 7) cell.alignment = { horizontal: "center" };
          if (colNum === 8) cell.alignment = { horizontal: "right" };
        });

        const priceCell = row.getCell(6);
        priceCell.numFmt = "#,##0.00";
        if (numPrice === 0) priceCell.font = { size: 10, color: { argb: C_ZERO } };
        if (weight !== "") row.getCell(5).numFmt = "#,##0.##";

        // Total column format
        row.getCell(8).numFmt = "#,##0.00";
      });

      // ── Total row ────────────────────────────────────────────────────
      const lastDataRow = DATA_START + activeProducts.length - 1;
      const totalRow = ws.addRow([
        "",
        "",
        "TOTAL ORDER",
        "",
        "",
        "",
        { formula: `=SUM(G${DATA_START}:G${lastDataRow})`, result: 0 },
        { formula: `=SUM(H${DATA_START}:H${lastDataRow})`, result: 0 },
      ]);
      totalRow.height = 22;
      const totalFill: FillPattern = { type: "pattern", pattern: "solid", fgColor: { argb: C_TOTAL } };
      totalRow.eachCell((cell: ExcelCell, _colNum: number) => {
        cell.fill = totalFill;
        cell.border = {
          top: { style: "medium", color: { argb: C_NAVY } },
          bottom: { style: "medium", color: { argb: C_NAVY } },
        };
      });
      const labelCell = totalRow.getCell(3);
      labelCell.font = { bold: true, size: 11, color: { argb: C_TOTAL_LABEL } };
      labelCell.alignment = { horizontal: "left", vertical: "middle" };
      ws.mergeCells(`C${totalRow.number}:F${totalRow.number}`);

      const balesTotal = totalRow.getCell(7);
      balesTotal.font = { bold: true, size: 12, color: { argb: C_NAVY } };
      balesTotal.numFmt = "#,##0";
      balesTotal.alignment = { horizontal: "center", vertical: "middle" };

      const grandTotal = totalRow.getCell(8);
      grandTotal.font = { bold: true, size: 12, color: { argb: C_NAVY } };
      grandTotal.numFmt = "#,##0.00";
      grandTotal.alignment = { horizontal: "right", vertical: "middle" };

      // ── Freeze & auto-filter ─────────────────────────────────────────
      ws.views = [{ state: "frozen", xSplit: 0, ySplit: 6 }];
      ws.autoFilter = { from: "A6", to: `H${lastDataRow}` };

      // ── Download ─────────────────────────────────────────────────────
      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);

      toast({ title: `Order sheet downloaded — ${priceHeader}` });
    } catch (err) {
      console.error("Export failed", err);
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  const handleExportNoPrices = async () => {
    if (!activeProducts || activeProducts.length === 0) {
      toast({ title: "No products to export", variant: "destructive" });
      return;
    }
    try {
      const ExcelJSModule = await import("exceljs");
      const ExcelJS = ExcelJSModule.default ?? ExcelJSModule;

      const today = new Date().toISOString().slice(0, 10);

      const C_NAVY = "FF00205B";
      const C_BLUE = "FF1F3A6B";
      const C_ACCENT = "FF2E75B6";
      const C_ALT_ROW = "FFDCE6F1";
      const C_WHITE = "FFFFFFFF";
      const C_BORDER = "FFBFBFBF";
      const C_MUTED = "FF888888";
      const C_TOTAL = "FFE8F0F8";

      const wb = new ExcelJS.Workbook();
      wb.creator = "HMD International Group";
      const ws = wb.addWorksheet("Make Your Order");

      // A=#, B=Article(hidden), C=Name, D=Category, E=Weight, F=Bales
      ws.columns = [
        { key: "num", width: 6 },
        { key: "article", width: 18, hidden: true },
        { key: "name", width: 48 },
        { key: "category", width: 22 },
        { key: "weight", width: 14 },
        { key: "bales", width: 14 },
      ];

      // ── Logo ─────────────────────────────────────────────────────────
      try {
        const logoRes = await fetch(hmdLogoPath);
        const logoBuffer = await logoRes.arrayBuffer();
        const imageId = wb.addImage({ buffer: logoBuffer, extension: "png" });
        ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 180, height: 72 } });
      } catch {
        /* logo fetch failed — skip */
      }

      const addHeaderRow = (text: string, height: number, font: any) => {
        const r = ws.addRow(["", "", text, "", "", ""]);
        r.height = height;
        const cell = r.getCell(3);
        cell.font = font;
        cell.alignment = { vertical: "middle", horizontal: "left" };
        ws.mergeCells(`C${r.number}:F${r.number}`);
        return r;
      };

      addHeaderRow("HMD International Group", 24, { bold: true, size: 16, color: { argb: C_NAVY } });
      addHeaderRow("Make Your Order", 20, { bold: true, size: 12, color: { argb: C_ACCENT } });
      addHeaderRow(`Enter quantities in the "Bales" column`, 16, { size: 10, color: { argb: C_MUTED } });
      addHeaderRow(`Generated: ${today}`, 16, { size: 10, color: { argb: C_MUTED } });

      const spacer = ws.addRow(["", "", "", "", "", ""]);
      spacer.height = 6;
      ws.mergeCells(`A${spacer.number}:F${spacer.number}`);
      spacer.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_NAVY } };

      const hdrRow = ws.addRow(["#", "Article Code", "Name of Item", "Category", "Weight (kg)", "Bales"]);
      hdrRow.height = 22;
      hdrRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_BLUE } };
        cell.font = { bold: true, color: { argb: C_WHITE }, size: 11 };
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = {
          top: { style: "thin", color: { argb: C_BLUE } },
          bottom: { style: "medium", color: { argb: C_NAVY } },
          left: { style: "thin", color: { argb: C_BLUE } },
          right: { style: "thin", color: { argb: C_BLUE } },
        };
      });

      const DATA_START = 7;
      activeProducts.forEach((p, i) => {
        const categoryName = p.categoryId ? categoryMap.get(p.categoryId) || "" : "";
        const weight = p.weightPerBaleKg != null ? parseFloat(String(p.weightPerBaleKg)) : "";

        const row = ws.addRow([
          `#${i + 1}`,
          p.articleCode || "",
          p.name || "",
          categoryName,
          weight,
          "", // Bales — blank for user input
        ]);
        row.height = 18;

        const isAlt = i % 2 === 1;
        const rowFill: FillPattern | undefined = isAlt
          ? { type: "pattern", pattern: "solid", fgColor: { argb: C_ALT_ROW } }
          : undefined;

        row.eachCell((cell: ExcelCell, colNum: number) => {
          if (rowFill) cell.fill = rowFill;
          cell.font = { size: 10 };
          cell.border = { bottom: { style: "hair", color: { argb: C_BORDER } } };
          if (colNum === 1) cell.alignment = { horizontal: "center" };
          if (colNum === 5) cell.alignment = { horizontal: "right" };
          if (colNum === 6) cell.alignment = { horizontal: "center" };
        });
        if (weight !== "") row.getCell(5).numFmt = "#,##0.##";
      });

      // ── Total row ────────────────────────────────────────────────────
      const lastDataRow = DATA_START + activeProducts.length - 1;
      const totalRow = ws.addRow([
        "",
        "",
        "TOTAL ORDER",
        "",
        "",
        { formula: `=SUM(F${DATA_START}:F${lastDataRow})`, result: 0 },
      ]);
      totalRow.height = 22;
      const totalFill: FillPattern = { type: "pattern", pattern: "solid", fgColor: { argb: C_TOTAL } };
      totalRow.eachCell((cell: ExcelCell) => {
        cell.fill = totalFill;
        cell.border = {
          top: { style: "medium", color: { argb: C_NAVY } },
          bottom: { style: "medium", color: { argb: C_NAVY } },
        };
      });
      ws.mergeCells(`C${totalRow.number}:E${totalRow.number}`);
      const labelCell = totalRow.getCell(3);
      labelCell.font = { bold: true, size: 11, color: { argb: C_NAVY } };
      labelCell.alignment = { horizontal: "left", vertical: "middle" };

      const balesTotal = totalRow.getCell(6);
      balesTotal.font = { bold: true, size: 12, color: { argb: C_NAVY } };
      balesTotal.numFmt = "#,##0";
      balesTotal.alignment = { horizontal: "center", vertical: "middle" };

      ws.views = [{ state: "frozen", xSplit: 0, ySplit: 6 }];
      ws.autoFilter = { from: "A6", to: `F${lastDataRow}` };

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "HMD_Order_No_Prices.xlsx";
      a.click();
      URL.revokeObjectURL(url);

      toast({ title: "Order sheet (no prices) downloaded" });
    } catch (err) {
      console.error("Export failed", err);
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  const handleDownloadTemplate = async () => {
    try {
      const XLSX = await import("@/lib/excelHelper");
      const templateData = [
        {
          "Article Code": "HMD01000",
          Name: "Sample Product 1",
          Category: "Category A",
          "Weight Per Bale": "45",
          "Production Price": "100.00",
          "Selling Price": "120.00",
        },
        {
          "Article Code": "HMD02000",
          Name: "Sample Product 2",
          Category: "Category B",
          "Weight Per Bale": "50",
          "Production Price": "80.00",
          "Selling Price": "100.00",
        },
      ];
      const ws = XLSX.utils.json_to_sheet(templateData);
      ws["!cols"] = [{ wch: 15 }, { wch: 25 }, { wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 18 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Bale Products");
      await XLSX.writeFile(wb, "bale_products_template.xlsx");
      toast({ title: "Template downloaded" });
    } catch (_err) {
      toast({ title: "Error", description: "Failed to generate template", variant: "destructive" });
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError("");
    setImportPreview([]);
    setImportFile(file);

    try {
      const XLSX = await import("@/lib/excelHelper");
      const buffer = await file.arrayBuffer();
      const workbook = await XLSX.read(buffer, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet);

      if (rows.length === 0) {
        setImportError("Excel file is empty");
        setImportFile(null);
        return;
      }

      const preview: ImportPreviewRow[] = rows.map((row) => {
        const itemNumber = row.itemNumber || row.item_number || row.ItemNumber;
        let articleCode = (row["Article Code"] || row.articleCode || row.article_code || row.ArticleCode || "")
          .toString()
          .trim();
        if (!articleCode && itemNumber) {
          const num = parseInt(String(itemNumber));
          if (!isNaN(num) && num >= 1 && num <= 99) {
            articleCode = `HMD${String(num).padStart(2, "0")}000`;
          }
        }
        const rawProdPrice =
          row["Production Price"] ??
          row["production price"] ??
          row.productionPrice ??
          row.production_price ??
          row["Cost Price"] ??
          row.costPrice ??
          null;
        const rawSellPrice =
          row["Selling Price"] ?? row["selling price"] ?? row.sellingPrice ?? row.selling_price ?? null;
        return {
          articleCode: articleCode || "",
          name: (row["Name"] || row.name || row.Name || row["Product Name"] || row.product_name || "")
            .toString()
            .trim(),
          category: (row.category || row.Category || row.category_name || "").toString().trim(),
          description: (row.description || row.Description || "").toString().trim(),
          weightPerBaleKg:
            (row["Weight Per Bale"] || row.weightPerBaleKg || row.weight_per_bale_kg || row.weight || "").toString() ||
            undefined,
          productionPrice:
            rawProdPrice !== null && rawProdPrice !== "" ? parseFloat(String(rawProdPrice)) || undefined : undefined,
          sellingPrice:
            rawSellPrice !== null && rawSellPrice !== "" ? parseFloat(String(rawSellPrice)) || undefined : undefined,
          active: row.active === undefined ? true : Boolean(row.active),
        };
      });

      const missing = preview.filter((r) => !r.articleCode || !r.name);
      if (missing.length > 0) {
        setImportError(`${missing.length} row(s) missing required Article Code or Name`);
      }

      setImportPreview(preview.filter((r) => r.articleCode && r.name));
      setImportDialogOpen(true);
    } catch (err) {
      setImportError(getErrorDetails(err).message || "Failed to parse Excel file");
      setImportFile(null);
      toast({ title: "Parse Error", description: getErrorDetails(err).message, variant: "destructive" });
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleConfirmImport = () => {
    if (!importFile) {
      toast({ title: "No file", description: "Please select a file first", variant: "destructive" });
      return;
    }
    importMutation.mutate(importFile);
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const groupedProducts: (GroupedProduct & { _key: string })[] = (() => {
    if (!activeProducts) return [];
    const groups: Record<string, GroupedProduct & { _key: string }> = {};
    for (const p of activeProducts) {
      const key = p.articleCode || p.code;
      if (!groups[key]) {
        groups[key] = { _key: key, articleCode: p.articleCode || "", name: p.name, count: 0, items: [] };
      }
      groups[key].count++;
      groups[key].items.push(p);
    }
    return Object.values(groups).sort((a, b) => (a.items[0]?.id ?? 0) - (b.items[0]?.id ?? 0));
  })();

  // prettier-ignore
  return { designColors, createDialogOpen, setCreateDialogOpen, adminAuthOpen, setAdminAuthOpen, pendingAdminAuth, setPendingAdminAuth, importDialogOpen, setImportDialogOpen, importPreview, setImportPreview, importError, setImportFile, condensedView, expandedGroups, showCategories, setShowCategories, expandedCategories, setExpandedCategories, newCategoryName, setNewCategoryName, editingCategory, setEditingCategory, editingProduct, setEditingProduct, editForm, setEditForm, pendingDelete, setPendingDelete, selectedIds, setSelectedIds, showHidden, setShowHidden, showZeroPrice, setShowZeroPrice, showNoColor, setShowNoColor, filterCategoryId, setFilterCategoryId, filterWeight, setFilterWeight, searchQuery, setSearchQuery, fileInputRef, isAdmin, hideAvgRate, hideSellingPriceBP, products, isLoading, categories, categoryMap, noColorCount, distinctWeights, activeProducts, hiddenProducts, toggleSelectId, toggleSelectAll, selectedActiveIds, selectedHiddenIds, createCategoryMutation, updateCategoryMutation, deleteCategoryMutation, importMutation, editProductMutation, colorUpdateMutation, deleteProductMutation, bulkToggleActiveMutation, handleEditSubmit, handleExportExcel, handleExportNoPrices, handleDownloadTemplate, handleFileSelect, handleConfirmImport, toggleGroup, groupedProducts } as const;
}
