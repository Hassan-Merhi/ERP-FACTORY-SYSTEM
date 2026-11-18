// Extracted from ./DailyScan.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatNumber } from "@/lib/formatNumber";
import { visibleTabInterval } from "@/lib/queryPolicies";
import { type DayBale, formatDisplay, toLocalDateStr } from "./DailyScanTypes";
import { prioritizeDailyScanBales, type SavedScan, type ScanFeedback } from "./getDailyScanPriority";

export function useDailyScanState() {
  const today = toLocalDateStr(new Date());
  const [selectedDate, setSelectedDate] = useState(today);
  const [scanInput, setScanInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [showScanned, setShowScanned] = useState(false);
  const [lastScan, setLastScan] = useState<ScanFeedback | null>(null);
  const lastScanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const showFeedback = (fb: ScanFeedback) => {
    if (lastScanTimer.current) clearTimeout(lastScanTimer.current);
    setLastScan(fb);
    lastScanTimer.current = setTimeout(() => setLastScan(null), 5000);
  };

  useEffect(() => {
    const t = setTimeout(() => scanRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, [selectedDate]);

  const isToday = selectedDate === today;
  const dailyQueryKey = ["/api/factory/daily-bale-scans", "day", selectedDate] as const;

  // One compact request replaces the old pair of 1,000-row produced + scan-log
  // requests. Local scan/remove mutations patch this cache directly, while a
  // slower visible-tab poll still picks up scans made by another workstation.
  const {
    data: dayBalesData,
    isLoading,
    isError,
    refetch,
  } = useQuery<DayBale[]>({
    queryKey: dailyQueryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ date: selectedDate, profile: "day" });
      const response = await fetch(`/api/factory/daily-bale-scans?${params.toString()}`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load daily bale scan");
      return response.json();
    },
    staleTime: isToday ? 30_000 : 10 * 60_000,
    refetchInterval: isToday ? visibleTabInterval(90_000) : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const dayBales = dayBalesData ?? [];
  const scannedRefMap = new Map<string, { id: number; scanned_at: string }>();
  for (const bale of dayBales) {
    if (bale.scan_id != null && bale.scanned_at) {
      scannedRefMap.set(bale.reference_number, { id: bale.scan_id, scanned_at: bale.scanned_at });
    }
  }
  const unscanned = prioritizeDailyScanBales(dayBales.filter((b) => b.scan_id == null));
  const scanned = prioritizeDailyScanBales(dayBales.filter((b) => b.scan_id != null));

  const totalBales = dayBales.length;
  const totalKg = dayBales.reduce((s, b) => s + parseFloat(b.weight_kg || "0"), 0);
  const scannedKg = scanned.reduce((s, b) => s + parseFloat(b.weight_kg || "0"), 0);
  const allDone = totalBales > 0 && unscanned.length === 0;

  const handleScan = async (code = scanInput) => {
    const ref = code.trim().toUpperCase();
    if (!ref) return;

    // Client-side validation: must be from this day's production
    const bale = dayBales.find((b) => b.reference_number === ref);
    if (!bale) {
      showFeedback({
        type: "error",
        refCode: ref,
        message: `Not produced on ${formatDisplay(selectedDate)}`,
      });
      setScanInput("");
      setTimeout(() => scanRef.current?.focus(), 50);
      return;
    }

    // Already scanned?
    if (bale.scan_id != null) {
      showFeedback({
        type: "warn",
        refCode: ref,
        productName: bale.product_name,
        articleCode: bale.article_code,
        message: "Already scanned today",
      });
      setScanInput("");
      setTimeout(() => scanRef.current?.focus(), 50);
      return;
    }

    setScanning(true);
    setScanInput("");

    try {
      // The server resolves article/name/weight from the authoritative bale row,
      // so the scan request only sends the two identifiers it actually needs.
      const saveRes = await apiRequest("POST", "/api/factory/daily-bale-scans", {
        scanDate: selectedDate,
        referenceNumber: ref,
      });
      const savedScan = (await saveRes.json()) as SavedScan;

      queryClient.setQueryData<DayBale[]>(dailyQueryKey, (current = []) =>
        current.map((row) =>
          row.reference_number === savedScan.reference_number
            ? { ...row, scan_id: savedScan.id, scanned_at: savedScan.scanned_at }
            : row
        )
      );

      showFeedback({
        type: "success",
        refCode: ref,
        productName: bale.product_name,
        articleCode: bale.article_code,
        message: `${bale.weight_kg ? formatNumber(parseFloat(bale.weight_kg)) + " kg · " : ""}Verified`,
      });
    } catch (error) {
      showFeedback({
        type: "error",
        refCode: ref,
        message: getErrorDetails(error).optionalMessage || "Failed to record scan",
      });
    } finally {
      setScanning(false);
      setTimeout(() => scanRef.current?.focus(), 50);
    }
  };

  const removeMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/factory/daily-bale-scans/${id}`);
      return id;
    },
    onSuccess: (id) =>
      queryClient.setQueryData<DayBale[]>(dailyQueryKey, (current = []) =>
        current.map((row) => (row.scan_id === id ? { ...row, scan_id: null, scanned_at: null } : row))
      ),
    onError: () => toast({ title: "Remove failed", description: "Could not remove scan.", variant: "destructive" }),
  });

  const handleExport = async () => {
    if (dayBales.length === 0) {
      toast({ title: "Nothing to export", description: "No bales produced on this day." });
      return;
    }

    try {
      const { exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
      // Use the same order visible in the scanner: scanned first, then missing.
      const rows = [...scanned, ...unscanned].map((b, i) => {
        const scan = scannedRefMap.get(b.reference_number);
        return {
          number: i + 1,
          reference: b.reference_number,
          article: b.article_code || "",
          product: b.product_name || "",
          weight: b.weight_kg ? Number(b.weight_kg) : null,
          produced: b.date_bale_produced || "",
          worker: b.worker_name || "",
          status: scan ? "Scanned" : "Missing",
          scannedAt: scan ? new Date(scan.scanned_at).toLocaleTimeString("en-GB") : "",
        };
      });
      await exportOperationalWorkbook({
        title: "Factory Daily Scan",
        fileName: "daily-scan-" + selectedDate + ".xlsx",
        filters: [
          { label: "Production date", value: formatDisplay(selectedDate) },
          { label: "Scanned", value: scanned.length + "/" + totalBales },
        ],
        sheets: [
          {
            name: formatDisplay(selectedDate).replaceAll("/", "-"),
            columns: [
              { key: "number", header: "#", type: "integer", width: 6 },
              { key: "reference", header: "Ref Code", width: 18 },
              { key: "article", header: "Article Code", width: 16 },
              { key: "product", header: "Product Name", width: 32 },
              { key: "weight", header: "Weight (kg)", type: "decimal", width: 14, numFmt: "#,##0.000" },
              { key: "produced", header: "Date Produced", width: 16 },
              { key: "worker", header: "Worker", width: 20 },
              { key: "status", header: "Status", width: 12 },
              { key: "scannedAt", header: "Scanned At", width: 14 },
            ],
            rows,
            footer: {
              number: null,
              reference: "TOTAL",
              article: "",
              product: "",
              weight: totalKg,
              produced: "",
              worker: "",
              status: scanned.length + "/" + totalBales + " scanned",
              scannedAt: "",
            },
          },
        ],
      });
    } catch (error: unknown) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Could not prepare daily scan workbook",
        variant: "destructive",
      });
    }
  };
  return {
    refetch,
    isError,
    dayBalesData,
    allDone,
    handleExport,
    handleScan,
    isLoading,
    isToday,
    lastScan,
    removeMutation,
    scanInput,
    scanRef,
    scanned,
    scannedKg,
    scannedRefMap,
    scanning,
    selectedDate,
    setLastScan,
    setScanInput,
    setSelectedDate,
    setShowScanned,
    showScanned,
    today,
    totalBales,
    totalKg,
    unscanned,
  };
}
