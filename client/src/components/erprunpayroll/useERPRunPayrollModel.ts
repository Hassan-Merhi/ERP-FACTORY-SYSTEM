import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { exportFileName } from "@/lib/exportFile";
import type { PayrollRun } from "./types";
import { getRunDateHeaders } from "./erpRunPayrollDates";
import { useERPRunPayrollStateModel } from "./useERPRunPayrollStateModel";

export function useERPRunPayrollModel() {
  const hs = useERPRunPayrollStateModel();

  const payRunMutation = useMutation({
    mutationFn: async ({ runId, accountId }: { runId: number; accountId: string }) => {
      if (!hs.recordChanges.allowed) throw new Error(hs.recordChanges.reason ?? "");
      const res = await apiRequest("PATCH", `/api/payroll/runs/${runId}`, {
        action: "pay",
        paymentAccountId: parseInt(accountId),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to pay");
      return data;
    },
    onSuccess: (_data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/worker-deductions"] });
      hs.toast({ title: "Payroll paid", description: "Ledger entries created successfully." });
      hs.setPayDialogRun(null);
      hs.setPayAccountId("");
      // Print immediately after paying
      if (hs.payDialogRun) {
        const run = { ...hs.payDialogRun, status: "PAID" };
        setTimeout(() => printRun(run), 300);
      }
    },
    onError: (e: Error) => hs.toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const deleteRunMutation = useMutation({
    mutationFn: async (runId: number) => {
      if (!hs.recordChanges.allowed) throw new Error(hs.recordChanges.reason ?? "");
      const res = await apiRequest("DELETE", `/api/payroll/runs/${runId}`, undefined);
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.message || "Failed to delete");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs"] });
      hs.toast({ title: "Draft deleted" });
      hs.setDeleteRunId(null);
    },
    onError: (e: Error) => hs.toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const undoRunMutation = useMutation({
    mutationFn: async (runId: number) => {
      if (!hs.recordChanges.allowed) throw new Error(hs.recordChanges.reason ?? "");
      const res = await apiRequest("POST", `/api/payroll/runs/${runId}/undo`, {});
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.message || "Failed to undo");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/worker-deductions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      hs.toast({
        title: "Payroll undone",
        description: "Run reversed to draft. Ledger entries and advance deductions removed.",
      });
      hs.setUndoRunId(null);
    },
    onError: (e: Error) => hs.toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  // ── Helpers for the worker-salaries template ──────────────────────────────
  function getWorkerCodeById(employeeId: number): string {
    return hs.workerById[employeeId]?.code || "";
  }

  interface TemplateRow {
    code: string;
    name: string;
    days: string[];
  }
  function getRunTemplateRows(run: PayrollRun): TemplateRow[] {
    return (run.items || []).map((it) => ({
      code: getWorkerCodeById(it.employeeId),
      name: it.employeeName,
      days: Array<string>(10).fill(""),
    }));
  }

  // ── Print (payroll amounts template) ──────────────────────────────────────
  function printRun(run: PayrollRun) {
    const items = run.items || [];
    const totalBase = items.reduce((s, it) => s + parseFloat(it.baseSalary || "0"), 0);
    const totalDed = items.reduce((s, it) => s + parseFloat(it.deduction || "0"), 0);
    const totalPayrollDed = items.reduce((s, it) => s + parseFloat(it.payrollDeduction || "0"), 0);
    const totalNet = items.reduce((s, it) => s + parseFloat(it.netPay || "0"), 0);
    const hasDed = totalDed > 0;
    const hasPayrollDed = totalPayrollDed > 0;
    const cur = hs.selectedCompany?.displayCurrency || "$";
    const fmt = (n: number) =>
      `${cur}\u00A0${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const statusBadge =
      run.status === "PAID"
        ? `<span style="background:#16a34a;color:#fff;font-weight:700;padding:2px 10px;border-radius:4px;font-size:11px">PAID</span>`
        : `<span style="background:#ca8a04;color:#fff;font-weight:700;padding:2px 10px;border-radius:4px;font-size:11px">DRAFT</span>`;

    const TH = (txt: string, align = "right") =>
      `<th style="background:#111;color:#fff;font-weight:700;font-size:10px;padding:6px 8px;text-align:${align};border:1px solid #333;white-space:nowrap">${txt}</th>`;

    const headerCols = [TH("Name", "left"), TH("Group", "left"), TH("Base Salary")];
    if (hasDed) headerCols.push(TH("Advance Deduction"));
    if (hasPayrollDed) headerCols.push(TH("Payroll Deduction"));
    headerCols.push(TH("Net Pay"));

    const bodyRows = items
      .map((it, i) => {
        const bg = i % 2 === 0 ? "#fff" : "#f5f5f5";
        const ded = parseFloat(it.deduction || "0");
        const payrollDed = parseFloat(it.payrollDeduction || "0");
        const TD = (txt: string, align = "right", bold = false) =>
          `<td style="border:1px solid #ccc;padding:5px 8px;text-align:${align};background:${bg};font-size:10px;${bold ? "font-weight:700;" : ""}">${txt}</td>`;
        const cells = [
          TD(it.employeeName, "left", true),
          TD(it.groupName || "—", "left"),
          TD(fmt(parseFloat(it.baseSalary || "0"))),
        ];
        if (hasDed) cells.push(TD(ded > 0 ? `<span style="color:#b91c1c">-${fmt(ded)}</span>` : "—"));
        if (hasPayrollDed)
          cells.push(TD(payrollDed > 0 ? `<span style="color:#c2410c">-${fmt(payrollDed)}</span>` : "—"));
        cells.push(TD(`<strong>${fmt(parseFloat(it.netPay || "0"))}</strong>`));
        return `<tr>${cells.join("")}</tr>`;
      })
      .join("");

    const totalCells = [
      `<td colspan="2" style="border:1px solid #333;padding:5px 8px;font-weight:700;font-size:10px;background:#111;color:#fff;text-align:left">Total — ${items.length} worker${items.length !== 1 ? "s" : ""}</td>`,
      `<td style="border:1px solid #333;padding:5px 8px;font-weight:700;font-size:10px;background:#111;color:#fff;text-align:right">${fmt(totalBase)}</td>`,
    ];
    if (hasDed)
      totalCells.push(
        `<td style="border:1px solid #333;padding:5px 8px;font-weight:700;font-size:10px;background:#b91c1c;color:#fff;text-align:right">-${fmt(totalDed)}</td>`
      );
    if (hasPayrollDed)
      totalCells.push(
        `<td style="border:1px solid #333;padding:5px 8px;font-weight:700;font-size:10px;background:#c2410c;color:#fff;text-align:right">-${fmt(totalPayrollDed)}</td>`
      );
    totalCells.push(
      `<td style="border:1px solid #333;padding:5px 8px;font-weight:700;font-size:11px;background:#16a34a;color:#fff;text-align:right">${fmt(totalNet)}</td>`
    );

    const notesRow = run.notes
      ? `<p style="margin:6px 0 0;font-size:10px;color:#555"><strong>Notes:</strong> ${run.notes}</p>`
      : "";

    const html = `<!DOCTYPE html><html><head><title>Worker Salaries — ${run.date}</title>
      <style>
        body{font-family:Arial,sans-serif;font-size:11px;margin:16px;color:#000}
        table{border-collapse:collapse;width:100%}
        @media print{
          @page{size:A4 portrait;margin:12mm}
          .no-print{display:none}
        }
      </style>
      </head><body>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
        <div>
          <h2 style="margin:0 0 4px;font-size:15px">Worker Salaries</h2>
          <div style="font-size:11px;color:#444"><strong>Date:</strong> ${run.date} &nbsp; ${statusBadge}</div>
          ${notesRow}
        </div>
        <div style="font-size:11px;color:#555;text-align:right">
          <div><strong>Workers:</strong> ${items.length}</div>
          <div style="margin-top:2px;font-size:13px;font-weight:700">Total: ${fmt(totalNet)}</div>
        </div>
      </div>
      <table>
        <thead><tr>${headerCols.join("")}</tr></thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr>${totalCells.join("")}</tr></tfoot>
      </table>
      <div class="no-print" style="margin-top:14px;text-align:right">
        <button onclick="window.print()" style="padding:6px 16px;background:#000;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px">Print</button>
      </div>
      <script>window.onload=()=>window.print();</script>
    </body></html>`;
    const w = window.open("", "_blank");
    if (w) {
      w.document.write(html);
      w.document.close();
    }
  }

  // ── Excel export (payroll amounts) ─────────────────────────────────────────
  async function exportRunExcel(run: PayrollRun) {
    const XLSXStyle = await import("xlsx-js-style");
    const XLSX = XLSXStyle.default ?? XLSXStyle;

    const items = run.items || [];
    const hasDed = items.some((it) => parseFloat(it.deduction || "0") > 0);
    const cur = hs.selectedCompany?.displayCurrency || "$";
    const fmtN = (n: number) => `${cur} ${n.toFixed(2)}`;

    const thinBlack = { style: "thin", color: { rgb: "000000" } };
    const allBorders = { top: thinBlack, bottom: thinBlack, left: thinBlack, right: thinBlack };

    const hCell = (v: string) => ({
      v,
      t: "s",
      s: {
        fill: { patternType: "solid", fgColor: { rgb: "111111" } },
        font: { bold: true, color: { rgb: "FFFFFF" } },
        alignment: { horizontal: "center", vertical: "center" },
        border: allBorders,
      },
    });
    const dCell = (v: string, isAlt: boolean, opts?: { bold?: boolean; right?: boolean; color?: string }) => ({
      v,
      t: "s",
      s: {
        fill: { patternType: "solid", fgColor: { rgb: isAlt ? "F5F5F5" : "FFFFFF" } },
        font: { bold: opts?.bold ?? false, color: { rgb: opts?.color ?? "000000" } },
        alignment: { horizontal: opts?.right ? "right" : "left", vertical: "center" },
        border: allBorders,
      },
    });
    const totCell = (v: string, bg: string) => ({
      v,
      t: "s",
      s: {
        fill: { patternType: "solid", fgColor: { rgb: bg } },
        font: { bold: true, color: { rgb: "FFFFFF" } },
        alignment: { horizontal: "right", vertical: "center" },
        border: allBorders,
      },
    });

    const headers = [hCell("Name"), hCell("Group"), hCell("Base Salary")];
    if (hasDed) headers.push(hCell("Deduction"));
    headers.push(hCell("Net Pay"));

    const wsData: Array<Array<ReturnType<typeof hCell>>> = [headers];

    let totalBase = 0,
      totalDed = 0,
      totalNet = 0;
    items.forEach((it, i) => {
      const isAlt = i % 2 === 1;
      const base = parseFloat(it.baseSalary || "0");
      const ded = parseFloat(it.deduction || "0");
      const net = parseFloat(it.netPay || "0");
      totalBase += base;
      totalDed += ded;
      totalNet += net;
      const row = [
        dCell(it.employeeName, isAlt, { bold: true }),
        dCell(it.groupName || "—", isAlt),
        dCell(fmtN(base), isAlt, { right: true }),
      ];
      if (hasDed)
        row.push(dCell(ded > 0 ? `-${fmtN(ded)}` : "—", isAlt, { right: true, color: ded > 0 ? "B91C1C" : "000000" }));
      row.push(dCell(fmtN(net), isAlt, { bold: true, right: true }));
      wsData.push(row);
    });

    const totRow = [
      totCell(`Total (${items.length} workers)`, "111111"),
      totCell("", "111111"),
      totCell(fmtN(totalBase), "111111"),
    ];
    if (hasDed) totRow.push(totCell(`-${fmtN(totalDed)}`, "B91C1C"));
    totRow.push(totCell(fmtN(totalNet), "16A34A"));
    wsData.push(totRow);

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws["!cols"] = [{ wch: 22 }, { wch: 14 }, { wch: 13 }, ...(hasDed ? [{ wch: 13 }] : []), { wch: 13 }];
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Payroll");
    XLSX.writeFile(wb, exportFileName(`payroll ${run.id}`, "xlsx", { date: run.date }));
  }

  const isLoading = hs.empLoading || hs.groupsLoading;
  const totalSelectedBase = useMemo(
    () => Array.from(hs.selectedWorkers).reduce((s, id) => s + parseFloat(hs.workerById[id]?.monthlySalary || "0"), 0),
    [hs.selectedWorkers, hs.workerById]
  );
  const previewTotalNet = useMemo(() => hs.previewItems.reduce((s, it) => s + it.netPay, 0), [hs.previewItems]);
  const previewTotalBase = useMemo(() => hs.previewItems.reduce((s, it) => s + it.baseSalary, 0), [hs.previewItems]);

  return {
    canChangeExistingRecords: hs.recordChanges.allowed,
    canCreate: hs.recordChanges.canCreate,
    changeDisabledReason: hs.recordChanges.reason,
    activeTab: hs.activeTab,
    setActiveTab: hs.setActiveTab,
    searchQuery: hs.searchQuery,
    setSearchQuery: hs.setSearchQuery,
    expandedGroups: hs.expandedGroups,
    selectedWorkers: hs.selectedWorkers,
    setSelectedWorkers: hs.setSelectedWorkers,
    step: hs.step,
    setStep: hs.setStep,
    previewItems: hs.previewItems,
    setPreviewItems: hs.setPreviewItems,
    previewDate: hs.previewDate,
    setPreviewDate: hs.setPreviewDate,
    previewNotes: hs.previewNotes,
    setPreviewNotes: hs.setPreviewNotes,
    payDialogRun: hs.payDialogRun,
    setPayDialogRun: hs.setPayDialogRun,
    payAccountId: hs.payAccountId,
    setPayAccountId: hs.setPayAccountId,
    deleteRunId: hs.deleteRunId,
    setDeleteRunId: hs.setDeleteRunId,
    undoRunId: hs.undoRunId,
    setUndoRunId: hs.setUndoRunId,
    isDeveloper: hs.isDeveloper,
    payrollRuns: hs.payrollRuns,
    runsLoading: hs.runsLoading,
    cashAccounts: hs.cashAccounts,
    workers: hs.workers,
    workerGroups: hs.workerGroups,
    ungroupedWorkers: hs.ungroupedWorkers,
    advanceBalanceByEmployee: hs.advanceBalanceByEmployee,
    filtered: hs.filtered,
    workerById: hs.workerById,
    toggleGroup: hs.toggleGroup,
    toggleWorker: hs.toggleWorker,
    toggleGroupSelection: hs.toggleGroupSelection,
    enterPreview: hs.enterPreview,
    updateDeduction: hs.updateDeduction,
    saveDraftMutation: hs.saveDraftMutation,
    payRunMutation,
    deleteRunMutation,
    undoRunMutation,
    getRunDateHeaders,
    getRunTemplateRows,
    printRun,
    exportRunExcel,
    isLoading,
    totalSelectedBase,
    previewTotalNet,
    previewTotalBase,
    formatAmount: hs.formatAmount,
  };
}
