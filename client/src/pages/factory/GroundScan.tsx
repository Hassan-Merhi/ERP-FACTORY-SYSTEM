import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ScanLine,
  Trash2,
  Download,
  AlertCircle,
  X,
  Package,
  Loader2,
  MapPin,
  Upload,
  ServerCrash,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import * as XLSX from "@/lib/excelHelper";
import type { Cell, Row } from "exceljs";
import { formatNumber } from "@/lib/formatNumber";
import { visibleTabInterval } from "@/lib/queryPolicies";

import type { GroundScanItem, ScannedBale, StockLocation } from "./groundscan/types";
import { LOCATION_KEY, STORAGE_KEY, loadLocalBales, rowToScannedBale } from "./groundscan/utils";
import { StatusBadge } from "./groundscan/components/StatusBadge";
export default function GroundScan() {
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
    staleTime: 60000,
  });

  const { data: serverItems = [], isLoading } = useQuery<GroundScanItem[]>({
    queryKey: ["/api/factory/ground-scan-items", selectedLocationId],
    queryFn: () =>
      fetch(`/api/factory/ground-scan-items?locationId=${selectedLocationId}`, { credentials: "include" }).then((r) =>
        r.json()
      ),
    staleTime: 10_000,
    refetchInterval: visibleTabInterval(30_000),
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

  async function handleScan() {
    const value = scanInput.trim().toUpperCase();
    if (!value) return;

    const duplicate = serverItems.find((b) => b.reference_number === value);
    if (duplicate) {
      setScanError(`Already scanned: ${value}`);
      toast({ title: "Duplicate scan", description: `${value} is already in the list.`, variant: "destructive" });
      setScanInput("");
      return;
    }

    setScanError("");
    setScanning(true);

    try {
      const res = await fetch(`/api/lookup/reference/${encodeURIComponent(value)}`, { credentials: "include" });

      if (!res.ok) {
        if (res.status === 404) {
          setScanError(`Not found: ${value}`);
          toast({
            title: "Bale not found",
            description: `No bale with ref code "${value}" found.`,
            variant: "destructive",
          });
        } else {
          setScanError("Lookup failed — try again");
        }
        setScanInput("");
        return;
      }

      const data = await res.json();
      const baleInfo = data.baleInfo;
      const product = data.product;
      const labelPrint = data.labelPrint;

      const articleCode = product?.articleCode || labelPrint?.articleCode || baleInfo?.articleCode || "";
      const productName = baleInfo?.productName || product?.name || "Unknown";
      const weightKg = parseFloat(baleInfo?.weightKg || labelPrint?.approxWeightKg || "0");
      const status = baleInfo?.status || "";
      const isInLoadingOrder = baleInfo?.isInLoadingOrder === true;

      const saveRes = await apiRequest("POST", "/api/factory/ground-scan-items", {
        locationId: selectedLocationId,
        referenceNumber: value,
        articleCode,
        productName,
        weightKg,
        status,
        isInLoadingOrder,
      });

      if (!saveRes.ok) {
        const err = await saveRes.json();
        if (saveRes.status === 409) {
          setScanError(`Already scanned: ${value}`);
          toast({ title: "Duplicate scan", description: `${value} is already in the list.`, variant: "destructive" });
        } else {
          toast({ title: "Save failed", description: err.message, variant: "destructive" });
        }
        setScanInput("");
        return;
      }

      setScanInput("");
      setScanError("");
      toast({ title: "Bale scanned", description: `${productName} — ${status}` });
      invalidate();
    } catch {
      setScanError("Network error — try again");
    } finally {
      setScanning(false);
      setTimeout(() => scanRef.current?.focus(), 50);
    }
  }

  async function handleMigrateUpload() {
    if (localBales.length === 0) return;
    setUploading(true);
    try {
      const res = await apiRequest("POST", "/api/factory/ground-scan-items/bulk", {
        locationId: selectedLocationId,
        items: localBales,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { inserted, skipped } = await res.json();
      localStorage.removeItem(STORAGE_KEY);
      setLocalBales([]);
      invalidate();
      toast({
        title: "Upload complete",
        description: `${inserted} bales uploaded${skipped > 0 ? `, ${skipped} skipped (duplicates)` : ""}.`,
      });
    } catch (e) {
      toast({ title: "Upload failed", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  function handleMigrateDiscard() {
    localStorage.removeItem(STORAGE_KEY);
    setLocalBales([]);
    toast({ title: "Local scans discarded", description: "Your locally stored scans have been cleared." });
  }

  async function exportExcel() {
    if (scannedBales.length === 0) return;
    setExporting(true);
    try {
      const locParam = selectedLocationId && selectedLocationId !== "all" ? `?locationId=${selectedLocationId}` : "";
      const res = await fetch(`/api/factory/stock-entry/in-stock${locParam}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch system stock");
      const allFetched: {
        referenceNumber: string;
        articleCode: string;
        productName?: string;
        weightKg: string;
        isInLoadingOrder?: boolean;
        stockEntryDate?: string | null;
        workerName?: string | null;
      }[] = await res.json();
      const systemBales = allFetched.filter((b) => !b.isInLoadingOrder);

      const scannedRefs = new Set(scannedBales.map((b) => b.refCode.toUpperCase()));
      const systemRefs = new Set(systemBales.map((b) => (b.referenceNumber || "").toUpperCase()));

      type ArticleRow = {
        articleCode: string;
        productName: string;
        systemQty: number;
        systemWt: number;
        scannedQty: number;
        scannedWt: number;
      };
      const articleMap = new Map<string, ArticleRow>();
      const ensure = (key: string, name: string) => {
        if (!articleMap.has(key))
          articleMap.set(key, {
            articleCode: key,
            productName: name,
            systemQty: 0,
            systemWt: 0,
            scannedQty: 0,
            scannedWt: 0,
          });
        return articleMap.get(key)!;
      };
      for (const b of systemBales) {
        const r = ensure(b.articleCode || "UNKNOWN", b.productName || "");
        r.systemQty++;
        r.systemWt += parseFloat(b.weightKg || "0");
      }
      for (const b of scannedBales) {
        const r = ensure(b.articleCode || "UNKNOWN", b.productName || "");
        r.scannedQty++;
        r.scannedWt += b.weightKg;
      }

      const missingBales = systemBales.filter((b) => !scannedRefs.has((b.referenceNumber || "").toUpperCase()));
      const extraBales = scannedBales.filter((b) => !systemRefs.has(b.refCode.toUpperCase()));
      const totalSystemWt = systemBales.reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0);
      const totalMissingWt = missingBales.reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0);
      const summaryArticles = [...articleMap.values()].sort((a, b) => a.articleCode.localeCompare(b.articleCode));

      const dateStr = new Date().toISOString().slice(0, 10);
      const timeStr = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

      const { ExcelJS } = XLSX;
      const wb = new ExcelJS.Workbook();
      wb.creator = "HMD ERP";
      wb.created = new Date();

      const NAVY = "FF1B2A4A";
      const BLUE = "FF2D5A8E";
      const GREEN = "FF1A7A3C";
      const LGREEN = "FFD4EDDA";
      const RED = "FFC0392B";
      const LRED = "FFFCE8E8";
      const AMBER = "FFB7860B";
      const LAMBER = "FFFEF3CD";
      const GRAY = "FF6C757D";
      const LGRAY = "FFF5F7FA";
      const WHITE = "FFFFFFFF";
      const BLACK = "FF1A1A1A";
      const TOTALBG = "FFE8F0F8";

      const solidFill = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } });
      const thinBorder = { style: "thin" as const, color: { argb: "FFD0D7E0" } };
      const allBorders = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };

      const styleHeader = (row: Row, bgArgb: string) => {
        row.font = { bold: true, color: { argb: WHITE }, size: 10, name: "Calibri" };
        row.fill = solidFill(bgArgb);
        row.alignment = { vertical: "middle" as const, horizontal: "center" as const, wrapText: false };
        row.height = 22;
        row.eachCell((cell: Cell) => {
          cell.border = allBorders;
        });
      };

      const styleDataRow = (row: Row, even: boolean, highlight?: { argb: string }) => {
        const bg = highlight ? highlight.argb : even ? LGRAY : WHITE;
        row.fill = solidFill(bg);
        row.font = { size: 10, name: "Calibri", color: { argb: BLACK } };
        row.height = 18;
        row.eachCell({ includeEmpty: true }, (cell: Cell) => {
          cell.border = allBorders;
        });
      };

      const styleTotals = (row: Row) => {
        row.fill = solidFill(TOTALBG);
        row.font = { bold: true, size: 10, name: "Calibri", color: { argb: NAVY } };
        row.height = 20;
        row.eachCell({ includeEmpty: true }, (cell: Cell) => {
          cell.border = {
            ...allBorders,
            top: { style: "medium" as const, color: { argb: NAVY } },
            bottom: { style: "medium" as const, color: { argb: NAVY } },
          };
        });
      };

      // ══ Sheet 1 — Summary ══════════════════════════════════════════════════
      const ws1 = wb.addWorksheet("Summary");
      ws1.columns = [
        { key: "a", width: 18 },
        { key: "b", width: 34 },
        { key: "c", width: 14 },
        { key: "d", width: 17 },
        { key: "e", width: 14 },
        { key: "f", width: 17 },
        { key: "g", width: 14 },
        { key: "h", width: 17 },
      ];

      const locationLabel =
        selectedLocationId !== "all"
          ? (stockLocations?.find((l) => String(l.id) === selectedLocationId)?.name ?? `Location ${selectedLocationId}`)
          : "All Locations";

      ws1.addRow([`Ground Stock Verification Report — ${locationLabel}`]);
      const titleRow = ws1.lastRow!;
      titleRow.height = 30;
      titleRow.getCell(1).font = { bold: true, size: 16, name: "Calibri", color: { argb: NAVY } };
      titleRow.getCell(1).alignment = { vertical: "middle" };
      ws1.mergeCells("A1:H1");

      ws1.addRow([`Date: ${dateStr}   Time: ${timeStr}   |   Location: ${locationLabel}`]);
      const subRow = ws1.lastRow!;
      subRow.height = 16;
      subRow.getCell(1).font = { size: 10, name: "Calibri", color: { argb: GRAY } };
      subRow.getCell(1).alignment = { vertical: "middle" };
      ws1.mergeCells("A2:H2");

      ws1.addRow([]);

      const stats = [
        { label: "System (IN STOCK)", value: systemBales.length, color: BLUE },
        { label: "Scanned on Ground", value: scannedBales.length, color: GREEN },
        { label: "Missing Bales", value: missingBales.length, color: missingBales.length > 0 ? RED : GRAY },
        { label: "Extra Bales", value: extraBales.length, color: extraBales.length > 0 ? AMBER : GRAY },
      ];
      const statLabelRow = ws1.addRow(stats.map((s) => s.label));
      statLabelRow.height = 18;
      stats.forEach((s, i) => {
        const cell = statLabelRow.getCell(i * 2 + 1);
        cell.font = { bold: true, size: 9, color: { argb: WHITE }, name: "Calibri" };
        cell.fill = solidFill(s.color);
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = allBorders;
        if (i < 3) ws1.mergeCells(statLabelRow.number, i * 2 + 1, statLabelRow.number, i * 2 + 2);
        else ws1.mergeCells(statLabelRow.number, 7, statLabelRow.number, 8);
      });
      const statValueRow = ws1.addRow(stats.map((s) => s.value));
      statValueRow.height = 26;
      stats.forEach((s, i) => {
        const cell = statValueRow.getCell(i * 2 + 1);
        cell.font = { bold: true, size: 18, color: { argb: s.color }, name: "Calibri" };
        cell.fill = solidFill(WHITE);
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = allBorders;
        if (i < 3) ws1.mergeCells(statValueRow.number, i * 2 + 1, statValueRow.number, i * 2 + 2);
        else ws1.mergeCells(statValueRow.number, 7, statValueRow.number, 8);
      });

      ws1.addRow([]);

      const artHdrRow = ws1.addRow([
        "Article Code",
        "Product Name",
        "System Qty",
        "System Wt (kg)",
        "Scanned Qty",
        "Scanned Wt (kg)",
        "Missing Qty",
        "Missing Wt (kg)",
      ]);
      styleHeader(artHdrRow, NAVY);
      artHdrRow.eachCell((cell, col) => {
        if (col >= 3) cell.alignment = { horizontal: "center", vertical: "middle" };
      });

      summaryArticles.forEach((r, idx) => {
        const missingQty = Math.max(0, r.systemQty - r.scannedQty);
        const missingWt = missingBales
          .filter((b) => (b.articleCode || "UNKNOWN") === r.articleCode)
          .reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0);
        const hasMissing = missingQty > 0;
        const dataRow = ws1.addRow([
          r.articleCode,
          r.productName,
          r.systemQty,
          +r.systemWt.toFixed(3),
          r.scannedQty,
          +r.scannedWt.toFixed(3),
          missingQty,
          +missingWt.toFixed(3),
        ]);
        styleDataRow(dataRow, idx % 2 === 0, hasMissing ? { argb: LRED } : undefined);
        [3, 4, 5, 6, 7, 8].forEach((col) => {
          const cell = dataRow.getCell(col);
          cell.alignment = { horizontal: "right", vertical: "middle" };
          if (col % 2 === 0) cell.numFmt = "#,##0.000";
        });
        if (hasMissing) {
          dataRow.getCell(7).font = { bold: true, color: { argb: RED }, size: 10, name: "Calibri" };
          dataRow.getCell(8).font = { bold: true, color: { argb: RED }, size: 10, name: "Calibri" };
        }
      });

      const totalsRow = ws1.addRow([
        "TOTAL",
        "",
        systemBales.length,
        +totalSystemWt.toFixed(3),
        scannedBales.length,
        +totalWeight.toFixed(3),
        missingBales.length,
        +totalMissingWt.toFixed(3),
      ]);
      styleTotals(totalsRow);
      [3, 4, 5, 6, 7, 8].forEach((col) => {
        const cell = totalsRow.getCell(col);
        cell.alignment = { horizontal: "right", vertical: "middle" };
        if (col % 2 === 0) cell.numFmt = "#,##0.000";
      });
      if (missingBales.length > 0) {
        totalsRow.getCell(7).font = { bold: true, color: { argb: RED }, size: 10, name: "Calibri" };
        totalsRow.getCell(8).font = { bold: true, color: { argb: RED }, size: 10, name: "Calibri" };
      }
      ws1.views = [{ state: "frozen", xSplit: 0, ySplit: 7 }];

      // ══ Sheet 2 — Missing Bales ════════════════════════════════════════════
      const ws2 = wb.addWorksheet("Missing Bales");
      ws2.columns = [
        { key: "a", width: 20 },
        { key: "b", width: 18 },
        { key: "c", width: 36 },
        { key: "d", width: 15 },
        { key: "e", width: 16 },
        { key: "f", width: 22 },
      ];
      ws2.addRow(["Missing Bales"]);
      const m_titleRow = ws2.lastRow!;
      m_titleRow.height = 28;
      m_titleRow.getCell(1).font = { bold: true, size: 15, name: "Calibri", color: { argb: RED } };
      m_titleRow.getCell(1).alignment = { vertical: "middle" };
      ws2.mergeCells("A1:F1");

      ws2.addRow([`Bales recorded IN_STOCK in the system but not found during ground scan  —  ${dateStr}`]);
      const m_sub = ws2.lastRow!;
      m_sub.height = 16;
      m_sub.getCell(1).font = { size: 9, name: "Calibri", color: { argb: GRAY } };
      ws2.mergeCells("A2:F2");
      ws2.addRow([]);

      const m_hdrRow = ws2.addRow([
        "Reference Number",
        "Article Code",
        "Product Name",
        "Weight (kg)",
        "Date Produced",
        "Worker",
      ]);
      styleHeader(m_hdrRow, RED);
      m_hdrRow.getCell(4).alignment = { horizontal: "right", vertical: "middle" };

      if (missingBales.length === 0) {
        const emptyRow = ws2.addRow(["No missing bales — all system bales were found on the ground."]);
        emptyRow.getCell(1).font = { italic: true, color: { argb: GREEN }, name: "Calibri", size: 10 };
        emptyRow.getCell(1).fill = solidFill(LGREEN);
        ws2.mergeCells(`A${emptyRow.number}:F${emptyRow.number}`);
      } else {
        missingBales.forEach((b, idx) => {
          const dr = ws2.addRow([
            b.referenceNumber,
            b.articleCode || "—",
            b.productName || "—",
            +parseFloat(b.weightKg || "0").toFixed(3),
            b.stockEntryDate || "—",
            b.workerName || "—",
          ]);
          styleDataRow(dr, idx % 2 === 0, { argb: idx % 2 === 0 ? LRED : "FFFDF0F0" });
          dr.getCell(1).font = { name: "Courier New", size: 10, color: { argb: BLACK } };
          dr.getCell(4).alignment = { horizontal: "right", vertical: "middle" };
          dr.getCell(4).numFmt = "#,##0.000";
        });
      }

      ws2.addRow([]);
      const m_totRow = ws2.addRow([
        `Total missing: ${missingBales.length} bales`,
        "",
        "",
        +totalMissingWt.toFixed(3),
        "",
        "",
      ]);
      styleTotals(m_totRow);
      m_totRow.getCell(4).alignment = { horizontal: "right", vertical: "middle" };
      m_totRow.getCell(4).numFmt = "#,##0.000";
      ws2.mergeCells(`A${m_totRow.number}:C${m_totRow.number}`);
      ws2.views = [{ state: "frozen", xSplit: 0, ySplit: 4 }];

      // ══ Sheet 3 — Extra Bales (if any) ════════════════════════════════════
      if (extraBales.length > 0) {
        const ws3 = wb.addWorksheet("Extra Bales");
        ws3.columns = [
          { key: "a", width: 20 },
          { key: "b", width: 18 },
          { key: "c", width: 36 },
          { key: "d", width: 15 },
          { key: "e", width: 18 },
          { key: "f", width: 16 },
          { key: "g", width: 22 },
        ];
        ws3.addRow(["Extra Bales"]);
        const e_titleRow = ws3.lastRow!;
        e_titleRow.height = 28;
        e_titleRow.getCell(1).font = { bold: true, size: 15, name: "Calibri", color: { argb: AMBER } };
        ws3.mergeCells("A1:G1");

        ws3.addRow([`Bales scanned on ground that are NOT recorded as IN_STOCK in the system  —  ${dateStr}`]);
        const e_sub = ws3.lastRow!;
        e_sub.height = 16;
        e_sub.getCell(1).font = { size: 9, name: "Calibri", color: { argb: GRAY } };
        ws3.mergeCells("A2:G2");
        ws3.addRow([]);

        const e_hdrRow = ws3.addRow([
          "Ref Code",
          "Article Code",
          "Product Name",
          "Weight (kg)",
          "Status",
          "Date Produced",
          "Worker",
        ]);
        styleHeader(e_hdrRow, BLUE);
        e_hdrRow.getCell(4).alignment = { horizontal: "right", vertical: "middle" };

        extraBales.forEach((b, idx) => {
          const dr = ws3.addRow([
            b.refCode,
            b.articleCode || "—",
            b.productName || "—",
            +b.weightKg.toFixed(3),
            b.status,
            b.dateBaleProduced || "—",
            b.workerName || "—",
          ]);
          styleDataRow(dr, idx % 2 === 0, { argb: idx % 2 === 0 ? LAMBER : "FFFDF8E1" });
          dr.getCell(1).font = { name: "Courier New", size: 10, color: { argb: BLACK } };
          dr.getCell(4).alignment = { horizontal: "right", vertical: "middle" };
          dr.getCell(4).numFmt = "#,##0.000";
        });
        ws3.views = [{ state: "frozen", xSplit: 0, ySplit: 4 }];
      }

      await XLSX.writeFile(wb, `ground-verification-${dateStr}.xlsx`);
    } catch (err) {
      toast({ title: "Export failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ── Migration banner ── */}
      {hasMigrationData && (
        <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <ServerCrash className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              You have {localBales.length} locally stored scan{localBales.length !== 1 ? "s" : ""} from a previous
              session
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Upload them so the whole team can see them, or discard them.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              onClick={handleMigrateUpload}
              disabled={uploading}
              data-testid="button-ground-scan-upload-local"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Upload className="h-4 w-4 mr-1" />}
              {uploading ? "Uploading…" : "Upload Now"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleMigrateDiscard}
              data-testid="button-ground-scan-discard-local"
            >
              Discard
            </Button>
          </div>
        </div>
      )}

      {/* ── Location selector ── */}
      <div className="flex items-center gap-2 text-sm flex-wrap">
        <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground shrink-0">Scanning location:</span>
        <Select
          value={selectedLocationId}
          onValueChange={setSelectedLocationId}
          data-testid="select-ground-scan-location"
        >
          <SelectTrigger className="w-60" data-testid="trigger-ground-scan-location">
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

      {/* ── Scan bar ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex-1 flex flex-col gap-2">
          <div className="relative">
            <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={scanRef}
              value={scanInput}
              onChange={(e) => {
                setScanInput(e.target.value);
                setScanError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && handleScan()}
              placeholder="Scan ref code / barcode..."
              className="pl-9"
              disabled={scanning}
              data-testid="input-ground-scan"
              autoComplete="off"
            />
          </div>
          {scanError && (
            <div className="flex items-center gap-2 text-destructive text-sm" data-testid="text-ground-scan-error">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {scanError}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            onClick={handleScan}
            disabled={scanning || !scanInput.trim()}
            data-testid="button-ground-scan-confirm"
          >
            {scanning ? "Looking up..." : "Scan"}
          </Button>
          <Button
            variant="outline"
            onClick={exportExcel}
            disabled={scannedBales.length === 0 || exporting}
            data-testid="button-ground-scan-export"
          >
            {exporting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
            {exporting ? "Exporting..." : "Export Verification"}
          </Button>
          {scannedBales.length > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" data-testid="button-ground-scan-clear">
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  Clear
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear all scans?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove all {scannedBales.length} scanned bales from the shared list for everyone. This
                    cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => clearMutation.mutate()}>Clear All</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* ── Stats ── */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span data-testid="text-ground-scan-count">
            <span className="font-semibold text-foreground">{scannedBales.length}</span> bale
            {scannedBales.length !== 1 ? "s" : ""} scanned
          </span>
          <span data-testid="text-ground-scan-weight">
            <span className="font-semibold text-foreground">{formatNumber(totalWeight, 2)} kg</span> total weight
          </span>
          {isLoading && <span className="text-xs text-muted-foreground">Syncing…</span>}
        </div>
      </div>

      {/* ── Table ── */}
      {scannedBales.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
          <Package className="h-10 w-10 opacity-30" />
          <p className="text-sm">Scan a bale to add it to the list</p>
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Ref Code</TableHead>
                <TableHead>Article Code</TableHead>
                <TableHead>Product Name</TableHead>
                <TableHead className="text-right">Weight (kg)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date Produced</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {scannedBales.map((bale, idx) => (
                <TableRow key={bale.refCode} data-testid={`row-ground-scan-${bale.refCode}`}>
                  <TableCell className="text-muted-foreground text-xs">{scannedBales.length - idx}</TableCell>
                  <TableCell className="font-mono text-sm" data-testid={`text-ground-scan-ref-${bale.refCode}`}>
                    {bale.refCode}
                  </TableCell>
                  <TableCell data-testid={`text-ground-scan-article-${bale.refCode}`}>
                    {bale.articleCode ? (
                      <Badge variant="outline">{bale.articleCode}</Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell data-testid={`text-ground-scan-product-${bale.refCode}`}>{bale.productName}</TableCell>
                  <TableCell className="text-right font-mono" data-testid={`text-ground-scan-weight-${bale.refCode}`}>
                    {formatNumber(bale.weightKg, 2)}
                  </TableCell>
                  <TableCell data-testid={`text-ground-scan-status-${bale.refCode}`}>
                    <StatusBadge status={bale.status} isInLoadingOrder={bale.isInLoadingOrder} />
                  </TableCell>
                  <TableCell
                    className="text-sm text-muted-foreground"
                    data-testid={`text-ground-scan-date-produced-${bale.refCode}`}
                  >
                    {bale.dateBaleProduced ? (
                      (() => {
                        const [y, m, d] = bale.dateBaleProduced.split("-");
                        return `${d}/${m}/${y}`;
                      })()
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell
                    className="text-sm text-muted-foreground"
                    data-testid={`text-ground-scan-worker-${bale.refCode}`}
                  >
                    {bale.workerName ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        const item = serverItems.find((i) => i.reference_number === bale.refCode);
                        if (item) removeMutation.mutate(item.id);
                      }}
                      disabled={removeMutation.isPending}
                      data-testid={`button-ground-scan-remove-${bale.refCode}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
