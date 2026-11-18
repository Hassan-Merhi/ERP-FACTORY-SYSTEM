// Extracted from ./SmartTransferGeneratorDialog.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  mergeSmartPreviewLines,
  type SmartPreviewOrderItem,
  validateSmartPreviewLines,
} from "./smartTransferPreviewUi";
import type {
  Location,
  LocationSummaryResponse,
  PerformanceClassification,
  SmartPreviewLine,
  SmartPreviewResponse,
  StockItemLight,
  StockMeta,
} from "./smartTransferGeneratorTypes";

export interface SmartTransferGeneratorDialogProps {
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

export function classificationBadge(classification: PerformanceClassification): string {
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

export function useSmartTransferGeneratorDialogState({
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
  return {
    addManualLine,
    categories,
    categoryIds,
    destinationLocationId,
    editedShortfall,
    editedTotal,
    expandedLineIds,
    getInventory,
    importPreview,
    includeOtw,
    lines,
    locations,
    manualItemId,
    manualQuantity,
    manualSourceId,
    onOpenChange,
    open,
    preview,
    previewMutation,
    setCategoryIds,
    setDestinationLocationId,
    setExpandedLineIds,
    setIncludeOtw,
    setLines,
    setManualItemId,
    setManualQuantity,
    setManualSourceId,
    setStockGroupIds,
    setTargetCoverageDays,
    setTargetQuantity,
    sourceLocationIds,
    sourceNameById,
    stockGroupIds,
    stockGroups,
    stockItems,
    target,
    targetCoverageDays,
    targetQuantity,
    toggleSource,
    updateLineQuantity,
    updateLineSource,
    validationErrors,
  };
}
