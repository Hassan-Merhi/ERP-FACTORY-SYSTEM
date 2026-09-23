import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  ScanLine,
  X,
  Download,
  Loader2,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatNumber } from "@/lib/formatNumber";
import { visibleTabInterval } from "@/lib/queryPolicies";
import * as XLSX from "@/lib/excelHelper";

function toLocalDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return toLocalDateStr(d);
}

function formatDisplay(dateStr: string): string {
  const [y, m, day] = dateStr.split("-");
  return `${day}/${m}/${y}`;
}

interface DayBale {
  id: number;
  reference_number: string;
  article_code: string | null;
  product_name: string | null;
  weight_kg: string | null;
  status: string;
  is_in_loading_order: boolean;
  is_deleted: boolean;
  date_bale_produced: string | null;
  worker_name: string | null;
  scan_id: number | null;
  scanned_at: string | null;
}

interface SavedScan {
  id: number;
  scan_date: string;
  reference_number: string;
  scanned_at: string;
}

function StatusBadge({
  status,
  isInLoadingOrder,
  isDeleted,
}: {
  status: string;
  isInLoadingOrder: boolean;
  isDeleted: boolean;
}) {
  if (isDeleted) return <Badge className="bg-red-600 text-white border-0">Deleted</Badge>;
  const s = (status || "").toUpperCase();
  if (isInLoadingOrder || s === "LOADING" || s === "LOADED")
    return <Badge className="bg-amber-500 text-white border-0">Pending Loading</Badge>;
  if (s === "IN_STOCK") return <Badge className="bg-green-600 text-white border-0">In Stock</Badge>;
  if (s === "SOLD") return <Badge className="bg-red-600 text-white border-0">Sold</Badge>;
  if (s === "RESERVED_FOR_ORDER") return <Badge className="bg-blue-600 text-white border-0">Reserved</Badge>;
  return <Badge variant="outline">{status || "—"}</Badge>;
}

interface ScanFeedback {
  type: "success" | "error" | "warn";
  refCode: string;
  productName?: string | null;
  articleCode?: string | null;
  message: string;
}

