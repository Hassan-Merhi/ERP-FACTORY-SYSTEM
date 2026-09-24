import { searchAny } from "@shared/searchNormalization";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

import type {
  Employee,
  LedgerAccount,
  PayrollRun,
  PreviewItem,
  SalaryAdvance,
  WorkerDeductionRow,
  WorkerGroup,
} from "./types";

export function useERPRunPayrollModel() {
  const { toast } = useToast();
  const { formatAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;

  const [activeTab, setActiveTab] = useState<"run" | "history">("run");

  // ── Step 1: worker selection ──────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<number | string, boolean>>({});
  const [selectedWorkers, setSelectedWorkers] = useState<Set<number>>(new Set());

  // ── Step 2: preview / draft ───────────────────────────────────────────────
  const [step, setStep] = useState<1 | 2>(1);
  const [previewItems, setPreviewItems] = useState<PreviewItem[]>([]);
  const [previewDate, setPreviewDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [previewNotes, setPreviewNotes] = useState("");

  // ── History: pay dialog ───────────────────────────────────────────────────
  const [payDialogRun, setPayDialogRun] = useState<PayrollRun | null>(null);
  const [payAccountId, setPayAccountId] = useState("");
  const [deleteRunId, setDeleteRunId] = useState<number | null>(null);
  const [undoRunId, setUndoRunId] = useState<number | null>(null);
  const [migrateConfirmOpen, setMigrateConfirmOpen] = useState(false);
  const [migrateResult, setMigrateResult] = useState<{
    migrated: number;
    alreadyCorrect: number;
    noGroups: number;
    noVoucher: number;
    total: number;
    depositsMigrated: number;
    depositsAlreadyCorrect: number;
    bonusesMigrated: number;
    bonusesAlreadyCorrect: number;
  } | null>(null);

  // ── Queries ───────────────────────────────────────────────────────────────
  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";

  const { data: allEmployees, isLoading: empLoading } = useQuery<Employee[]>({
    queryKey: ["/api/employees", companyId],
  });

  const { data: workerGroupsRaw = [], isLoading: groupsLoading } = useQuery<WorkerGroup[]>({
    queryKey: ["/api/worker-groups/with-members", companyId],
    queryFn: async () => {
      const res = await fetch("/api/worker-groups/with-members", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: ledgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", companyId],
    queryFn: async () => {
      const res = await fetch("/api/ledger-accounts", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: salaryAdvances = [] } = useQuery<SalaryAdvance[]>({
    queryKey: ["/api/salary-advances", companyId],
    queryFn: async () => {
      const res = await fetch("/api/salary-advances", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: workerDeductionsRaw = [] } = useQuery<WorkerDeductionRow[]>({
    queryKey: ["/api/factory/worker-deductions", companyId],
    queryFn: async () => {
      const res = await fetch("/api/factory/worker-deductions", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!companyId,
  });

  const { data: payrollRuns = [], isLoading: runsLoading } = useQuery<PayrollRun[]>({
    queryKey: ["/api/payroll/runs", companyId],
    queryFn: async () => {
      if (!companyId) return [];
      const res = await fetch(`/api/payroll/runs?companyId=${companyId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!companyId,
  });

  const cashAccounts = useMemo(() => ledgerAccounts.filter((a) => a.accountType === "Cash"), [ledgerAccounts]);
  const workers = useMemo(
    () => (allEmployees || []).filter((e) => e.employeeType === "Worker" && e.active),
    [allEmployees]
  );
  const workerGroups = useMemo(
    () =>
      workerGroupsRaw.filter((g) => {
        const t = g.groupType || g.group_type;
        return !t || t === "Worker";
      }),
    [workerGroupsRaw]
  );

  const advanceBalanceByEmployee = useMemo(() => {
    const map: Record<number, number> = {};
    for (const adv of salaryAdvances) {
      if (!adv.fullyPaid) {
        const bal = parseFloat(adv.remainingBalance || "0");
        if (bal > 0) map[adv.employeeId] = (map[adv.employeeId] || 0) + bal;
      }
    }
    return map;
  }, [salaryAdvances]);

  const pendingDeductionsByEmployee = useMemo(() => {
    const map: Record<number, number> = {};
    for (const d of workerDeductionsRaw) {
      if (!d.applied) {
        map[d.workerId] = (map[d.workerId] || 0) + parseFloat(d.amount || "0");
      }
    }
    return map;
  }, [workerDeductionsRaw]);

  const workerMemberships = useMemo(() => {
    const map: Record<number, number[]> = {};
    for (const g of workerGroups)
      for (const m of g.members || []) {
        if (!map[m.id]) map[m.id] = [];
        map[m.id].push(g.id);
      }
    return map;
  }, [workerGroups]);

  const ungroupedWorkers = useMemo(
    () => workers.filter((w) => !workerMemberships[w.id]?.length),
    [workers, workerMemberships]
  );

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return new Set(workers.map((w) => w.id));
    return new Set(
      workers
        .filter((w) => searchAny(searchQuery, `${w.firstName} ${w.lastName}`, w.code, w.department))
        .map((w) => w.id)
    );
  }, [workers, searchQuery]);

  const workerById = useMemo(() => {
    const map: Record<number, Employee> = {};
    for (const w of workers) map[w.id] = w;
    return map;
  }, [workers]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function toggleGroup(key: number | string) {
    setExpandedGroups((p) => ({ ...p, [key]: !(p[key] ?? true) }));
  }
  function toggleWorker(id: number) {
    setSelectedWorkers((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleGroupSelection(memberIds: number[]) {
    const visible = memberIds.filter((id) => filtered.has(id));
    const allSel = visible.every((id) => selectedWorkers.has(id));
    setSelectedWorkers((p) => {
      const n = new Set(p);
      if (allSel) visible.forEach((id) => n.delete(id));
      else visible.forEach((id) => n.add(id));
      return n;
    });
  }

  function enterPreview() {
    const items: PreviewItem[] = [];
    function addGroup(label: string, memberIds: number[]) {
      for (const id of memberIds) {
        if (!selectedWorkers.has(id) || !workerById[id]) continue;
        const w = workerById[id];
        const salary = parseFloat(w.monthlySalary || "0");
        const deduction = Math.min(advanceBalanceByEmployee[id] || 0, salary);
        const pendingDeductions = pendingDeductionsByEmployee[id] || 0;
        items.push({
          employeeId: id,
          employeeName: `${w.firstName} ${w.lastName}`.trim(),
          groupName: label,
          baseSalary: salary,
          deduction,
          pendingDeductions,
          netPay: Math.max(0, salary - deduction - pendingDeductions),
        });
      }
    }
    for (const g of workerGroups)
      addGroup(
        g.name,
        (g.members || []).map((m) => m.id)
      );
    if (ungroupedWorkers.length > 0)
      addGroup(
        "Ungrouped",
        ungroupedWorkers.map((w) => w.id)
      );
    setPreviewItems(items);
    setPreviewNotes("");
    setStep(2);
  }

  function updateDeduction(idx: number, val: string) {
    setPreviewItems((prev) =>
      prev.map((it, i) => {
        if (i !== idx) return it;
        const ded = Math.max(0, parseFloat(val) || 0);
        return { ...it, deduction: ded, netPay: Math.max(0, it.baseSalary - ded - it.pendingDeductions) };
      })
    );
  }

  // ── Mutations ─────────────────────────────────────────────────────────────
  const saveDraftMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/payroll/runs", {
        date: previewDate,
        notes: previewNotes || undefined,
        items: previewItems.map((it) => ({
          employeeId: it.employeeId,
          employeeName: it.employeeName,
          groupName: it.groupName,
          baseSalary: it.baseSalary.toFixed(2),
          deduction: it.deduction.toFixed(2),
          netPay: it.netPay.toFixed(2),
        })),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save draft");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs"] });
      toast({ title: "Draft saved", description: "Payroll saved as draft. Go to History to pay it." });
      setStep(1);
      setSelectedWorkers(new Set());
      setPreviewItems([]);
      setActiveTab("history");
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const payRunMutation = useMutation({
    mutationFn: async ({ runId, accountId }: { runId: number; accountId: string }) => {
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
      toast({ title: "Payroll paid", description: "Ledger entries created successfully." });
      setPayDialogRun(null);
      setPayAccountId("");
      // Print immediately after paying
      if (payDialogRun) {
        const run = { ...payDialogRun, status: "PAID" };
        setTimeout(() => printRun(run), 300);
      }
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteRunMutation = useMutation({
    mutationFn: async (runId: number) => {
      const res = await apiRequest("DELETE", `/api/payroll/runs/${runId}`, undefined);
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.message || "Failed to delete");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs"] });
      toast({ title: "Draft deleted" });
      setDeleteRunId(null);
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const undoRunMutation = useMutation({
    mutationFn: async (runId: number) => {
      const res = await apiRequest("POST", `/api/payroll/runs/${runId}/undo`, {});
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.message || "Failed to undo");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/salary-advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      toast({
        title: "Payroll undone",
        description: "Run reversed to draft. Ledger entries and advance deductions removed.",
      });
      setUndoRunId(null);
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const migrateGroupExpensesMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/payroll/runs/migrate-group-expenses", {});
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.message || "Migration failed");
      }
      return res.json() as Promise<{
        migrated: number;
        alreadyCorrect: number;
        noGroups: number;
        noVoucher: number;
        total: number;
        depositsMigrated: number;
        depositsAlreadyCorrect: number;
        bonusesMigrated: number;
        bonusesAlreadyCorrect: number;
      }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/payroll/runs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      setMigrateConfirmOpen(false);
      setMigrateResult(data);
    },
    onError: (e: Error) => {
      setMigrateConfirmOpen(false);
      toast({ title: "Migration failed", description: e.message, variant: "destructive" });
    },
  });

  // ── Helpers for the worker-salaries template ──────────────────────────────
  function getRunDateHeaders(runDate: string): string[] {
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const base = new Date(runDate + "T00:00:00");
    return Array.from({ length: 10 }, (_, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      return `${String(d.getDate()).padStart(2, "0")}-${MONTHS[d.getMonth()]}`;
    });
  }

  function getWorkerCodeById(employeeId: number): string {
    return workerById[employeeId]?.code || "";
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
    const totalNet = items.reduce((s, it) => s + parseFloat(it.netPay || "0"), 0);
    const hasDed = totalDed > 0;
    const cur = selectedCompany?.displayCurrency || "$";
    const fmt = (n: number) =>
      `${cur}\u00A0${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const statusBadge =
      run.status === "PAID"
        ? `<span style="background:#16a34a;color:#fff;font-weight:700;padding:2px 10px;border-radius:4px;font-size:11px">PAID</span>`
        : `<span style="background:#ca8a04;color:#fff;font-weight:700;padding:2px 10px;border-radius:4px;font-size:11px">DRAFT</span>`;

    const TH = (txt: string, align = "right") =>
      `<th style="background:#111;color:#fff;font-weight:700;font-size:10px;padding:6px 8px;text-align:${align};border:1px solid #333;white-space:nowrap">${txt}</th>`;

    const headerCols = [TH("Name", "left"), TH("Group", "left"), TH("Base Salary")];
    if (hasDed) headerCols.push(TH("Deduction"));
    headerCols.push(TH("Net Pay"));

    const bodyRows = items
      .map((it, i) => {
        const bg = i % 2 === 0 ? "#fff" : "#f5f5f5";
        const ded = parseFloat(it.deduction || "0");
        const TD = (txt: string, align = "right", bold = false) =>
          `<td style="border:1px solid #ccc;padding:5px 8px;text-align:${align};background:${bg};font-size:10px;${bold ? "font-weight:700;" : ""}">${txt}</td>`;
        const cells = [
          TD(it.employeeName, "left", true),
          TD(it.groupName || "—", "left"),
          TD(fmt(parseFloat(it.baseSalary || "0"))),
        ];
        if (hasDed) cells.push(TD(ded > 0 ? `<span style="color:#b91c1c">-${fmt(ded)}</span>` : "—"));
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
        <button onclick="window.print()" style="padding:6px 16px;background:#000;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px">Print / Save PDF</button>
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
    const cur = selectedCompany?.displayCurrency || "$";
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
    XLSX.writeFile(wb, `payroll-${run.id}-${run.date}.xlsx`);
  }

  const isLoading = empLoading || groupsLoading;
  const totalSelectedBase = useMemo(
    () => Array.from(selectedWorkers).reduce((s, id) => s + parseFloat(workerById[id]?.monthlySalary || "0"), 0),
    [selectedWorkers, workerById]
  );
  const previewTotalNet = useMemo(() => previewItems.reduce((s, it) => s + it.netPay, 0), [previewItems]);
  const previewTotalBase = useMemo(() => previewItems.reduce((s, it) => s + it.baseSalary, 0), [previewItems]);

  return {
    activeTab,
    setActiveTab,
    searchQuery,
    setSearchQuery,
    expandedGroups,
    selectedWorkers,
    setSelectedWorkers,
    step,
    setStep,
    previewItems,
    setPreviewItems,
    previewDate,
    setPreviewDate,
    previewNotes,
    setPreviewNotes,
    payDialogRun,
    setPayDialogRun,
    payAccountId,
    setPayAccountId,
    deleteRunId,
    setDeleteRunId,
    undoRunId,
    setUndoRunId,
    migrateConfirmOpen,
    setMigrateConfirmOpen,
    migrateResult,
    setMigrateResult,
    isDeveloper,
    payrollRuns,
    runsLoading,
    cashAccounts,
    workers,
    workerGroups,
    ungroupedWorkers,
    advanceBalanceByEmployee,
    filtered,
    workerById,
    toggleGroup,
    toggleWorker,
    toggleGroupSelection,
    enterPreview,
    updateDeduction,
    saveDraftMutation,
    payRunMutation,
    deleteRunMutation,
    undoRunMutation,
    migrateGroupExpensesMutation,
    getRunDateHeaders,
    getRunTemplateRows,
    printRun,
    exportRunExcel,
    isLoading,
    totalSelectedBase,
    previewTotalNet,
    previewTotalBase,
    formatAmount,
  };
}
