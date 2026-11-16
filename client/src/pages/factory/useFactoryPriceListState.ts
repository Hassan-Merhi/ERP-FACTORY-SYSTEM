// Extracted from ./FactoryPriceList.tsx to keep that module under the source-size cap.
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import type { ClientErrorLike } from "@/lib/clientError";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { getErrorDetails } from "@shared/errorUtils";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { ExcelJS, readFile } from "@/lib/excelHelper";
import { productMatchesSearch } from "@shared/factoryProductSearch";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

interface FactoryBaleProduct {
  id: number;
  code: string;
  articleCode: string | null;
  name: string;
  nameAr: string | null;
  description: string | null;
  weightPerBaleKg: string | null;
  categoryId: number | null;
  categoryName?: string;
  sellingPrice: string | null;
  productionPrice: string | null;
  active: boolean;
}

interface FactoryCategory {
  id: number;
  name: string;
}

export function useFactoryPriceListState() {
  const mhd = useFactoryMhdView();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  // Prices are edits to existing products; read-only roles see the list and template only.
  const recordChanges = useExistingRecordChangeAccess();

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [showZeroOnly, setShowZeroOnly] = useState(false);
  const [editingCell, setEditingCell] = useState<{
    productId: number;
    field: "sellingPrice" | "productionPrice";
    value: string;
  } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditingCell(null);
  }, [selectedCompany?.id]);

  // Focus only when changing cells, not on every digit typed.
  const editingCellKey = editingCell ? `${editingCell.productId}:${editingCell.field}` : null;
  useEffect(() => {
    if (!editingCellKey) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editingCellKey]);

  const { data: products = [], isLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: companyQueryKey("/api/factory/bale-products", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const { data: categories = [] } = useQuery<FactoryCategory[]>({
    queryKey: companyQueryKey("/api/factory/categories", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const updatePriceMutation = useMutation({
    mutationFn: async ({
      id,
      field,
      value,
    }: {
      id: number;
      field: "sellingPrice" | "productionPrice";
      value: string;
      nextCell?: { productId: number; field: "sellingPrice" | "productionPrice"; value: string };
    }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await modeApiRequest("PATCH", `/api/factory/bale-products/${id}`, { [field]: value });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update price");
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      // Do not interrupt a different cell selected while the request was in flight.
      setEditingCell((current) => {
        if (!current || current.productId !== variables.id || current.field !== variables.field) return current;
        return variables.nextCell ?? null;
      });
      toast({ title: "Price Updated", description: "Price has been saved and will take effect everywhere." });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleStartEdit = (product: FactoryBaleProduct, field: "sellingPrice" | "productionPrice") => {
    if (!recordChanges.allowed) return;
    const currentValue = field === "sellingPrice" ? product.sellingPrice || "0" : product.productionPrice || "0";
    setEditingCell({ productId: product.id, field, value: currentValue });
  };

  const handleSave = (advance = false) => {
    if (!editingCell || updatePriceMutation.isPending) return;
    const val = Number(editingCell.value.trim());
    if (!Number.isFinite(val) || val < 0) {
      toast({ title: "Error", description: "Please enter a valid price.", variant: "destructive" });
      return;
    }

    // Enter follows the editable cells in table order:
    // Sell Price → Prod. Cost → next product's Sell Price.
    // Prod. Cost is hidden on narrow screens, so skip it there.
    let nextCell: { productId: number; field: "sellingPrice" | "productionPrice"; value: string } | undefined;
    if (advance) {
      const index = filteredProducts.findIndex((product) => product.id === editingCell.productId);
      const currentProduct = filteredProducts[index];
      if (editingCell.field === "sellingPrice" && currentProduct && window.innerWidth >= 640) {
        nextCell = {
          productId: currentProduct.id,
          field: "productionPrice",
          value: currentProduct.productionPrice || "0",
        };
      } else if (index >= 0 && index + 1 < filteredProducts.length) {
        const nextProduct = filteredProducts[index + 1];
        nextCell = { productId: nextProduct.id, field: "sellingPrice", value: nextProduct.sellingPrice || "0" };
      }
    }

    updatePriceMutation.mutate({
      id: editingCell.productId,
      field: editingCell.field,
      value: val.toFixed(2),
      nextCell,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditingCell(null);
    }
  };

  const downloadTemplate = async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Price List");

    ws.columns = [
      { header: "ID (do not edit)", key: "id", width: 18 },
      { header: "Article Code", key: "articleCode", width: 18 },
      { header: "Bale Name", key: "name", width: 36 },
      { header: "Selling Price ($/bale)", key: "sellingPrice", width: 24 },
      { header: "Production Cost ($/bale)", key: "productionPrice", width: 26 },
    ];

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FF1F4E79" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBDD7EE" } };
    headerRow.alignment = { vertical: "middle" };
    headerRow.height = 18;

    const activeProducts = products.filter((p) => p.active);
    for (const p of activeProducts) {
      const sp = parseFloat(p.sellingPrice || "0");
      const pp = parseFloat(p.productionPrice || "0");
      const row = ws.addRow({
        id: p.id,
        articleCode: p.articleCode || p.code || "",
        name: p.name,
        sellingPrice: sp > 0 ? sp : "",
        productionPrice: pp > 0 ? pp : "",
      });
      // Gray out read-only columns (ID, Article Code, Bale Name)
      for (let c = 1; c <= 3; c++) {
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
        row.getCell(c).font = { color: { argb: "FF666666" } };
      }
      // Highlight editable price columns
      for (let c = 4; c <= 5; c++) {
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF9E6" } };
      }
    }

    ws.views = [{ state: "frozen", ySplit: 1 }];

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer as ArrayBuffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    downloadBlob(blob, exportFileName("factory price list", "xlsx"));
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !recordChanges.allowed) return;
    e.target.value = "";

    setIsUploading(true);
    try {
      const wb = await readFile(file);
      const ws = wb.worksheets[0];
      if (!ws) throw new Error("No worksheet found in the file");

      const prices: { id: number; sellingPrice?: string; productionPrice?: string }[] = [];

      ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // skip header
        const rawId = row.getCell(1).value;
        const id = parseInt(String(rawId ?? ""));
        if (isNaN(id) || id <= 0) return;

        const rawSell = row.getCell(4).value;
        const rawProd = row.getCell(5).value;

        prices.push({
          id,
          sellingPrice: rawSell !== null && rawSell !== undefined ? String(rawSell) : undefined,
          productionPrice: rawProd !== null && rawProd !== undefined ? String(rawProd) : undefined,
        });
      });

      if (prices.length === 0) throw new Error("No valid rows found — make sure the file matches the template format");

      const res = await modeApiRequest("POST", "/api/factory/bale-products/bulk-update-prices", { prices });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      const result = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      toast({
        title: "Prices Updated",
        description: `${result.updated} product(s) updated${result.skipped > 0 ? `, ${result.skipped} skipped` : ""}.`,
      });
    } catch (err) {
      toast({ title: "Upload Failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const filteredProducts = mhd
    .sortRows(products, (p) => p.articleCode)
    .filter((p) => {
      if (!p.active) return false;
      const matchSearch =
        productMatchesSearch(p, search) ||
        (Boolean(search.trim()) &&
          mhd.nameFor(p.articleCode, p.name).toLowerCase().includes(search.trim().toLowerCase()));
      const matchCategory = categoryFilter === "all" || String(p.categoryId) === categoryFilter;
      // Keep a row visible while Enter moves from its selling price to production cost.
      // Otherwise a "Show unpriced" refresh would unmount the second editable cell.
      const matchZeroOnly = !showZeroOnly || parseFloat(p.sellingPrice || "0") === 0 || editingCell?.productId === p.id;
      return matchSearch && matchCategory && matchZeroOnly;
    });

  const categoryMap = new Map(categories.map((c) => [c.id, c.name]));

  const updatedCount = products.filter((p) => p.active && parseFloat(p.sellingPrice || "0") > 0).length;
  const totalActive = products.filter((p) => p.active).length;
  return {
    categories,
    categoryFilter,
    categoryMap,
    downloadTemplate,
    editingCell,
    fileInputRef,
    filteredProducts,
    handleKeyDown,
    handleSave,
    handleStartEdit,
    handleUpload,
    inputRef,
    isLoading,
    isUploading,
    mhd,
    products,
    recordChanges,
    search,
    setCategoryFilter,
    setEditingCell,
    setSearch,
    setShowZeroOnly,
    showZeroOnly,
    totalActive,
    updatePriceMutation,
    updatedCount,
  };
}