export default function DailyScan() {
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
  const unscanned = dayBales.filter((b) => b.scan_id == null);
  const scanned = dayBales.filter((b) => b.scan_id != null);

  const totalBales = dayBales.length;
  const totalKg = dayBales.reduce((s, b) => s + parseFloat(b.weight_kg || "0"), 0);
  const scannedKg = scanned.reduce((s, b) => s + parseFloat(b.weight_kg || "0"), 0);
  const allDone = totalBales > 0 && unscanned.length === 0;

  const handleScan = async () => {
    const ref = scanInput.trim().toUpperCase();
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

    await XLSX.writeFile(wb, `daily-scan-${selectedDate}.xlsx`);
  };

  return (
    <div className="space-y-4 pt-4 relative">
      {/* ── Date navigation ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="outline"
          size="icon"
          onClick={() => setSelectedDate(addDays(selectedDate, -1))}
          data-testid="button-daily-scan-prev-day"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <div className="flex items-center gap-1.5 border rounded-md px-2 py-1">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <input
            type="date"
            value={selectedDate}
            max={today}
            onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
            className="bg-transparent text-sm font-medium outline-none"
            data-testid="input-daily-scan-date"
          />
        </div>

        <Button
          variant="outline"
          size="icon"
          onClick={() => setSelectedDate(addDays(selectedDate, 1))}
          disabled={isToday}
          data-testid="button-daily-scan-next-day"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        {!isToday && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedDate(today)}
            data-testid="button-daily-scan-today"
          >
            Back to Today
          </Button>
        )}

        <div className="ml-auto flex items-center gap-3 flex-wrap">
          {!isLoading && totalBales > 0 && (
            <span className="text-sm text-muted-foreground" data-testid="text-daily-scan-summary">
              {scanned.length}/{totalBales} verified · {formatNumber(scannedKg)}/{formatNumber(totalKg)} kg
            </span>
          )}
          <Button variant="outline" size="sm" onClick={handleExport} data-testid="button-daily-scan-export">
            <Download className="h-4 w-4 mr-1" />
            Export
          </Button>
        </div>
      </div>

      {/* ── Scan input ── */}
      <div className="flex gap-2">
        <Input
          ref={scanRef}
          value={scanInput}
          onChange={(e) => setScanInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleScan()}
          placeholder="Scan bale ref code / barcode…"
          className="font-mono"
          data-testid="input-daily-scan-ref"
          disabled={scanning}
        />
        <Button onClick={handleScan} disabled={scanning || !scanInput.trim()} data-testid="button-daily-scan-submit">
          {scanning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <ScanLine className="h-4 w-4 mr-1" />
              Scan
            </>
          )}
        </Button>
      </div>

      {/* ── Body ── */}
      {isLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
      ) : totalBales === 0 ? (
        <div className="py-14 text-center text-sm text-muted-foreground">
          No bales produced on {formatDisplay(selectedDate)}
        </div>
      ) : (
        <div className="space-y-4">
          {/* ── All-done banner ── */}
          {allDone && (
            <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/40 px-4 py-3 text-sm text-green-800 dark:text-green-300">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              All {totalBales} bales verified for {formatDisplay(selectedDate)}
            </div>
          )}

          {/* ── Unscanned section (top) ── */}
          {unscanned.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />
                <span className="text-sm font-medium">
                  Unverified — {unscanned.length} bale{unscanned.length !== 1 ? "s" : ""} remaining
                </span>
              </div>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>Ref Code</TableHead>
                      <TableHead>Article Code</TableHead>
                      <TableHead>Product Name</TableHead>
                      <TableHead className="text-right">Weight (kg)</TableHead>
                      <TableHead>Date Produced</TableHead>
                      <TableHead>Worker</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {unscanned.map((b, i) => (
                      <TableRow key={b.id} data-testid={`row-unscanned-bale-${b.id}`}>
                        <TableCell className="text-muted-foreground text-sm">{i + 1}</TableCell>
                        <TableCell className="font-mono font-medium">{b.reference_number}</TableCell>
                        <TableCell className="text-sm">
                          {b.article_code ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-sm">
                          {b.product_name ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {b.weight_kg ? (
                            formatNumber(parseFloat(b.weight_kg))
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {b.date_bale_produced ? (
                            (() => {
                              const [y, m, d] = b.date_bale_produced.split("-");
                              return `${d}/${m}/${y}`;
                            })()
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {b.worker_name ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            status={b.status}
                            isInLoadingOrder={b.is_in_loading_order}
                            isDeleted={b.is_deleted}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          {/* ── Scanned section (bottom, collapsible) ── */}
          {scanned.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowScanned((v) => !v)}
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                data-testid="button-toggle-scanned-section"
              >
                {showScanned ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                Scanned — {scanned.length} bale{scanned.length !== 1 ? "s" : ""} · {formatNumber(scannedKg)} kg
              </button>

              {showScanned && (
                <div className="rounded-md border opacity-80 overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Ref Code</TableHead>
                        <TableHead>Article Code</TableHead>
                        <TableHead>Product Name</TableHead>
                        <TableHead className="text-right">Weight (kg)</TableHead>
                        <TableHead>Date Produced</TableHead>
                        <TableHead>Worker</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Scanned At</TableHead>
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {scanned.map((b, i) => {
                        const scanRow = scannedRefMap.get(b.reference_number)!;
                        return (
                          <TableRow key={b.id} data-testid={`row-scanned-bale-${b.id}`}>
                            <TableCell className="text-muted-foreground text-sm">{i + 1}</TableCell>
                            <TableCell className="font-mono font-medium text-muted-foreground">
                              {b.reference_number}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{b.article_code ?? "—"}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{b.product_name ?? "—"}</TableCell>
                            <TableCell className="text-right font-mono text-sm text-muted-foreground">
                              {b.weight_kg ? formatNumber(parseFloat(b.weight_kg)) : "—"}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {b.date_bale_produced
                                ? (() => {
                                    const [y, m, d] = b.date_bale_produced.split("-");
                                    return `${d}/${m}/${y}`;
                                  })()
                                : "—"}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{b.worker_name ?? "—"}</TableCell>
                            <TableCell>
                              <StatusBadge
                                status={b.status}
                                isInLoadingOrder={b.is_in_loading_order}
                                isDeleted={b.is_deleted}
                              />
                            </TableCell>
                            <TableCell className="text-right text-sm text-muted-foreground">
                              {new Date(scanRow.scanned_at).toLocaleTimeString("en-GB")}
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => removeMutation.mutate(scanRow.id)}
                                disabled={removeMutation.isPending}
                                data-testid={`button-remove-scan-${scanRow.id}`}
                              >
                                <X className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Scan feedback panel (bottom-right) ── */}
      {lastScan && (
        <div
          className={`fixed bottom-6 right-6 z-50 flex items-start gap-3 rounded-md border px-4 py-3 shadow-lg w-72
            ${
              lastScan.type === "success"
                ? "bg-green-50 border-green-200 dark:bg-green-950/60 dark:border-green-800"
                : lastScan.type === "warn"
                  ? "bg-amber-50 border-amber-200 dark:bg-amber-950/60 dark:border-amber-800"
                  : "bg-red-50 border-red-200 dark:bg-red-950/60 dark:border-red-800"
            }`}
          data-testid="panel-scan-feedback"
        >
          <div className="mt-0.5 shrink-0">
            {lastScan.type === "success" ? (
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
            ) : lastScan.type === "warn" ? (
              <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            ) : (
              <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p
              className={`text-sm font-semibold font-mono truncate
              ${
                lastScan.type === "success"
                  ? "text-green-900 dark:text-green-200"
                  : lastScan.type === "warn"
                    ? "text-amber-900 dark:text-amber-200"
                    : "text-red-900 dark:text-red-200"
              }`}
            >
              {lastScan.refCode}
            </p>
            {(lastScan.articleCode || lastScan.productName) && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {[lastScan.articleCode, lastScan.productName].filter(Boolean).join(" · ")}
              </p>
            )}
            <p
              className={`text-xs mt-0.5
              ${
                lastScan.type === "success"
                  ? "text-green-700 dark:text-green-300"
                  : lastScan.type === "warn"
                    ? "text-amber-700 dark:text-amber-300"
                    : "text-red-700 dark:text-red-300"
              }`}
            >
              {lastScan.message}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setLastScan(null)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            data-testid="button-scan-feedback-dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
