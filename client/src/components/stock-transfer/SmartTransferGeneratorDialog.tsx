import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { formatNumber } from "@/lib/formatNumber";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  mergeSmartPreviewLines,
  validateSmartPreviewLines,
  type SmartPreviewOrderItem,
} from "./smartTransferPreviewUi";
import {
  type Location,
  type StockMeta,
  type StockItemLight,
  type LocationSummaryResponse,
  type PerformanceClassification,
  type SmartPreviewLine,
  type SmartPreviewResponse,
} from "./smartTransferGeneratorTypes";

interface SmartTransferGeneratorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (payload: {
    destinationLocationId: number;
    sourceLocationIds: number[];
    orderItems: SmartPreviewOrderItem[];
  }) => void;
}

const SOURCE_STORAGE_KEY = "stockTransferOrder_selectedLocations";

function makeClientId(line: { stockItemId: number; sourceLocationId: number }, index: number): string {
  return `${line.stockItemId}:${line.sourceLocationId}:${Date.now()}:${index}`;
}

function numberValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function classificationBadge(classification: PerformanceClassification): string {
  switch (classification) {
    case "strong_seller":
      return "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
    case "good_seller":
      return "border-green-300 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-950/40 dark:text-green-300";
    case "normal_seller":
      return "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300";
    case "slow_seller":
      return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
    case "overstocked":
    case "no_recent_sales":
    default:
      return "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300";
  }
}

