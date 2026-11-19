// Extracted from ./TransporterStatement.tsx: state, queries and handlers for TransporterStatement.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { StatementResponse, StatementRow, Transporter } from "./transporterstatement/types";
import { monthAgo, today } from "./transporterstatement/utils";
import { isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";

export function useTransporterStatementModel() {
  const { toast } = useToast();
  const { data: viewer } = useQuery(authenticatedUserQueryOptions());
  const role = viewer?.currentRole ?? viewer?.role;
  const isTester = role === "ERP Tester";
  const isViewer = isExistingRecordReadOnlyRole(role);
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
    if (isViewer) return;
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

  const closingBal = statement ? parseFloat(statement.closingBalance) : 0;

  const transporterControl = (
    <div className="flex w-full flex-col gap-1 sm:w-auto sm:min-w-[220px]">
      <Label className="text-xs text-muted-foreground">Transporter Account</Label>
      {loadingTransporters ? (
        <Skeleton className="h-9 w-[220px]" />
      ) : (
        <Select value={selectedAccountId} onValueChange={setSelectedAccountId} data-testid="select-transporter">
          <SelectTrigger className="w-full sm:w-[220px]" data-testid="trigger-transporter">
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
  );
  const customPeriodCount = Number(dateFrom !== monthAgo()) + Number(dateTo !== today());
  const resetPeriod = () => {
    setDateFrom(monthAgo());
    setDateTo(today());
  };

  return {
    isTester,
    isViewer,
    formatDate,
    selectedAccountId,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    statement,
    loadingStatement,
    isFetching,
    statementError,
    statementErrorObj,
    handleSettingsSaved,
    handleDueDateSave,
    waSending,
    pdfExporting,
    stats,
    selectedTransporter,
    handleExportPDF,
    handleSendWhatsApp,
    reallocateMutation,
    closingBal,
    transporterControl,
    customPeriodCount,
    resetPeriod,
  };
}

export type TransporterStatementModel = ReturnType<typeof useTransporterStatementModel>;
