// Extracted from ./GroundScan.tsx to keep that module under the source-size cap.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { visibleTabInterval } from "@/lib/queryPolicies";
import type { GroundScanItem, ScannedBale, StockLocation } from "./groundscan/types";
import { loadLocalBales, LOCATION_KEY, rowToScannedBale } from "./groundscan/utils";

export function useGroundScanState() {
  const [scanInput, setScanInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [scanError, setScanError] = useState("");
  const [uploading, setUploading] = useState(false);

  const [selectedLocationId, setSelectedLocationId] = useState<string>(
    () => localStorage.getItem(LOCATION_KEY) ?? "all"
  );

  const [localBales, setLocalBales] = useState<ScannedBale[]>(() => loadLocalBales());

  const scanRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const hasMigrationData = localBales.length > 0;

  const { data: stockLocations } = useQuery<StockLocation[]>({
    queryKey: ["/api/factory/stock-entry/in-stock-locations"],
    staleTime: 30_000,
    refetchInterval: visibleTabInterval(60_000),
  });

  const { data: serverItems = [], isLoading } = useQuery<GroundScanItem[]>({
    queryKey: ["/api/factory/ground-scan-items", selectedLocationId],
    queryFn: () =>
      fetch(`/api/factory/ground-scan-items?locationId=${selectedLocationId}`, { credentials: "include" }).then((r) =>
        r.json()
      ),
    staleTime: 10_000,
    // Realtime invalidation updates immediately after writes; polling catches
    // cross-system mutations and reconnects without refreshing the page itself.
    refetchInterval: visibleTabInterval(15_000),
    refetchOnWindowFocus: "always",
    refetchIntervalInBackground: false,
  });

  const scannedBales: ScannedBale[] = serverItems.map(rowToScannedBale);
  const totalWeight = scannedBales.reduce((s, b) => s + b.weightKg, 0);

  useEffect(() => {
    const t = setTimeout(() => scanRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    localStorage.setItem(LOCATION_KEY, selectedLocationId);
  }, [selectedLocationId]);

  useEffect(() => {
    if (!stockLocations) return;
    if (stockLocations.length === 1) {
      setSelectedLocationId(String(stockLocations[0].id));
    } else if (stockLocations.length > 1 && selectedLocationId !== "all") {
      const valid = stockLocations.some((l) => String(l.id) === selectedLocationId);
      if (!valid) setSelectedLocationId("all");
    }
  }, [selectedLocationId, stockLocations]);

  const invalidate = () =>
    queryClient.invalidateQueries(
      { queryKey: ["/api/factory/ground-scan-items", selectedLocationId], exact: true, refetchType: "active" },
      { cancelRefetch: false }
    );

  const removeMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("DELETE", `/api/factory/ground-scan-items/${id}`).then((r) => {
        if (!r.ok) throw new Error("Remove failed");
      }),
    onSuccess: invalidate,
  });

  const clearMutation = useMutation({
    mutationFn: () =>
      apiRequest("DELETE", `/api/factory/ground-scan-items?locationId=${selectedLocationId}`).then((r) => {
        if (!r.ok) throw new Error("Clear failed");
      }),
    onSuccess: () => {
      invalidate();
      setScanError("");
      setScanInput("");
      setTimeout(() => scanRef.current?.focus(), 50);
    },
  });
  return {
    clearMutation,
    exporting,
    hasMigrationData,
    invalidate,
    isLoading,
    localBales,
    removeMutation,
    scanError,
    scanInput,
    scanRef,
    scannedBales,
    scanning,
    selectedLocationId,
    serverItems,
    setExporting,
    setLocalBales,
    setScanError,
    setScanInput,
    setScanning,
    setSelectedLocationId,
    setUploading,
    stockLocations,
    toast,
    totalWeight,
    uploading,
  };
}

export function GroundScanSection({
  selectedLocationId,
  setSelectedLocationId,
  stockLocations,
}: Pick<ReturnType<typeof useGroundScanState>, "selectedLocationId" | "setSelectedLocationId" | "stockLocations">) {
  return (
    <div className="ground-scan-location flex items-center gap-2 text-sm flex-wrap">
      <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground shrink-0">Scanning location:</span>
      <Select
        value={selectedLocationId}
        onValueChange={setSelectedLocationId}
        data-testid="select-ground-scan-location"
      >
        <SelectTrigger className="w-60 max-w-full" data-testid="trigger-ground-scan-location">
          <SelectValue placeholder="All locations" />
        </SelectTrigger>
        <SelectContent>
          {(stockLocations ?? []).length > 1 && <SelectItem value="all">All locations</SelectItem>}
          {(stockLocations ?? []).map((loc) => (
            <SelectItem key={loc.id} value={String(loc.id)}>
              {loc.name} ({loc.count} bales)
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selectedLocationId !== "all" &&
        stockLocations &&
        (() => {
          const loc = stockLocations.find((l) => String(l.id) === selectedLocationId);
          return loc ? (
            <span className="text-xs text-muted-foreground">
              — verifying against <strong>{loc.name}</strong> ({loc.count} system bales)
            </span>
          ) : null;
        })()}
    </div>
  );
}