function MultiSelectPopover({
  label,
  items,
  selected,
  onChange,
}: {
  label: string;
  items: StockMeta[];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-between font-normal">
          <span className="truncate">{selected.length > 0 ? `${label} (${selected.length})` : `All ${label}`}</span>
          <ChevronDown className="h-4 w-4 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="flex items-center justify-between px-2 pb-2">
          <p className="text-sm font-medium">{label}</p>
          {selected.length > 0 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange([])}>
              Clear
            </Button>
          )}
        </div>
        <ScrollArea className="h-56">
          <div className="space-y-1 pr-2">
            {items.map((item) => (
              <label
                key={item.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-muted"
              >
                <Checkbox
                  checked={selected.includes(item.id)}
                  onCheckedChange={() =>
                    onChange(
                      selected.includes(item.id) ? selected.filter((id) => id !== item.id) : [...selected, item.id]
                    )
                  }
                />
                <span className="text-sm">{item.name}</span>
              </label>
            ))}
            {items.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted-foreground">No options</p>}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

export default function SmartTransferGeneratorDialog({
  open,
  onOpenChange,
  onImport,
}: SmartTransferGeneratorDialogProps) {
  const { toast } = useToast();
  const [destinationLocationId, setDestinationLocationId] = useState<number | null>(null);
  const [sourceLocationIds, setSourceLocationIds] = useState<number[]>([]);
  const [targetQuantity, setTargetQuantity] = useState(""); // empty = auto from sales data
  const [includeOtw, setIncludeOtw] = useState(true);
  const [targetCoverageDays, setTargetCoverageDays] = useState("21");
  const [stockGroupIds, setStockGroupIds] = useState<number[]>([]);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [preview, setPreview] = useState<SmartPreviewResponse | null>(null);
  const [lines, setLines] = useState<SmartPreviewLine[]>([]);
  const [expandedLineIds, setExpandedLineIds] = useState<Set<string>>(new Set());
  const [manualItemId, setManualItemId] = useState<number | null>(null);
  const [manualSourceId, setManualSourceId] = useState<number | null>(null);
  const [manualQuantity, setManualQuantity] = useState("1");

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations", "smart-transfer-generator"],
    queryFn: async () => {
      const response = await fetch("/api/locations", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load locations");
      return response.json();
    },
    enabled: open,
  });

  const { data: stockGroups = [] } = useQuery<StockMeta[]>({
    queryKey: ["/api/stock-groups", "smart-transfer-generator"],
    queryFn: async () => {
      const response = await fetch("/api/stock-groups", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load stock groups");
      return response.json();
    },
    enabled: open,
  });

  const { data: categories = [] } = useQuery<StockMeta[]>({
    queryKey: ["/api/stock-categories", "smart-transfer-generator"],
    queryFn: async () => {
      const response = await fetch("/api/stock-categories", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load categories");
      return response.json();
    },
    enabled: open,
  });

  const { data: stockItems = [] } = useQuery<StockItemLight[]>({
    queryKey: ["/api/stock-items/light", "smart-transfer-generator"],
    queryFn: async () => {
      const response = await fetch("/api/stock-items/light", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load stock items");
      return response.json();
    },
    enabled: open,
    staleTime: 10 * 60 * 1000,
  });

  const sortedSourceIds = useMemo(() => [...sourceLocationIds].sort((a, b) => a - b), [sourceLocationIds]);
  const { data: sourceSummary } = useQuery<LocationSummaryResponse>({
    queryKey: ["/api/location-summary", "smart-transfer-generator", sortedSourceIds.join(",")],
    queryFn: async () => {
      const params = new URLSearchParams({ locationIds: sortedSourceIds.join(",") });
      const response = await fetch(`/api/location-summary?${params.toString()}`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load source inventory");
      return response.json();
    },
    enabled: open && sortedSourceIds.length > 0,
  });

  useEffect(() => {
    if (!open) return;
    try {
      const saved = localStorage.getItem(SOURCE_STORAGE_KEY);
      if (saved && sourceLocationIds.length === 0) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setSourceLocationIds(parsed.filter((id) => Number.isInteger(id)));
      }
    } catch {
      // Ignore an invalid saved selection.
    }
  }, [open, sourceLocationIds.length]);

  // Strip any IDs restored from localStorage that don't belong to the current
  // company's locations. This prevents cross-company stale IDs (e.g. IDs from
  // a previously selected company) from reaching the preview API.
  useEffect(() => {
    if (locations.length === 0) return;
    const validIds = new Set(locations.map((l) => l.id));
    setSourceLocationIds((current) => current.filter((id) => validIds.has(id)));
  }, [locations]);

  useEffect(() => {
    if (!destinationLocationId) return;
    setSourceLocationIds((current) => current.filter((id) => id !== destinationLocationId));
  }, [destinationLocationId]);

  const sourceNameById = useMemo(() => new Map(locations.map((location) => [location.id, location.name])), [locations]);
  const inventoryByItemSource = useMemo(() => {
    const result = new Map<string, { quantity: number; rate: number }>();
    for (const group of sourceSummary?.stockGroups ?? []) {
      for (const item of group.items) {
        for (const sourceId of sourceLocationIds) {
          const data = item.locationData[sourceId];
          if (!data) continue;
          result.set(`${item.id}:${sourceId}`, {
            quantity: Math.max(0, Math.floor(Number(data.quantity) || 0)),
            rate: Number(data.rate) || 0,
          });
        }
      }
    }
    return result;
  }, [sourceSummary, sourceLocationIds]);

  const getInventory = (stockItemId: number, sourceLocationId: number) => {
    const current = inventoryByItemSource.get(`${stockItemId}:${sourceLocationId}`) ?? { quantity: 0, rate: 0 };
    return {
      currentStock: current.quantity,
      available: current.quantity,
      rate: current.rate,
    };
  };

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!destinationLocationId) throw new Error("Select a destination location");
      if (sourceLocationIds.length === 0) throw new Error("Select at least one source location");
      // 0 = auto: server computes target from sum of calculated need per item
      const target = Math.floor(numberValue(targetQuantity, 0));

      const response = await apiRequest("POST", "/api/stock-transfers/smart-preview", {
        destinationLocationId,
        sourceLocationIds,
        targetQuantity: target,
        includeOtw,
        stockGroupIds,
        categoryIds,
        targetCoverageDays: Math.max(1, Math.floor(numberValue(targetCoverageDays, 21))),
      });
      return (await response.json()) as SmartPreviewResponse;
    },
    onSuccess: (result) => {
      setPreview(result);
      setLines(
        result.lines.map((line, index) => ({
          ...line,
          clientId: makeClientId(line, index),
        }))
      );
      setExpandedLineIds(new Set());
      toast({
        title: "Preview generated",
        description: `${result.achievedQuantity} of ${result.targetQuantity} bales suggested across ${result.lines.length} lines.`,
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Could not generate preview", description: error.message, variant: "destructive" });
    },
  });

  const toggleSource = (id: number) => {
    if (id === destinationLocationId) return;
    setSourceLocationIds((current) =>
      current.includes(id) ? current.filter((sourceId) => sourceId !== id) : [...current, id]
    );
  };

  const updateLineQuantity = (clientId: string, value: string) => {
    const quantity = Math.max(0, Math.floor(numberValue(value, 0)));
    setLines((current) =>
      current.map((line) => (line.clientId === clientId ? { ...line, suggestedQuantity: quantity } : line))
    );
  };

  const updateLineSource = (clientId: string, sourceLocationId: number) => {
    const sourceLocationName = sourceNameById.get(sourceLocationId) ?? `Location #${sourceLocationId}`;
    setLines((current) =>
      current.map((line) => {
        if (line.clientId !== clientId) return line;
        const inventory = getInventory(line.stockItemId, sourceLocationId);
        return {
          ...line,
          sourceLocationId,
          sourceLocationName,
          availableAtSource: inventory.available,
          sourceCurrentStock: inventory.currentStock,
          // Manual source override carries no auto-computed local-sales reserve
          // (that value is only produced server-side from sales history), so
          // reserve 0 here rather than referencing an undefined `reserveQty`.
          sourceReserveQty: 0,
          sourceAverageRate: inventory.rate,
          suggestedQuantity: Math.min(line.suggestedQuantity, inventory.available),
          reason: `${line.reason} Source changed manually to ${sourceLocationName}.`,
        };
      })
    );
  };

  const addManualLine = () => {
    if (!manualItemId || !manualSourceId) {
      toast({ title: "Select an item and source", variant: "destructive" });
      return;
    }
    const item = stockItems.find((candidate) => candidate.id === manualItemId);
    const sourceName = sourceNameById.get(manualSourceId);
    if (!item || !sourceName) return;
    const inventory = getInventory(manualItemId, manualSourceId);
    const quantity = Math.max(0, Math.floor(numberValue(manualQuantity, 0)));
    if (quantity <= 0 || quantity > inventory.available) {
      toast({
        title: "Invalid quantity",
        description: `Available after reserve: ${inventory.available}`,
        variant: "destructive",
      });
      return;
    }

    setLines((current) => {
      const existing = current.find(
        (line) => line.stockItemId === manualItemId && line.sourceLocationId === manualSourceId
      );
      if (existing) {
        return current.map((line) =>
          line.clientId === existing.clientId
            ? { ...line, suggestedQuantity: Math.min(inventory.available, line.suggestedQuantity + quantity) }
            : line
        );
      }
      const line: SmartPreviewLine = {
        clientId: makeClientId({ stockItemId: item.id, sourceLocationId: manualSourceId }, current.length),
        manual: true,
        stockItemId: item.id,
        stockItemName: item.name,
        stockItemCode: item.code,
        uom: item.uom,
        stockGroupId: null,
        categoryId: null,
        sourceLocationId: manualSourceId,
        sourceLocationName: sourceName,
        availableAtSource: inventory.available,
        sourceCurrentStock: inventory.currentStock,
        // Manually added line has no server-computed local-sales reserve; use 0
        // rather than referencing an undefined `reserveQty`.
        sourceReserveQty: 0,
        sourceAverageRate: inventory.rate,
        destinationStock: 0,
        otwQty: 0,
        effectiveDestinationStock: 0,
        olderTransferQty: 0,
        newerTransferQty: 0,
        salesAfterOlderTransfer: 0,
        salesAfterNewerTransfer: 0,
        totalSalesSinceOlderTransfer: 0,
        olderSellThroughPercentage: 0,
        newerSellThroughPercentage: 0,
        overallSellThroughPercentage: 0,
        averageSalesPerDay: 0,
        latestSalesPerDay: 0,
        estimatedDaysOfStockRemaining: null,
        classification: "normal_seller",
        classificationLabel: "Manual item",
        suggestedQuantity: quantity,
        itemSuggestedTotal: quantity,
        calculatedNeed: quantity,
        confidence: 0.5,
        reason: "Added manually after reviewing the generated preview.",
      };
      return [...current, line];
    });
    setManualItemId(null);
    setManualQuantity("1");
  };

  const editedTotal = lines.reduce((sum, line) => sum + Math.max(0, line.suggestedQuantity), 0);
  const target = Math.max(0, Math.floor(numberValue(targetQuantity, 0)));
  const editedShortfall = Math.max(0, target - editedTotal);
  const validationErrors = validateSmartPreviewLines(lines);

  const importPreview = () => {
    if (!destinationLocationId) return;
    if (validationErrors.length > 0) {
      toast({ title: "Fix preview errors", description: validationErrors[0], variant: "destructive" });
      return;
    }
    const orderItems = mergeSmartPreviewLines(lines);
    if (orderItems.length === 0) {
      toast({ title: "Preview is empty", variant: "destructive" });
      return;
    }
    onImport({ destinationLocationId, sourceLocationIds, orderItems });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-7xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Smart Multi-Source Transfer Generator
          </DialogTitle>
          <DialogDescription>
            Compares the last two completed transfers, sales since those orders, live source stock and optional OTW
            stock.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[330px_minmax(0,1fr)]">
          <div className="overflow-y-auto border-b p-4 lg:border-b-0 lg:border-r">
            <div className="space-y-5">
              <div className="space-y-2">
                <Label>Destination</Label>
                <Select
                  value={destinationLocationId?.toString() ?? ""}
                  onValueChange={(value) => setDestinationLocationId(Number(value))}
                >
                  <SelectTrigger data-testid="smart-transfer-destination">
                    <SelectValue placeholder="Select destination" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((location) => (
                      <SelectItem key={location.id} value={location.id.toString()}>
                        {location.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Source locations</Label>
                  <span className="text-xs text-muted-foreground">{sourceLocationIds.length} selected</span>
                </div>
                <ScrollArea className="h-48 rounded-md border">
                  <div className="space-y-1 p-2">
                    {locations.map((location) => {
                      const disabled = location.id === destinationLocationId;
                      return (
                        <label
                          key={location.id}
                          className={cn(
                            "flex items-center gap-2 rounded-md px-2 py-2",
                            disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:bg-muted"
                          )}
                        >
                          <Checkbox
                            checked={sourceLocationIds.includes(location.id)}
                            disabled={disabled}
                            onCheckedChange={() => toggleSource(location.id)}
                          />
                          <span className="text-sm">{location.name}</span>
                          <span className="ml-auto text-xs text-muted-foreground">{location.code}</span>
                        </label>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="smart-target">
                    Target bales <span className="text-xs font-normal text-muted-foreground">(blank = auto)</span>
                  </Label>
                  <Input
                    id="smart-target"
                    type="number"
                    min="1"
                    step="1"
                    placeholder="Auto from sales"
                    value={targetQuantity}
                    onChange={(event) => setTargetQuantity(event.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="smart-coverage">Target coverage days</Label>
                <Input
                  id="smart-coverage"
                  type="number"
                  min="1"
                  max="180"
                  step="1"
                  value={targetCoverageDays}
                  onChange={(event) => setTargetCoverageDays(event.target.value)}
                />
              </div>

              <MultiSelectPopover
                label="stock groups"
                items={stockGroups}
                selected={stockGroupIds}
                onChange={setStockGroupIds}
              />
              <MultiSelectPopover
                label="categories"
                items={categories}
                selected={categoryIds}
                onChange={setCategoryIds}
              />

              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Include Stock OTW</p>
                  <p className="text-xs text-muted-foreground">Reduces suggestions already covered on the way</p>
                </div>
                <Switch checked={includeOtw} onCheckedChange={setIncludeOtw} />
              </div>

              <Button
                className="w-full"
                onClick={() => previewMutation.mutate()}
                disabled={previewMutation.isPending || !destinationLocationId || sourceLocationIds.length === 0}
                data-testid="button-generate-smart-preview"
              >
                {previewMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Generate Preview
              </Button>
            </div>
          </div>

          <div className="flex min-h-0 flex-col overflow-hidden">
            {!preview ? (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground">
                <Sparkles className="mb-4 h-12 w-12 opacity-40" />
                <p className="font-medium text-foreground">Choose the destination, sources and target quantity</p>
                <p className="mt-1 max-w-lg text-sm">
                  The generator will return an editable preview only. It will not create a voucher or move stock.
                </p>
              </div>
            ) : (
              <>
                <div className="border-b p-4">
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Requested</p>
                      <p className="text-xl font-semibold">{formatNumber(target, 0)}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Preview total</p>
                      <p className="text-xl font-semibold">{formatNumber(editedTotal, 0)}</p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Shortfall</p>
                      <p className={cn("text-xl font-semibold", editedShortfall > 0 && "text-amber-600")}>
                        {formatNumber(editedShortfall, 0)}
                      </p>
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">Suggested lines</p>
                      <p className="text-xl font-semibold">{lines.length}</p>
                    </div>
                  </div>

                  {(preview.warnings.length > 0 || validationErrors.length > 0) && (
                    <div className="mt-3 space-y-2">
                      {[...preview.warnings, ...validationErrors].map((warning, index) => (
                        <div
                          key={`${warning}-${index}`}
                          className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                        >
                          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>{warning}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="min-h-0 flex-1 overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-20 bg-background">
                      <TableRow>
                        <TableHead className="w-9"></TableHead>
                        <TableHead className="min-w-[190px]">Item</TableHead>
                        <TableHead className="min-w-[150px]">Source</TableHead>
                        <TableHead className="text-right">Available</TableHead>
                        <TableHead className="text-right">Last 2 sent</TableHead>
                        <TableHead className="text-right">Sold since</TableHead>
                        <TableHead className="text-right">Dest + OTW</TableHead>
                        <TableHead className="w-28 text-right">Suggested</TableHead>
                        <TableHead className="w-10"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {lines.map((line) => {
                        const expanded = expandedLineIds.has(line.clientId);
                        return (
                          <>
                            <TableRow key={line.clientId}>
                              <TableCell>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() =>
                                    setExpandedLineIds((current) => {
                                      const next = new Set(current);
                                      next.has(line.clientId) ? next.delete(line.clientId) : next.add(line.clientId);
                                      return next;
                                    })
                                  }
                                >
                                  {expanded ? (
                                    <ChevronDown className="h-4 w-4" />
                                  ) : (
                                    <ChevronRight className="h-4 w-4" />
                                  )}
                                </Button>
                              </TableCell>
                              <TableCell>
                                <div className="space-y-1">
                                  <p className="font-medium">{line.stockItemName}</p>
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-xs text-muted-foreground">{line.stockItemCode}</span>
                                    <Badge
                                      variant="outline"
                                      className={cn("text-[11px]", classificationBadge(line.classification))}
                                    >
                                      {line.classificationLabel}
                                    </Badge>
                                    {line.manual && (
                                      <Badge variant="secondary" className="text-[11px]">
                                        Manual
                                      </Badge>
                                    )}
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell>
                                <Select
                                  value={line.sourceLocationId.toString()}
                                  onValueChange={(value) => updateLineSource(line.clientId, Number(value))}
                                >
                                  <SelectTrigger className="h-8">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {sourceLocationIds.map((sourceId) => {
                                      const inventory = getInventory(line.stockItemId, sourceId);
                                      return (
                                        <SelectItem
                                          key={sourceId}
                                          value={sourceId.toString()}
                                          disabled={inventory.available <= 0}
                                        >
                                          {sourceNameById.get(sourceId)} ({inventory.available})
                                        </SelectItem>
                                      );
                                    })}
                                  </SelectContent>
                                </Select>
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatNumber(line.availableAtSource, 0)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatNumber(line.olderTransferQty + line.newerTransferQty, 0)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatNumber(line.totalSalesSinceOlderTransfer, 0)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatNumber(line.effectiveDestinationStock, 0)}
                              </TableCell>
                              <TableCell>
                                <Input
                                  className="h-8 text-right font-mono"
                                  type="number"
                                  min="0"
                                  step="1"
                                  value={line.suggestedQuantity}
                                  onChange={(event) => updateLineQuantity(line.clientId, event.target.value)}
                                />
                              </TableCell>
                              <TableCell>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive"
                                  onClick={() =>
                                    setLines((current) =>
                                      current.filter((candidate) => candidate.clientId !== line.clientId)
                                    )
                                  }
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                            {expanded && (
                              <TableRow key={`${line.clientId}-details`} className="bg-muted/30">
                                <TableCell></TableCell>
                                <TableCell colSpan={8}>
                                  <div className="grid gap-3 py-2 text-xs md:grid-cols-4">
                                    <div>
                                      <span className="text-muted-foreground">Older transfer:</span>{" "}
                                      {formatNumber(line.olderTransferQty, 0)}
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Newer transfer:</span>{" "}
                                      {formatNumber(line.newerTransferQty, 0)}
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Older sell-through:</span>{" "}
                                      {formatNumber(line.olderSellThroughPercentage, 1)}%
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Newer sell-through:</span>{" "}
                                      {formatNumber(line.newerSellThroughPercentage, 1)}%
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Latest sales/day:</span>{" "}
                                      {formatNumber(line.latestSalesPerDay, 2)}
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Calculated need:</span>{" "}
                                      {formatNumber(line.calculatedNeed, 0)}
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Confidence:</span>{" "}
                                      {formatNumber(line.confidence * 100, 0)}%
                                    </div>
                                    <p className="md:col-span-4 text-muted-foreground">{line.reason}</p>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </>
                        );
                      })}
                      {lines.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                            No suggested lines. Adjust the filters, sources or target and regenerate.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                <div className="border-t p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Plus className="h-4 w-4" />
                    <p className="text-sm font-medium">Add another item manually</p>
                  </div>
                  <div className="grid gap-2 md:grid-cols-[minmax(180px,1fr)_minmax(150px,220px)_100px_auto]">
                    <Select
                      value={manualItemId?.toString() ?? ""}
                      onValueChange={(value) => setManualItemId(Number(value))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Stock item" />
                      </SelectTrigger>
                      <SelectContent>
                        {stockItems.map((item) => (
                          <SelectItem key={item.id} value={item.id.toString()}>
                            {item.name} ({item.code})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={manualSourceId?.toString() ?? ""}
                      onValueChange={(value) => setManualSourceId(Number(value))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Source" />
                      </SelectTrigger>
                      <SelectContent>
                        {sourceLocationIds.map((sourceId) => (
                          <SelectItem key={sourceId} value={sourceId.toString()}>
                            {sourceNameById.get(sourceId)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      value={manualQuantity}
                      onChange={(event) => setManualQuantity(event.target.value)}
                    />
                    <Button type="button" variant="outline" onClick={addManualLine}>
                      <Plus className="mr-1 h-4 w-4" /> Add
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <DialogFooter className="border-t px-5 py-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {preview && (
            <Button
              type="button"
              variant="outline"
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
            >
              <RefreshCw className={cn("mr-2 h-4 w-4", previewMutation.isPending && "animate-spin")} />
              Regenerate
            </Button>
          )}
          <Button
            type="button"
            onClick={importPreview}
            disabled={!preview || lines.length === 0 || validationErrors.length > 0}
            data-testid="button-import-smart-preview"
          >
            <Check className="mr-2 h-4 w-4" />
            Import to Optional Order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
