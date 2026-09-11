import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingDown, TrendingUp, Minus, RefreshCw, Printer, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";

import type { StatementResponse, StatementRow, Transporter } from "./transporterstatement/types";
import { fmtAmt, fmtNum, monthAgo, today } from "./transporterstatement/utils";
import { StatusBadge } from "./transporterstatement/components/StatusBadge";
import { DueDateCell } from "./transporterstatement/components/DueDateCell";
import { SettingsPopover } from "./transporterstatement/components/SettingsPopover";
// ─── Types ───────────────────────────────────────────────────────────────────

export default function TransporterStatement({ embedded }: { embedded?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { formatDisplayDate: formatDate } = useDateFormat();

  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [dateFrom, setDateFrom] = useState(monthAgo());
  const [dateTo, setDateTo] = useState(today());

  // Load Loans accounts
  const { data: transporters = [], isLoading: loadingTransporters } = useQuery<Transporter[]>({
    queryKey: ["/api/transporter-statement/transporters"],
  });

  // Load statement
  const {
    data: statement,
    isLoading: loadingStatement,
    isFetching,
    isError: statementError,
    error: statementErrorObj,
  } = useQuery<StatementResponse>({
    queryKey: ["/api/transporter-statement", selectedAccountId, "statement", dateFrom, dateTo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      const r = await fetch(`/api/transporter-statement/${selectedAccountId}/statement?${params}`, {
        credentials: "include",
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.message ?? `Server error ${r.status}`);
      }
      return r.json();
    },
    enabled: !!selectedAccountId,
  });

  // Settings mutation callback
  function handleSettingsSaved() {
    queryClient.invalidateQueries({
      queryKey: ["/api/transporter-statement", selectedAccountId, "statement"],
    });
  }

  // Due date mutation
  const dueDateMutation = useMutation({
    mutationFn: ({ entryId, dueDate }: { entryId: number; dueDate: string | null }) =>
      apiRequest("PUT", `/api/transporter-entry-due-dates/${entryId}`, { dueDate }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/transporter-statement", selectedAccountId, "statement"],
      });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Failed to save due date", description: err?.message, variant: "destructive" });
    },
  });

  function handleDueDateSave(entryId: number, dueDate: string | null) {
    dueDateMutation.mutate({ entryId, dueDate });
  }

  const [waSending, setWaSending] = useState(false);
  const [pdfExporting, setPdfExporting] = useState(false);

  // Summary stats — must be declared before buildCapture (used in its dep array)
  const stats = useMemo(() => {
    if (!statement) return null;
    let totalDebit = 0;
    let totalCredit = 0;
    let totalPaid = 0;
    let overdueCount = 0;
    const now = today();
    for (const r of statement.rows ?? []) {
      totalDebit += parseFloat(r.debit || "0");
      totalCredit += parseFloat(r.credit || "0");
      totalPaid += parseFloat(r.paidAmount || "0");
      if (r.dateToBePaid && r.dateToBePaid < now && r.status && r.status !== "paid") {
        overdueCount++;
      }
    }
    return { totalDebit, totalCredit, totalPaid, overdueCount };
  }, [statement]);

  const selectedTransporter = transporters.find((t) => String(t.id) === selectedAccountId);

  // Build an off-screen, light-themed HTML card for capture
  const buildCapture = useCallback(() => {
    if (!statement || !selectedTransporter) return null;

    const esc = (s: unknown) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const fmt = (v: string | null | undefined) => {
      if (!v) return "—";
      const n = parseFloat(v);
      if (isNaN(n)) return "—";
      return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const fmtAmt2 = (v: string | null) => {
      if (!v) return "";
      const n = parseFloat(v);
      if (isNaN(n) || n === 0) return "";
      return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const periodStr = [dateFrom, dateTo].filter(Boolean).join(" → ") || "All time";
    const closingBal = parseFloat(statement.closingBalance ?? "0");
    const closingSide = closingBal > 0 ? " Cr" : closingBal < 0 ? " Dr" : "";

    const th = (align = "left") =>
      `padding:6px 9px;font-size:11px;font-weight:700;text-align:${align};` +
      `background:#0d7c66;color:#ffffff;border:1px solid rgba(0,0,0,0.15);white-space:nowrap;`;

    const td = (align = "left", color = "#111827", bold = false) =>
      `font-size:11px;padding:5px 9px;text-align:${align};color:${color};` +
      `font-weight:${bold ? "700" : "400"};border:1px solid #e5e7eb;white-space:nowrap;`;

    const statusLabel = (row: StatementRow) => {
      if (row.status === "paid") return `<span style="color:#059669;font-weight:600">Paid</span>`;
      if (row.status === "partial") {
        const rem = parseFloat(row.credit || "0") - parseFloat(row.paidAmount || "0");
        return `<span style="color:#b45309;font-weight:600">Partial · ${fmtAmt2(rem.toFixed(2))} left</span>`;
      }
      return `<span style="color:#dc2626;font-weight:600">Unpaid</span>`;
    };

    const openBal = parseFloat(statement.openingBalance ?? "0");

    let rowsHtml = `<tr style="background:#f9fafb">
      <td style="${td()};color:#6b7280;font-style:italic"></td>
      <td style="${td()};color:#6b7280;font-style:italic">Opening Balance</td>
      <td style="${td()}"></td><td style="${td()}"></td><td style="${td()}"></td>
      <td style="${td("right", "#374151", true)}">${fmt(String(openBal))}</td>
      <td style="${td()}"></td><td style="${td()}"></td>
    </tr>`;

    statement.rows.forEach((row, i) => {
      const bal = parseFloat(row.runningBalance);
      const balColor = bal > 0 ? "#b45309" : bal < 0 ? "#059669" : "#6b7280";
      const bg = i % 2 === 0 ? "#ffffff" : "#f0faf8";
      const isOverdue = row.dateToBePaid && row.dateToBePaid < today() && row.status !== "paid";
      const rowBg = isOverdue ? "#fff1f2" : bg;
      rowsHtml += `<tr style="background:${rowBg}">
        <td style="${td()};font-family:monospace">${esc(row.date)}</td>
        <td style="${td()};max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(row.description || row.narration || row.voucherNumber)}</td>
        <td style="${td()};font-family:monospace">${esc(row.numberPlate ?? row.containerNumber ?? "—")}</td>
        <td style="${td("right", "#dc2626")}">${esc(fmtAmt2(row.debit))}</td>
        <td style="${td("right", "#059669")}">${esc(fmtAmt2(row.credit))}</td>
        <td style="${td("right", balColor, true)}">${fmt(row.runningBalance)}</td>
        <td style="${td()}">${esc(row.dateToBePaid ?? "—")}</td>
        <td style="${td()}">${statusLabel(row)}</td>
      </tr>`;
    });

    // Closing balance row
    rowsHtml += `<tr style="background:#e6f7f3">
      <td style="${td()};color:#6b7280;font-style:italic"></td>
      <td style="${td("left", "#374151", true)}">Closing Balance</td>
      <td style="${td()}"></td>
      <td style="${td("right", "#dc2626", true)}">${fmt(String(stats?.totalDebit ?? 0))}</td>
      <td style="${td("right", "#059669", true)}">${fmt(String(stats?.totalCredit ?? 0))}</td>
      <td style="${td("right", closingBal > 0 ? "#b45309" : closingBal < 0 ? "#059669" : "#374151", true)}">${fmt(statement.closingBalance)}${closingSide}</td>
      <td style="${td()}"></td><td style="${td()}"></td>
    </tr>`;

    const W = 1060;
    const el = document.createElement("div");
    el.style.cssText =
      `position:fixed;top:-9999px;left:-9999px;width:${W}px;` +
      "background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;" +
      "border:1px solid #d1d5db;border-radius:6px;overflow:hidden;";

    el.innerHTML = `
      <div style="background:#0d7c66;padding:16px 14px;text-align:center;">
        <div style="font-size:24px;font-weight:800;color:#ffffff;letter-spacing:0.04em;text-transform:uppercase;">${esc(selectedTransporter.name)}</div>
        <div style="font-size:11px;color:#ccfbf1;margin-top:3px;">Transporter Statement &nbsp;·&nbsp; ${esc(periodStr)}</div>
      </div>
      <div style="display:flex;gap:0;border-bottom:1px solid #e5e7eb;">
        <div style="flex:1;padding:10px 14px;border-right:1px solid #e5e7eb;">
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:2px;">Total Paid</div>
          <div style="font-size:15px;font-weight:700;color:#dc2626;">${fmt(String(stats?.totalDebit ?? 0))}</div>
        </div>
        <div style="flex:1;padding:10px 14px;border-right:1px solid #e5e7eb;">
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:2px;">Total Charged</div>
          <div style="font-size:15px;font-weight:700;color:#059669;">${fmt(String(stats?.totalCredit ?? 0))}</div>
        </div>
        <div style="flex:1;padding:10px 14px;">
          <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:2px;">Outstanding</div>
          <div style="font-size:15px;font-weight:700;color:${closingBal > 0 ? "#b45309" : closingBal < 0 ? "#059669" : "#374151"};">${fmt(statement.closingBalance)}${closingSide}</div>
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;table-layout:auto;">
        <thead>
          <tr>
            ${["DATE", "DESCRIPTION", "PLATE", "DEBIT", "CREDIT", "BALANCE", "DUE DATE", "STATUS"]
              .map((h, idx) => `<th style="${th(idx >= 3 && idx <= 5 ? "right" : "left")}">${h}</th>`)
              .join("")}
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:5px 12px;font-size:10px;color:#9ca3af;text-align:right;">
        HMD International Group &nbsp;·&nbsp; ERP System &nbsp;·&nbsp; ${new Date().toLocaleString("en-GB")}
      </div>`;

    document.body.appendChild(el);
    return el;
  }, [statement, selectedTransporter, dateFrom, dateTo, stats]);

  // Export PNG/PDF via html2canvas
  const handleExportPDF = useCallback(async () => {
    const el = buildCapture();
    if (!el) return;
    setPdfExporting(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: "#ffffff",
        logging: false,
        width: 1060,
        height: el.scrollHeight,
        windowWidth: 1060,
        windowHeight: el.scrollHeight,
      });
      document.body.removeChild(el);
      const link = document.createElement("a");
      link.download = `TransporterStatement_${selectedTransporter?.name ?? "export"}_${today()}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
      toast({ title: "Exported", description: "Statement saved as PNG image." });
    } catch (err) {
      document.body.removeChild(el);
      toast({ title: "Export failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setPdfExporting(false);
    }
  }, [buildCapture, selectedTransporter, toast]);

  // Send WhatsApp image
  const handleSendWhatsApp = useCallback(async () => {
    const el = buildCapture();
    if (!el) return;
    setWaSending(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: "#ffffff",
        logging: false,
        width: 1060,
        height: el.scrollHeight,
        windowWidth: 1060,
        windowHeight: el.scrollHeight,
      });
      document.body.removeChild(el);
      const imageBase64 = canvas.toDataURL("image/png");
      const data: Response & { sent?: number } = await apiRequest(
        "POST",
        `/api/transporter-statement/${selectedAccountId}/send-whatsapp`,
        {
          dateFrom,
          dateTo,
          imageBase64,
        }
      );
      toast({ title: "WhatsApp sent", description: `Delivered to ${data?.sent ?? 0} recipient(s).` });
    } catch (err) {
      if (el.parentNode) document.body.removeChild(el);
      toast({ title: "WhatsApp failed", description: getErrorDetails(err).optionalMessage, variant: "destructive" });
    } finally {
      setWaSending(false);
    }
  }, [buildCapture, selectedAccountId, dateFrom, dateTo, toast]);

  // Reallocate mutation (FIFO)
  const reallocateMutation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/transporter-statement/${selectedAccountId}/reallocate`, {}),
    onSuccess: () => {
      toast({ title: "Allocations updated", description: "FIFO allocation has been re-run." });
      queryClient.invalidateQueries({
        queryKey: ["/api/transporter-statement", selectedAccountId, "statement"],
      });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Reallocation failed", description: err?.message, variant: "destructive" });
    },
  });

  // Print handler
  function _handlePrint() {
    window.print();
  }

  const closingBal = statement ? parseFloat(statement.closingBalance) : 0;

  return (
    <>
      {/* ── Print stylesheet ─────────────────────────────────────────────── */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #transporter-print-area,
          #transporter-print-area * { visibility: visible; }
          #transporter-print-area { position: absolute; inset: 0; padding: 24px; }

          .print\\:hidden { display: none !important; }

          #transporter-print-area .print-header {
            margin-bottom: 16px;
          }
          #transporter-print-area .print-header h1 {
            font-size: 22px;
            font-weight: 700;
            margin: 0 0 2px;
          }
          #transporter-print-area .print-header p {
            font-size: 13px;
            color: #555;
            margin: 0;
          }

          #transporter-print-area table {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
          }
          #transporter-print-area thead tr {
            background: #0d7c66;
            color: white;
          }
          #transporter-print-area thead th {
            padding: 6px 8px;
            text-align: left;
            font-weight: 600;
          }
          #transporter-print-area thead th.text-right {
            text-align: right;
          }
          #transporter-print-area tbody tr:nth-child(even) {
            background: #f0faf8;
          }
          #transporter-print-area tbody td {
            padding: 5px 8px;
            border-bottom: 1px solid #e0e0e0;
          }
          #transporter-print-area tbody td.text-right {
            text-align: right;
          }
          #transporter-print-area .print-footer {
            margin-top: 16px;
            font-size: 10px;
            color: #888;
            text-align: right;
          }
          #transporter-print-area .summary-row td {
            background: #e6f7f3;
            font-weight: 600;
          }
        }
      `}</style>

      <div id="transporter-print-area" className={cn("flex flex-col h-full overflow-hidden", embedded ? "" : "p-4")}>
        {/* ── Print header (only visible when printing) ─── */}
        <div className="print-header hidden print:block">
          <h1>{selectedTransporter?.name ?? "Transporter"}</h1>
          <p>Statement of Accounts &nbsp;·&nbsp; Printed on {new Date().toLocaleDateString()}</p>
        </div>

        {/* ── Toolbar (hidden when printing) ──────────── */}
        <div className="flex flex-wrap items-end gap-3 mb-4 shrink-0 print:hidden">
          <div className="flex flex-col gap-1 min-w-[220px]">
            <Label className="text-xs text-muted-foreground">Transporter Account</Label>
            {loadingTransporters ? (
              <Skeleton className="h-9 w-[220px]" />
            ) : (
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId} data-testid="select-transporter">
                <SelectTrigger className="w-[220px]" data-testid="trigger-transporter">
                  <SelectValue placeholder="Select transporter…" />
                </SelectTrigger>
                <SelectContent>
                  {transporters.length === 0 && (
                    <SelectItem value="__none__" disabled>
                      No active OTW transporters with matching accounts
                    </SelectItem>
                  )}
                  {transporters.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)} data-testid={`option-transporter-${t.id}`}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">From</Label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-[140px]"
              data-testid="input-date-from"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-[140px]"
              data-testid="input-date-to"
            />
          </div>

          <div className="flex items-center gap-2 ml-auto">
            {selectedAccountId && (
              <>
                <Button
                  variant="outline"
                  onClick={() => reallocateMutation.mutate()}
                  disabled={reallocateMutation.isPending}
                  data-testid="btn-reallocate"
                >
                  <RefreshCw className={cn("h-4 w-4 mr-2", reallocateMutation.isPending && "animate-spin")} />
                  {reallocateMutation.isPending ? "Running…" : "Reallocate"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleSendWhatsApp}
                  disabled={waSending || !statement}
                  data-testid="btn-send-whatsapp"
                >
                  <MessageCircle className={cn("h-4 w-4 mr-2", waSending && "animate-pulse")} />
                  {waSending ? "Sending…" : "Send WhatsApp"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleExportPDF}
                  disabled={pdfExporting || !statement}
                  data-testid="btn-print"
                >
                  <Printer className={cn("h-4 w-4 mr-2", pdfExporting && "animate-spin")} />
                  {pdfExporting ? "Exporting…" : "Print / Export PDF"}
                </Button>
              </>
            )}
            {selectedAccountId && statement && (
              <SettingsPopover
                accountId={parseInt(selectedAccountId)}
                paymentTermsDays={statement.paymentTermsDays}
                onSaved={handleSettingsSaved}
              />
            )}
          </div>
        </div>

        {/* ── Summary strip ────────────────────────────── */}
        {selectedAccountId && statement && stats && (
          <div className="flex flex-wrap gap-3 mb-4 shrink-0 print:hidden">
            <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
              <TrendingDown className="h-4 w-4 text-destructive" />
              <span className="text-muted-foreground">Total Paid:</span>
              <span className="font-medium tabular-nums">{fmtNum(String(stats.totalDebit))}</span>
            </div>
            <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
              <TrendingUp className="h-4 w-4 text-green-600" />
              <span className="text-muted-foreground">Total Charged:</span>
              <span className="font-medium tabular-nums">{fmtNum(String(stats.totalCredit))}</span>
            </div>
            <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
              <Minus className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Outstanding:</span>
              <span
                className={cn(
                  "font-medium tabular-nums",
                  closingBal > 0 ? "text-amber-600 dark:text-amber-400" : closingBal < 0 ? "text-green-600" : ""
                )}
              >
                {fmtNum(statement.closingBalance)}
                {closingBal > 0 && <span className="ml-1 text-xs">Cr</span>}
                {closingBal < 0 && <span className="ml-1 text-xs">Dr</span>}
              </span>
            </div>
            {stats.overdueCount > 0 && (
              <div className="flex items-center gap-2 rounded-md border bg-destructive/10 px-3 py-2 text-sm">
                <span className="text-destructive font-medium">{stats.overdueCount} overdue</span>
              </div>
            )}
          </div>
        )}

        {/* ── Table ────────────────────────────────────── */}
        <div className="flex-1 overflow-auto rounded-md border bg-card">
          {!selectedAccountId ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-muted-foreground print:hidden">
              <p className="text-sm">Select a transporter account to view the statement</p>
            </div>
          ) : loadingStatement ? (
            <div className="p-4 space-y-2 print:hidden">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : statementError ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-destructive print:hidden">
              <p className="text-sm font-medium">Failed to load statement</p>
              <p className="text-xs text-muted-foreground">{statementErrorObj?.message ?? "Unknown error"}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[90px]">Date</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-[110px]">Number Plate</TableHead>
                  <TableHead className="w-[110px] text-right">Debit</TableHead>
                  <TableHead className="w-[110px] text-right">Credit</TableHead>
                  <TableHead className="w-[120px] text-right">Balance</TableHead>
                  <TableHead className="w-[150px]">Date to be Paid</TableHead>
                  <TableHead className="w-[110px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Opening balance row */}
                {statement && (
                  <TableRow className="bg-muted/30 text-xs text-muted-foreground italic">
                    <TableCell></TableCell>
                    <TableCell>Opening Balance</TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                    <TableCell className="text-right tabular-nums font-medium text-foreground not-italic">
                      {fmtNum(statement.openingBalance)}
                    </TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                )}

                {(statement?.rows?.length ?? 0) === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-10 text-sm">
                      No entries for the selected period
                    </TableCell>
                  </TableRow>
                ) : (
                  statement?.rows?.map((row) => {
                    const bal = parseFloat(row.runningBalance);
                    const isOverdue =
                      row.dateToBePaid && row.dateToBePaid < today() && row.status && row.status !== "paid";
                    const isPaid = row.status === "paid";
                    return (
                      <TableRow
                        key={row.id}
                        className={cn(isOverdue ? "bg-destructive/5" : "", isPaid ? "opacity-50" : "")}
                        data-testid={`row-statement-${row.id}`}
                      >
                        <TableCell className="text-sm tabular-nums whitespace-nowrap">{formatDate(row.date)}</TableCell>
                        <TableCell className="text-sm max-w-[260px]">
                          <div className="truncate" title={row.description}>
                            {row.description || row.narration || row.voucherNumber}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {row.numberPlate ? (
                            <Badge variant="outline" className="font-mono text-xs">
                              {row.numberPlate}
                            </Badge>
                          ) : row.containerNumber ? (
                            <span className="text-xs text-muted-foreground">{row.containerNumber}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-destructive">
                          {fmtAmt(row.debit)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-green-700 dark:text-green-400">
                          {fmtAmt(row.credit)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right tabular-nums text-sm font-medium",
                            bal > 0
                              ? "text-amber-700 dark:text-amber-400"
                              : bal < 0
                                ? "text-green-700 dark:text-green-400"
                                : "text-muted-foreground"
                          )}
                        >
                          {fmtNum(row.runningBalance)}
                        </TableCell>
                        <TableCell>
                          <DueDateCell row={row} onSave={handleDueDateSave} />
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={row.status} paidAmount={row.paidAmount} total={row.credit} />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}

                {/* Closing balance row */}
                {statement?.rows && statement.rows.length > 0 && (
                  <TableRow className="bg-muted/30 font-semibold text-xs summary-row">
                    <TableCell></TableCell>
                    <TableCell className="text-muted-foreground italic">Closing Balance</TableCell>
                    <TableCell></TableCell>
                    <TableCell className="text-right tabular-nums text-destructive">
                      {fmtNum(String(stats?.totalDebit ?? 0))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-green-700 dark:text-green-400">
                      {fmtNum(String(stats?.totalCredit ?? 0))}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        closingBal > 0
                          ? "text-amber-700 dark:text-amber-400"
                          : closingBal < 0
                            ? "text-green-700 dark:text-green-400"
                            : ""
                      )}
                    >
                      {fmtNum(statement.closingBalance)}
                      {closingBal !== 0 && (
                        <span className="ml-1 font-normal text-xs text-muted-foreground">
                          {closingBal > 0 ? "Cr" : "Dr"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </div>

        {/* Print footer */}
        <div className="print-footer hidden print:block">
          Printed on {new Date().toLocaleString()} &nbsp;·&nbsp; {selectedTransporter?.name}
        </div>

        {isFetching && !loadingStatement && (
          <p className="text-xs text-muted-foreground mt-1 shrink-0 print:hidden">Refreshing…</p>
        )}
      </div>
    </>
  );
}
