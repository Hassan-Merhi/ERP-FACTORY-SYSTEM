import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { PageHeader } from "@/components/PageHeader";
import {
  CalendarDays,
  Trash2,
  Plus,
  Minus,
  Printer,
  Package,
  ChevronDown,
  ChevronUp,
  CheckSquare,
  Square,
  AlertTriangle,
  FileSpreadsheet,
  Tag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { isZebraMode, printRawZpl } from "@/lib/zebraPrint";
import { buildZplBatch } from "@/lib/zplBuilder";
import { LabelPrintSettings, getPaperFormat } from "@/components/LabelPrintSettings";
import { type LabelData, type A4DesignColor, formatLabelNum } from "@/lib/labelHtml";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import type { FactoryBale, FactoryBaleProduct, Location, FactoryCategory } from "@shared/schema";
import * as XLSX from "@/lib/excelHelper";
import type { CartItem, CreatedBale } from "./wipersreentry/types";
import { isWipers, isWipersBale } from "./wipersreentry/utils";
import { buildLabelData, printLabelsInBrowser } from "./wipersreentry/printUtils";
import { productMatchesSearch } from "@shared/factoryProductSearch";
export default function WipersReEntry() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { colors } = useLabelDesignColors();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
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
    queryKey: ["/api/factory/bale-products"],
  });
  const { data: locations } = useQuery<Location[]>({ queryKey: ["/api/locations"] });
  const { data: categories = [] } = useQuery<FactoryCategory[]>({ queryKey: ["/api/factory/categories"] });
  interface WorkerOption {
    id: number;
    fullName?: string;
    name?: string;
  }
  const { data: workers = [] } = useQuery<WorkerOption[]>({ queryKey: ["/api/factory/workers"] });
  interface BaleListRow {
    bale: FactoryBale;
    product: FactoryBaleProduct;
  }
  const { data: allBalesData = [], isLoading: balesLoading } = useQuery<BaleListRow[]>({
    queryKey: ["/api/factory/bales"],
    enabled: cleanupOpen,
  });

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
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
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
        description: `${data.removedCount || cleanupSelectedIds.size} bales removed from stock`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Removal Failed", description: err.message, variant: "destructive" });
    },
  });

  const openBrowserPrint = (labels: LabelData[], format: "A4" | "A5" | "sticker", designColor?: A4DesignColor) => {
    if (printLabelsInBrowser(labels, format, designColor)) return;
    setPendingLabels(labels);
    setDesignPickerOpen(true);
  };

  const handlePrint = async (format: "A4" | "A5" | "sticker") => {
    if (!createdBales || createdBales.length === 0) return;
    const labels = buildLabelData(createdBales);

    if (isZebraMode() && format === "sticker") {
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
    const labels = buildLabelData(createdBales);
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
      const rows = createdBales.map((b) => ({
        Reference: b.referenceNumber,
        Product: b.productName || "",
        "Article Code": b.articleCode || "",
        "Weight (kg)": b.weightKg,
        "Entry Date": b.stockEntryDate || entryDate,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "WipersReEntry");
      await XLSX.writeFile(wb, `wipers-re-entry-${entryDate}.xlsx`);
    } catch (err) {
      toast({
        title: "Export failed",
        description: getErrorDetails(err).optionalMessage || "Could not generate Excel file.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Sub-nav tabs */}
      <div className="border-b px-6 flex items-center gap-1 pt-4">
        <button
          onClick={() => navigate("/factory/bale-relabeling")}
          className="px-4 py-2 text-sm font-medium rounded-t-md text-muted-foreground hover-elevate"
          data-testid="tab-relabeling"
        >
          Bale Relabeling
        </button>
        <button
          className="px-4 py-2 text-sm font-medium rounded-t-md border-b-2 border-primary text-primary"
          data-testid="tab-wipers-re-entry"
        >
          Wipers Re-Entry by Date
        </button>
      </div>

      <div className="p-6 space-y-6">
        {/* Header */}
        <div>
          <PageHeader
            title="Wipers Re-Entry by Date"
            subtitle="Create new wipers / garbage bales under a chosen entry date and print labels"
          />
        </div>

        {/* Controls */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              Entry Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1">
              <Label htmlFor="entry-date">
                Entry Date <span className="text-destructive">*</span>
              </Label>
              <Input
                id="entry-date"
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                data-testid="input-entry-date"
              />
              <p className="text-xs text-muted-foreground">Bales will be recorded under this date</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="location">
                Warehouse Location <span className="text-destructive">*</span>
              </Label>
              <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
                <SelectTrigger id="location" data-testid="select-location">
                  <SelectValue placeholder="Select location..." />
                </SelectTrigger>
                <SelectContent>
                  {activeLocations.map((l) => (
                    <SelectItem key={l.id} value={l.id.toString()} data-testid={`option-location-${l.id}`}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Default Worker (optional)</Label>
              <Select
                value=""
                onValueChange={(workerId) => {
                  const id = workerId === "none" ? null : parseInt(workerId);
                  setCart((prev) => prev.map((i) => ({ ...i, finalizedBy: id })));
                }}
              >
                <SelectTrigger data-testid="select-default-worker">
                  <SelectValue placeholder="Apply worker to all rows..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {workers.map((w) => (
                    <SelectItem key={w.id} value={w.id.toString()}>
                      {w.fullName || w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Cart */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="h-4 w-4" />
              Wipers Products
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Product search */}
            <div className="relative">
              <Input
                ref={scanRef}
                placeholder="Search wipers / garbage product by name or article code..."
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setShowDropdown(true);
                  setSearchError("");
                }}
                onFocus={() => setShowDropdown(true)}
                onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
                onKeyDown={handleKeyDown}
                data-testid="input-product-search"
              />
              {searchError && <p className="text-xs text-destructive mt-1">{searchError}</p>}
              {showDropdown && filteredProducts.length > 0 && (
                <div className="absolute z-50 left-0 right-0 mt-1 bg-popover border rounded-md shadow-md max-h-60 overflow-y-auto">
                  {filteredProducts.map((p) => (
                    <button
                      key={p.id}
                      className="w-full text-left px-3 py-2 text-sm hover-elevate flex items-center justify-between gap-2"
                      onMouseDown={() => addToCart(p)}
                      data-testid={`option-product-${p.id}`}
                    >
                      <span>{p.name}</span>
                      <span className="text-xs text-muted-foreground">{p.articleCode}</span>
                    </button>
                  ))}
                </div>
              )}
              {productsLoading && <p className="text-xs text-muted-foreground mt-1">Loading products...</p>}
              {!productsLoading && wiperProducts.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  No wipers/garbage products found. Ensure products are categorized as Wipers or Garbage.
                </p>
              )}
            </div>

            {/* Cart table */}
            {cart.length > 0 ? (
              <div className="table-responsive">
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>Article Code</TableHead>
                      <TableHead className="w-32 text-right">Qty</TableHead>
                      <TableHead className="w-32 text-right">Weight/Bale (kg)</TableHead>
                      <TableHead className="text-right">Total Weight</TableHead>
                      <TableHead>Worker</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cart.map((item) => (
                      <TableRow key={item.productId} data-testid={`row-cart-${item.productId}`}>
                        <TableCell className="font-medium">{item.product.name}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {item.product.articleCode || item.product.code}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => updateQty(item.productId, -1)}
                              data-testid={`button-qty-minus-${item.productId}`}
                            >
                              <Minus className="h-3 w-3" />
                            </Button>
                            <Input
                              className="w-14 text-center font-mono"
                              value={item.qty}
                              onChange={(e) => setQtyDirect(item.productId, e.target.value)}
                              data-testid={`input-qty-${item.productId}`}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => updateQty(item.productId, 1)}
                              data-testid={`button-qty-plus-${item.productId}`}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            className="w-24 text-right font-mono ml-auto"
                            defaultValue={item.weightPerBaleKg}
                            onBlur={(e) => updateWeight(item.productId, e.target.value)}
                            data-testid={`input-weight-${item.productId}`}
                          />
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatLabelNum(item.qty * item.weightPerBaleKg)} kg
                        </TableCell>
                        <TableCell>
                          <Select
                            value={item.finalizedBy?.toString() || "none"}
                            onValueChange={(v) => assignWorker(item.productId, v === "none" ? null : parseInt(v))}
                          >
                            <SelectTrigger className="h-8 w-28" data-testid={`select-worker-${item.productId}`}>
                              <SelectValue placeholder="None" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              {workers.map((w) => (
                                <SelectItem key={w.id} value={w.id.toString()}>
                                  {w.fullName || w.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => removeItem(item.productId)}
                            data-testid={`button-remove-${item.productId}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground text-sm">
                Search and add wipers / garbage products above
              </div>
            )}

            {/* Cart summary + submit */}
            {cart.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t">
                <div className="flex gap-4 text-sm">
                  <span>
                    Total bales:{" "}
                    <span className="font-semibold font-mono" data-testid="text-total-qty">
                      {totalQty}
                    </span>
                  </span>
                  <span>
                    Total weight:{" "}
                    <span className="font-semibold font-mono" data-testid="text-total-kg">
                      {formatLabelNum(totalKg)} kg
                    </span>
                  </span>
                </div>
                <Button
                  onClick={() => {
                    if (!entryDate) {
                      toast({ title: "Error", description: "Entry date is required", variant: "destructive" });
                      return;
                    }
                    if (!selectedLocationId) {
                      toast({ title: "Error", description: "Warehouse location is required", variant: "destructive" });
                      return;
                    }
                    setConfirmOpen(true);
                  }}
                  data-testid="button-submit"
                >
                  Create {totalQty} Bale{totalQty !== 1 ? "s" : ""}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cleanup panel */}
        <Card>
          <CardHeader className="pb-3 cursor-pointer" onClick={() => setCleanupOpen((o) => !o)}>
            <CardTitle className="text-base flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Trash2 className="h-4 w-4 text-destructive" />
                Current Wipers Stock Cleanup
                {currentWipersBales.length > 0 && <Badge variant="secondary">{currentWipersBales.length} bales</Badge>}
              </span>
              {cleanupOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </CardTitle>
          </CardHeader>
          {cleanupOpen && (
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Use this panel to remove current wipers / garbage bales before re-entering with the new date. Supervisor
                credentials are required.
              </p>
              {balesLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : currentWipersBales.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-sm">
                  No wipers / garbage bales currently in stock
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <div className="flex gap-3">
                      <span>{currentWipersBales.length} bales</span>
                      <span>{formatLabelNum(cleanupTotalKg)} kg total</span>
                    </div>
                    <Button variant="ghost" size="sm" onClick={toggleSelectAll} data-testid="button-select-all-cleanup">
                      {cleanupSelectedIds.size === currentWipersBales.length ? (
                        <>
                          <CheckSquare className="h-4 w-4 mr-1" />
                          Deselect All
                        </>
                      ) : (
                        <>
                          <Square className="h-4 w-4 mr-1" />
                          Select All
                        </>
                      )}
                    </Button>
                  </div>
                  <div className="overflow-x-auto max-h-64 overflow-y-auto">
                    <Table>
                      <TableHeader className="sticky top-0 z-30 bg-background">
                        <TableRow>
                          <TableHead className="w-10"></TableHead>
                          <TableHead>Reference</TableHead>
                          <TableHead>Product</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Weight (kg)</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {currentWipersBales.map((bale) => (
                          <TableRow
                            key={bale.id}
                            className="cursor-pointer"
                            onClick={() => toggleCleanupSelect(bale.id)}
                            data-testid={`row-cleanup-bale-${bale.id}`}
                          >
                            <TableCell>
                              <div className="flex items-center justify-center">
                                {cleanupSelectedIds.has(bale.id) ? (
                                  <CheckSquare className="h-4 w-4 text-primary" />
                                ) : (
                                  <Square className="h-4 w-4 text-muted-foreground" />
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="font-mono text-sm">{bale.referenceNumber}</TableCell>
                            <TableCell className="text-sm">{bale.productName || bale.category || "-"}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {(bale.status || "-").replace(/_/g, " ")}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {formatLabelNum(parseFloat(bale.weightKg || "0"))}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {cleanupSelectedIds.size > 0 && (
                    <div className="border rounded-md p-4 space-y-3 bg-destructive/5">
                      <p className="text-sm font-medium text-destructive flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4" />
                        Removing {cleanupSelectedIds.size} bale{cleanupSelectedIds.size !== 1 ? "s" : ""} — supervisor
                        authorization required
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="sup-user">Supervisor Username</Label>
                          <Input
                            id="sup-user"
                            value={supervisorUsername}
                            onChange={(e) => setSupervisorUsername(e.target.value)}
                            placeholder="Username"
                            data-testid="input-supervisor-username"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="sup-pass">Supervisor Password</Label>
                          <Input
                            id="sup-pass"
                            type="password"
                            value={supervisorPassword}
                            onChange={(e) => setSupervisorPassword(e.target.value)}
                            placeholder="Password"
                            data-testid="input-supervisor-password"
                          />
                        </div>
                      </div>
                      <Button
                        variant="destructive"
                        disabled={!supervisorUsername || !supervisorPassword || cleanupMutation.isPending}
                        onClick={() => cleanupMutation.mutate()}
                        data-testid="button-remove-selected"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        {cleanupMutation.isPending
                          ? "Removing..."
                          : `Remove ${cleanupSelectedIds.size} Bale${cleanupSelectedIds.size !== 1 ? "s" : ""}`}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          )}
        </Card>

        {/* Results section */}
        {createdBales && createdBales.length > 0 && (
          <Card className="border-primary/30">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 text-primary">
                <Tag className="h-4 w-4" />
                Bales Created Successfully
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="rounded-md border px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-1">Bales Created</p>
                  <p className="text-2xl font-bold font-mono" data-testid="text-result-qty">
                    {createdBales.length}
                  </p>
                </div>
                <div className="rounded-md border px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-1">Entry Date</p>
                  <p className="text-lg font-semibold" data-testid="text-result-date">
                    {entryDate}
                  </p>
                </div>
                <div className="rounded-md border px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-1">Total Weight</p>
                  <p className="text-lg font-bold font-mono" data-testid="text-result-weight">
                    {formatLabelNum(createdBales.reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0))} kg
                  </p>
                </div>
              </div>

              {/* Print buttons */}
              <LabelPrintSettings />
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => handlePrint("A4")} variant="outline" data-testid="button-print-a4">
                  <Printer className="h-4 w-4 mr-2" />
                  Print A4
                </Button>
                <Button onClick={() => handlePrint("sticker")} variant="outline" data-testid="button-print-sticker">
                  <Printer className="h-4 w-4 mr-2" />
                  Print Sticker
                </Button>
                <Button onClick={() => handlePrint("A5")} variant="outline" data-testid="button-print-a5">
                  <Printer className="h-4 w-4 mr-2" />
                  Print A5
                </Button>
                <Button onClick={handlePrintAll} data-testid="button-print-all">
                  <Printer className="h-4 w-4 mr-2" />
                  Print All Formats
                </Button>
                <Button variant="outline" onClick={exportCsv} data-testid="button-export-csv">
                  <FileSpreadsheet className="h-4 w-4 mr-2" />
                  Export CSV
                </Button>
              </div>

              {/* Preview of first few labels */}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Generated References</p>
                <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
                  {createdBales.map((b) => (
                    <Badge
                      key={b.id}
                      variant="secondary"
                      className="font-mono text-xs"
                      data-testid={`badge-ref-${b.id}`}
                    >
                      {b.referenceNumber}
                    </Badge>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Confirm dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Confirm Wipers Re-Entry</DialogTitle>
            <DialogDescription>Review details before creating bales</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
              <span className="text-muted-foreground">Entry Date</span>
              <span className="font-semibold text-primary" data-testid="text-confirm-date">
                {entryDate}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
              <span className="text-muted-foreground">Location</span>
              <span className="font-semibold" data-testid="text-confirm-location">
                {activeLocations.find((l) => l.id.toString() === selectedLocationId)?.name || "-"}
              </span>
            </div>
            <div className="table-responsive">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Weight/Bale</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cart.map((item) => (
                    <TableRow key={item.productId}>
                      <TableCell className="text-xs">{item.product.name}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{item.qty}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{item.weightPerBaleKg} kg</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatLabelNum(item.qty * item.weightPerBaleKg)} kg
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex justify-between rounded-md border px-3 py-2 font-semibold">
              <span>Total: {totalQty} bales</span>
              <span>{formatLabelNum(totalKg)} kg</span>
            </div>
            <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 space-y-1">
              <p className="flex items-center gap-1 font-medium">
                <AlertTriangle className="h-3 w-3" /> Important
              </p>
              <p>
                Bales will be recorded under <strong>{entryDate}</strong>, not today's date.
              </p>
              <p>New reference numbers continue from the existing REF sequence.</p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)} data-testid="button-confirm-cancel">
              Cancel
            </Button>
            <Button
              onClick={() => stockEntryMutation.mutate()}
              disabled={stockEntryMutation.isPending}
              data-testid="button-confirm-submit"
            >
              {stockEntryMutation.isPending ? "Creating..." : `Create ${totalQty} Bales`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* A4 Design color picker */}
      <Dialog open={designPickerOpen} onOpenChange={setDesignPickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose A4 Label Design</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            {colors.map((opt) => (
              <Button
                key={opt.value}
                variant="outline"
                onClick={() => {
                  setDesignPickerOpen(false);
                  if (pendingLabels) openBrowserPrint(pendingLabels, "A4", opt.value);
                  setPendingLabels(null);
                }}
                data-testid={`button-design-${opt.value}`}
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full mr-2 flex-shrink-0 border border-border/50"
                  style={{ background: opt.color }}
                />
                {opt.label}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
