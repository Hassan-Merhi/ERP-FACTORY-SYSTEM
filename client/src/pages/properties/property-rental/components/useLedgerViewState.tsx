// Extracted from ./LedgerView.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import { format } from "date-fns";
import type { Contract, LedgerRow, Payment } from "../types";
import { fmtMoneyCurrency, MONTH_NAMES } from "../utils";
import { useApiBase } from "../shared";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";
import type { AuthMe } from "@shared/apiTypes";
import { POPUP_BLOCKED_TOAST } from "@/lib/popupBlockedToast";
import { printDocument } from "@/lib/printDocument";

export function useLedgerViewState({
  ledger,
  postedPayments,
  scheduledPayments,
  guaranteePayments,
  contract,
  unitId,
  onNoteUpdated,
  readOnly,
}: {
  ledger: LedgerRow[];
  postedPayments: Payment[];
  scheduledPayments: Payment[];
  guaranteePayments: Payment[];
  contract: Contract;
  unitId: number;
  onNoteUpdated?: () => void;
  readOnly?: boolean;
}) {
  const apiBase = useApiBase();
  // ERP phones: the month ledger and payment lists render as cards inside the unit dialog.
  const ledgerCards = useMobileCardTable();
  const paymentCards = useMobileCardTable();
  const scheduledCards = useMobileCardTable();
  const { toast } = useToast();
  const [exportingExcel, setExportingExcel] = useState(false);
  const [draftNote, setDraftNote] = useState(contract.statementNote ?? "");
  const noteChanged = draftNote !== (contract.statementNote ?? "");

  const { data: me } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"], staleTime: 30 * 60 * 1000 });
  const isAdmin = me?.role === "Admin" || me?.role === "Developer";

  const saveNote = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", `${apiBase}/contracts/${contract.id}/statement-note`, { statementNote: draftNote }),
    onSuccess: () => {
      toast({ title: "Note saved" });
      onNoteUpdated?.();
    },
    onError: () => toast({ title: "Failed to save note", variant: "destructive" }),
  });

  const fixAllocation = useMutation({
    mutationFn: () => apiRequest("POST", `/api/properties/repair/reallocate-payments/${contract.id}`, {}),
    onSuccess: async (res) => {
      const data = (await res.json()) as { message?: string; fixed?: number };
      toast({
        title: "Allocation fixed",
        description: data?.message ?? `${data?.fixed ?? 0} payment(s) reallocated to the correct months.`,
      });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      onNoteUpdated?.();
    },
    onError: (err: ClientErrorLike) =>
      toast({
        title: "Fix failed",
        description: err?.message ?? "Could not reallocate payments.",
        variant: "destructive",
      }),
  });

  const reverseAccrual = useMutation({
    mutationFn: async (rowId: number) => {
      const res = await apiRequest("DELETE", `${apiBase}/ledger/${rowId}/accrual`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Accrual reversed", description: "Reversal journal posted. Month is now eligible to re-accrue." });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      onNoteUpdated?.();
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Reversal failed", description: e.message, variant: "destructive" }),
  });

  // FIX #7: use backend-calculated fields when available; fall back to frontend calculation.
  // totalPaid uses allPostedPaid (all POSTED, no date filter) so future-dated posted payments
  // appear correctly in the statement.  effectivePaidAmount (with date filter) is still used
  // for the balance widget on the main listing page.
  const useBackendFields = ledger.length === 0 || ledger[0].expectedAsOf !== undefined;
  const totalExpected = useBackendFields
    ? ledger.reduce((s, r) => s + (r.expectedAsOf ?? 0), 0)
    : ledger.reduce((s, r) => s + Number(r.expectedAmount), 0);
  const totalPaid = useBackendFields
    ? ledger.reduce((s, r) => s + (r.allPostedPaid ?? r.effectivePaidAmount ?? Number(r.paidAmount)), 0)
    : ledger.reduce((s, r) => s + Number(r.paidAmount), 0);
  const balance = totalExpected - totalPaid;

  const handlePrint = () => {
    const sym = contract.currency === "EUR" ? "€" : contract.currency === "CFA" ? "FC " : "$";
    const fmtPdf = (v: number) =>
      sym +
      v.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: contract.currency === "CFA" ? 0 : 2,
      });

    const rows = ledger
      .map((r) => {
        // FIX #7: use backend status/outstanding when available.
        // Use allPostedPaid (no date filter) for the PAID column so future-dated posted
        // payments are shown correctly.
        const isDue = r.isDue !== undefined ? r.isDue : true;
        const paid =
          r.allPostedPaid ?? (r.effectivePaidAmount !== undefined ? r.effectivePaidAmount : Number(r.paidAmount));
        const expected = r.expectedAsOf !== undefined ? r.expectedAsOf : isDue ? Number(r.expectedAmount) : 0;
        const out = Math.max(0, expected - paid);
        const credit = Math.max(0, paid - expected);
        const outColor = out > 0.005 ? "#cc0000" : credit > 0.005 ? "#006600" : "#888888";
        const statusLabel = r.status ?? (isDue ? "" : "not-due");
        return `<tr>
        <td>${MONTH_NAMES[r.month]} ${r.year}${!isDue ? ` <em style='color:#888;font-size:9px'>${statusLabel}</em>` : ""}</td>
        <td class="num">${isDue ? fmtPdf(expected) : "—"}</td>
        <td class="num">${fmtPdf(paid)}</td>
        <td class="num" style="color:${outColor};font-weight:600">${credit > 0.005 ? `${fmtPdf(credit)} CR` : fmtPdf(out)}</td>
        <td class="note">${r.notes || ""}</td>
      </tr>`;
      })
      .join("");

    const sym2 = contract.currency === "EUR" ? "€" : contract.currency === "CFA" ? "FC " : "$";
    const fmtPdf2 = (v: number) =>
      sym2 +
      v.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: contract.currency === "CFA" ? 0 : 2,
      });
    const buildPayRows = (rows: Payment[]) =>
      rows
        .map(
          (p) => `<tr>
      <td>${format(new Date(p.paymentDate), "dd MMM yyyy")}</td>
      <td>${MONTH_NAMES[p.forMonth]} ${p.forYear}</td>
      <td class="num">${fmtPdf2(Number(p.amount))}</td>
      <td class="note">${p.notes || ""}</td>
    </tr>`
        )
        .join("");
    const payRows = buildPayRows(postedPayments);
    const schedRows = buildPayRows(scheduledPayments);
    const guarRows = buildPayRows(guaranteePayments);

    const balColor = balance > 0 ? "#cc0000" : balance < 0 ? "#006600" : "#000";
    const startStr = contract.startDate ? format(new Date(contract.startDate), "dd MMM yyyy") : "—";

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Rental Statement — ${contract.tenantName}</title>
    <style>
      body { font-family: Arial, sans-serif; font-size: 11px; color: #111; margin: 0; padding: 20px; }
      h1 { font-size: 18px; margin: 0 0 2px 0; color: #1a3a6b; }
      .subtitle { font-size: 12px; color: #555; margin-bottom: 16px; }
      .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; margin-bottom: 16px; background: #f4f6fb; border: 1px solid #dde3f0; border-radius: 6px; padding: 12px 16px; }
      .info-grid .lbl { font-weight: 700; color: #555; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
      .info-grid .val { font-size: 12px; font-weight: 600; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
      th { background: #1a3a6b; color: #fff; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 6px 10px; }
      th.num { text-align: right; }
      td { padding: 5px 10px; border-bottom: 1px solid #eee; }
      td.num { text-align: right; font-variant-numeric: tabular-nums; }
      td.note { color: #666; }
      tr.total td { background: #e9ecf5; font-weight: 700; border-top: 2px solid #aaa; }
      h2 { font-size: 13px; margin: 20px 0 6px 0; color: #1a3a6b; }
      @media print { body { padding: 0; } }
    </style></head><body>
    <h1>Rental Statement</h1>
    <div class="subtitle">Generated ${format(new Date(), "dd MMM yyyy")}</div>
    <div class="info-grid">
      <div><div class="lbl">Tenant</div><div class="val">${contract.tenantName}</div></div>
      <div><div class="lbl">Start Date</div><div class="val">${startStr}</div></div>
      <div><div class="lbl">Monthly Rent</div><div class="val">${fmtMoneyCurrency(contract.rentalAmount, contract.currency)}</div></div>
      ${contract.guaranteeAmount && Number(contract.guaranteeAmount) > 0 ? `<div><div class="lbl">Guarantee</div><div class="val">${fmtMoneyCurrency(contract.guaranteeAmount, contract.currency)}</div></div>` : ""}
    </div>
    <table>
      <thead><tr>
        <th>Month</th><th class="num">Expected</th><th class="num">Paid</th><th class="num">Outstanding</th><th>Notes</th>
      </tr></thead>
      <tbody>${rows}<tr class="total">
        <td>TOTALS</td>
        <td class="num">${fmtMoneyCurrency(totalExpected, contract.currency)}</td>
        <td class="num">${fmtMoneyCurrency(totalPaid, contract.currency)}</td>
        <td class="num" style="color:${balColor}">${fmtMoneyCurrency(Math.abs(balance), contract.currency)}${balance < 0 ? " CR" : ""}</td>
        <td></td>
      </tr></tbody>
    </table>
    ${
      draftNote.trim()
        ? `<div style="margin:16px 0;padding:10px 14px;background:#f4f6fb;border:1px solid #dde3f0;border-radius:6px;font-size:11px;">
      <div style="font-weight:700;color:#555;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">Note</div>
      <div style="white-space:pre-wrap;color:#111">${draftNote.trim().replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
    </div>`
        : ""
    }
    ${
      postedPayments.length > 0
        ? `<h2>Rent Payment History</h2>
    <table><thead><tr><th>Date</th><th>For</th><th class="num">Amount</th><th>Notes</th></tr></thead>
    <tbody>${payRows}</tbody></table>`
        : ""
    }
    ${
      scheduledPayments.length > 0
        ? `<h2 style="color:#b45309">Scheduled Payments (Pending)</h2>
    <table><thead><tr><th>Date</th><th>For</th><th class="num">Amount</th><th>Notes</th></tr></thead>
    <tbody>${schedRows}</tbody></table>`
        : ""
    }
    ${
      guaranteePayments.length > 0
        ? `<h2 style="color:#6b21a8">Guarantee / Deposit Activity</h2>
    <p style="font-size:10px;color:#888;margin:-2px 0 8px 0">These entries reflect guarantee or deposit movements and do not affect rent balance.</p>
    <table><thead><tr><th>Date</th><th>For</th><th class="num">Amount</th><th>Notes</th></tr></thead>
    <tbody>${guarRows}</tbody></table>`
        : ""
    }
    </body></html>`;

    printDocument(html, { features: "width=900,height=700", onBlocked: () => toast(POPUP_BLOCKED_TOAST) });
  };

  const handleExcel = async () => {
    setExportingExcel(true);
    try {
      await downloadFromUrl(`${apiBase}/units/${unitId}/statement/export`, {
        fileName: exportFileName(`rental statement ${contract.tenantName}`, "xlsx"),
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setExportingExcel(false);
    }
  };
  return {
    apiBase,
    balance,
    contract,
    draftNote,
    exportingExcel,
    fixAllocation,
    guaranteePayments,
    handleExcel,
    handlePrint,
    isAdmin,
    ledger,
    ledgerCards,
    noteChanged,
    paymentCards,
    postedPayments,
    readOnly,
    reverseAccrual,
    saveNote,
    scheduledCards,
    scheduledPayments,
    setDraftNote,
    totalExpected,
    totalPaid,
  };
}
