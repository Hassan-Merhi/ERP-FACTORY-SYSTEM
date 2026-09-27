import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Check, X, Pencil, Search, Tag, RefreshCw, AlertCircle, Download, Upload } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExcelJS, readFile } from "@/lib/excelHelper";
import { productMatchesSearch } from "@shared/factoryProductSearch";

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

export default function FactoryPriceList() {
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

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

  const { data: products = [], isLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: ["/api/factory/bale-products"],
  });

  const { data: categories = [] } = useQuery<FactoryCategory[]>({
    queryKey: ["/api/factory/categories"],
  });

  const updatePriceMutation = useMutation({
    mutationFn: async ({ id, field, value }: { id: number; field: string; value: string }) => {
      const res = await modeApiRequest("PATCH", `/api/factory/bale-products/${id}`, { [field]: value });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update price");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      setEditingCell(null);
      toast({ title: "Price Updated", description: "Price has been saved and will take effect everywhere." });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleStartEdit = (product: FactoryBaleProduct, field: "sellingPrice" | "productionPrice") => {
    const currentValue = field === "sellingPrice" ? product.sellingPrice || "0" : product.productionPrice || "0";
    setEditingCell({ productId: product.id, field, value: currentValue });
    setTimeout(() => inputRef.current?.select(), 30);
  };

  const handleSave = () => {
    if (!editingCell) return;
    const val = parseFloat(editingCell.value);
    if (isNaN(val) || val < 0) {
      toast({ title: "Error", description: "Please enter a valid price.", variant: "destructive" });
      return;
    }
    updatePriceMutation.mutate({
      id: editingCell.productId,
      field: editingCell.field === "sellingPrice" ? "sellingPrice" : "productionPrice",
      value: val.toFixed(2),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") setEditingCell(null);
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `factory_price_list_${new Date().toLocaleDateString("en-CA")}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
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

  const filteredProducts = products.filter((p) => {
    if (!p.active) return false;
    const matchSearch = productMatchesSearch(p, search);
    const matchCategory = categoryFilter === "all" || String(p.categoryId) === categoryFilter;
    const matchZeroOnly = !showZeroOnly || parseFloat(p.sellingPrice || "0") === 0;
    return matchSearch && matchCategory && matchZeroOnly;
  });

  const categoryMap = new Map(categories.map((c) => [c.id, c.name]));

  const updatedCount = products.filter((p) => p.active && parseFloat(p.sellingPrice || "0") > 0).length;
  const totalActive = products.filter((p) => p.active).length;

  return (
    <div className="flex flex-col h-full p-3 sm:p-6 space-y-4 sm:space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={handleUpload}
        data-testid="input-price-upload-file"
      />

      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 flex-wrap">
        <div>
          <PageHeader title="Factory Price List" subtitle="Set selling prices for bale products." />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary" data-testid="text-price-coverage">
            {updatedCount} / {totalActive} priced
          </Badge>
          <Button
            variant="outline"
            onClick={downloadTemplate}
            disabled={isLoading || products.length === 0}
            className="gap-2"
            data-testid="button-download-price-template"
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Download Template</span>
            <span className="sm:hidden">Template</span>
          </Button>
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="gap-2"
            data-testid="button-upload-price-excel"
          >
            {isUploading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            <span className="hidden sm:inline">{isUploading ? "Uploading…" : "Upload Prices"}</span>
            <span className="sm:hidden">{isUploading ? "…" : "Upload"}</span>
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
            data-testid="input-search"
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[150px] sm:w-[180px]" data-testid="select-category-filter">
            <SelectValue placeholder="All Categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={showZeroOnly ? "default" : "outline"}
          onClick={() => setShowZeroOnly((v) => !v)}
          className="gap-2 whitespace-nowrap"
          data-testid="button-show-zero-price-only"
        >
          <AlertCircle className="h-4 w-4" />
          <span className="hidden sm:inline">{showZeroOnly ? "Showing unpriced" : "Show unpriced"}</span>
          <span className="sm:hidden">Unpriced</span>
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Tag className="h-4 w-4" />
            Product Prices
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredProducts.length > 0 ? (
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead className="hidden sm:table-cell">Article Code</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="hidden sm:table-cell">Category</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">Kg / Bale</TableHead>
                  <TableHead className="text-right">Sell Price</TableHead>
                  <TableHead className="text-right hidden sm:table-cell">Prod. Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredProducts.map((product) => {
                  const sellingIsEditing =
                    editingCell?.productId === product.id && editingCell.field === "sellingPrice";
                  const productionIsEditing =
                    editingCell?.productId === product.id && editingCell.field === "productionPrice";
                  const sellingPrice = parseFloat(product.sellingPrice || "0");
                  const productionPrice = parseFloat(product.productionPrice || "0");

                  return (
                    <TableRow key={product.id} data-testid={`row-product-${product.id}`}>
                      <TableCell
                        className="font-mono text-sm hidden sm:table-cell"
                        data-testid={`text-article-code-${product.id}`}
                      >
                        {product.articleCode || product.code || "—"}
                      </TableCell>
                      <TableCell className="font-medium" data-testid={`text-product-name-${product.id}`}>
                        <div>{product.name}</div>
                        {/* Mobile-only: show article code + category inline */}
                        <div className="sm:hidden flex flex-wrap items-center gap-1.5 mt-0.5">
                          {(product.articleCode || product.code) && (
                            <span className="font-mono text-xs text-muted-foreground">
                              {product.articleCode || product.code}
                            </span>
                          )}
                          {product.categoryId && (
                            <Badge variant="outline" className="text-xs">
                              {categoryMap.get(product.categoryId) || "—"}
                            </Badge>
                          )}
                          {product.weightPerBaleKg && (
                            <span className="text-xs text-muted-foreground">
                              {parseFloat(product.weightPerBaleKg).toFixed(1)} kg/bale
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {product.categoryId ? (
                          <Badge variant="outline">{categoryMap.get(product.categoryId) || "—"}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground hidden sm:table-cell">
                        {product.weightPerBaleKg ? `${parseFloat(product.weightPerBaleKg).toFixed(1)} kg` : "—"}
                      </TableCell>

                      {/* Selling Price Cell */}
                      <TableCell className="text-right">
                        {sellingIsEditing ? (
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              ref={inputRef}
                              type="number"
                              min="0"
                              step="0.01"
                              value={editingCell.value}
                              onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                              onKeyDown={handleKeyDown}
                              className="w-24 text-right font-mono"
                              data-testid={`input-selling-price-${product.id}`}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={handleSave}
                              disabled={updatePriceMutation.isPending}
                              data-testid={`button-save-selling-${product.id}`}
                            >
                              {updatePriceMutation.isPending ? (
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Check className="h-3.5 w-3.5 text-green-600" />
                              )}
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setEditingCell(null)}
                              data-testid={`button-cancel-selling-${product.id}`}
                            >
                              <X className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        ) : (
                          <div
                            className="flex items-center justify-end gap-2 group cursor-pointer hover-elevate rounded-md px-2 py-1"
                            onClick={() => handleStartEdit(product, "sellingPrice")}
                            data-testid={`cell-selling-price-${product.id}`}
                          >
                            <span
                              className={`font-mono font-medium ${sellingPrice > 0 ? "" : "text-muted-foreground"}`}
                            >
                              {sellingPrice > 0 ? `$${sellingPrice.toFixed(2)}` : "—"}
                            </span>
                            <Pencil className="h-3 w-3 text-muted-foreground opacity-60 md:opacity-0 md:group-hover:opacity-100" />
                          </div>
                        )}
                      </TableCell>

                      {/* Production Cost Cell — hidden on mobile, tap sell price row to edit */}
                      <TableCell className="text-right hidden sm:table-cell">
                        {productionIsEditing ? (
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              ref={inputRef}
                              type="number"
                              min="0"
                              step="0.01"
                              value={editingCell.value}
                              onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                              onKeyDown={handleKeyDown}
                              className="w-24 text-right font-mono"
                              data-testid={`input-production-price-${product.id}`}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={handleSave}
                              disabled={updatePriceMutation.isPending}
                              data-testid={`button-save-production-${product.id}`}
                            >
                              {updatePriceMutation.isPending ? (
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Check className="h-3.5 w-3.5 text-green-600" />
                              )}
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setEditingCell(null)}
                              data-testid={`button-cancel-production-${product.id}`}
                            >
                              <X className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        ) : (
                          <div
                            className="flex items-center justify-end gap-2 group cursor-pointer hover-elevate rounded-md px-2 py-1"
                            onClick={() => handleStartEdit(product, "productionPrice")}
                            data-testid={`cell-production-price-${product.id}`}
                          >
                            <span className={`font-mono text-sm text-muted-foreground`}>
                              {productionPrice > 0 ? `$${productionPrice.toFixed(2)}` : "—"}
                            </span>
                            <Pencil className="h-3 w-3 text-muted-foreground opacity-60 md:opacity-0 md:group-hover:opacity-100" />
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-12">
              <Tag className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No products found</h3>
              <p className="text-muted-foreground mt-2 text-sm">
                {showZeroOnly
                  ? "All products have a selling price set."
                  : search || categoryFilter !== "all"
                    ? "Try adjusting your filters."
                    : "Add bale products to see them here."}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="rounded-md bg-muted/50 border p-4 text-sm text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">How prices work:</p>
        <p>
          Selling prices set here are the catalog prices used across proformas when you click "Apply Catalog Prices."
        </p>
        <p>On each proforma line you can lock the price — locked lines are skipped when applying catalog prices.</p>
        <p>Production cost is used for profitability reports and is not shown to customers.</p>
      </div>
    </div>
  );
}
