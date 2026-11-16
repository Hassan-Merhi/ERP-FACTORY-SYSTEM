// Extracted from ./DailyScan.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatNumber } from "@/lib/formatNumber";
import { visibleTabInterval } from "@/lib/queryPolicies";
import * as XLSX from "@/lib/excelHelper";
import { exportFileName } from "@/lib/exportFile";
import {
  formatDisplay,
  prioritizeDailyScanBales,
  toLocalDateStr,
  type DayBale,
  type SavedScan,
  type ScanFeedback,
} from "./getDailyScanPriority";

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
  const { data: dayBales = [], isLoading } = useQuery<DayBale[]>({
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
    onError: () => toast({ title: "Error", description: "Could not remove scan.", variant: "destructive" }),
  });

  const handleExport = async () => {
    if (dayBales.length === 0) {
      toast({ title: "Nothing to export", description: "No bales produced on this day." });
      return;
    }

    const { ExcelJS } = XLSX;
    const wb = new ExcelJS.Workbook();
    wb.creator = "HMD ERP";
    wb.created = new Date();

    // Excel sheet names cannot contain "/", so the dd/mm/yyyy display date made
    // ExcelJS throw and the export never produced a file.
    const ws = wb.addWorksheet(formatDisplay(selectedDate).replace(/\//g, "-"));

    const NAVY = "FF1B2A4A";
    const WHITE = "FFFFFFFF";
    const LGRAY = "FFF5F7FA";
    const GREEN = "FFD6F5D6";
    const thinBorder = { style: "thin" as const, color: { argb: "FFD0D7E0" } };
    const allBorders = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };
    const solidFill = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } });

    ws.columns = [
      { key: "num", width: 6 },
      { key: "ref", width: 18 },
      { key: "art", width: 16 },
      { key: "name", width: 32 },
      { key: "wt", width: 14 },
      { key: "dateProd", width: 16 },
      { key: "worker", width: 20 },
      { key: "status", width: 12 },
      { key: "time", width: 14 },
    ];

    const headers = [
      "#",
      "Ref Code",
      "Article Code",
      "Product Name",
      "Weight (kg)",
      "Date Produced",
      "Worker",
      "Status",
      "Scanned At",
    ];
    const hRow = ws.addRow(headers);
    hRow.eachCell((cell) => {
      cell.fill = solidFill(NAVY);
      cell.font = { bold: true, color: { argb: WHITE }, size: 11 };
      cell.border = allBorders;
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
    hRow.height = 22;

    // All bales — scanned first, then unscanned
    const ordered = [...scanned, ...unscanned];
    ordered.forEach((b, i) => {
      const scan = scannedRefMap.get(b.reference_number);
      const isScanned = !!scan;
      const row = ws.addRow([
        i + 1,
        b.reference_number,
        b.article_code || "",
        b.product_name || "",
        b.weight_kg ? parseFloat(b.weight_kg) : "",
        b.date_bale_produced || "",
        b.worker_name || "",
        isScanned ? "Scanned" : "Missing",
        scan ? new Date(scan.scanned_at).toLocaleTimeString("en-GB") : "",
      ]);
      row.eachCell((cell) => {
        cell.border = allBorders;
        cell.fill = solidFill(isScanned ? GREEN : i % 2 === 0 ? WHITE : LGRAY);
        cell.alignment = { vertical: "middle" };
      });
      row.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
      row.getCell(5).alignment = { horizontal: "right", vertical: "middle" };
    });

    const totalRow = ws.addRow(["", "TOTAL", "", "", totalKg, "", "", `${scanned.length}/${totalBales} scanned`, ""]);
    totalRow.eachCell((cell, col) => {
      cell.border = allBorders;
      cell.font = { bold: true };
      cell.fill = solidFill("FFE8F0F8");
      if (col === 5) cell.alignment = { horizontal: "right", vertical: "middle" };
    });

    await XLSX.writeFile(wb, exportFileName("daily scan", "xlsx", { date: selectedDate }));
  };
  return {
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
