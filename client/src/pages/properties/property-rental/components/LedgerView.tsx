import type { ClientErrorLike } from "@/lib/clientError";
/**
 * LedgerView — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Printer, Download, CalendarDays, Wrench, RotateCcw } from "lucide-react";
import { format } from "date-fns";
import type { Contract, LedgerRow, Payment } from "../types";
import { MONTH_NAMES, billingDayLabel, fmtMoney, fmtMoneyCurrency } from "../utils";
import { useApiBase } from "../shared";
import type { AuthMe } from "@shared/apiTypes";

export // ──────────────────────────────────────────────────────────
// LEDGER VIEW / STATEMENT
// ──────────────────────────────────────────────────────────
function LedgerView({
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
  const { toast } = useToast();
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

    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) {
      toast({
        title: "Pop-up blocked",
        description: "Allow pop-ups for this site and try again.",
        variant: "destructive",
      });
      return;
    }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  };

  const handleExcel = () => {
    window.open(`${apiBase}/units/${unitId}/statement/export`, "_blank");
  };

  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm flex-1 min-w-0">
          <div className="bg-muted/40 rounded p-2">
            <div className="text-xs text-muted-foreground">Tenant</div>
            <div className="font-semibold truncate">{contract.tenantName}</div>
          </div>
          <div className="bg-muted/40 rounded p-2">
            <div className="text-xs text-muted-foreground">Monthly Rent</div>
            <div className="font-semibold">{fmtMoneyCurrency(contract.rentalAmount, contract.currency)}</div>
          </div>
          <div className="bg-muted/40 rounded p-2">
            <div className="text-xs text-muted-foreground">Billing Day</div>
            <div className="font-semibold flex items-center gap-1">
              <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {billingDayLabel(contract.startDate) ?? "—"}
            </div>
          </div>
          <div className="bg-muted/40 rounded p-2">
            <div className="text-xs text-muted-foreground">Balance</div>
            <div
              className={`font-bold ${balance > 0 ? "text-red-600 dark:text-red-400" : balance < 0 ? "text-green-600 dark:text-green-400" : ""}`}
            >
              {balance < 0
                ? `${fmtMoneyCurrency(Math.abs(balance), contract.currency)} CR`
                : fmtMoneyCurrency(balance, contract.currency)}
            </div>
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {isAdmin && !readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => fixAllocation.mutate()}
              disabled={fixAllocation.isPending}
              data-testid="button-fix-allocation"
              title="Re-allocate payments to oldest unpaid months first"
            >
              <Wrench className="h-4 w-4 mr-1" />
              {fixAllocation.isPending ? "Fixing..." : "Fix Allocation"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleExcel} data-testid="button-export-excel">
            <Download className="h-4 w-4 mr-1" />
            Excel
          </Button>
          <Button variant="outline" size="sm" onClick={handlePrint} data-testid="button-print-statement">
            <Printer className="h-4 w-4 mr-1" />
            Print / PDF
          </Button>
        </div>
      </div>
      <div className="border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase">
            <tr>
              <th className="text-left px-3 py-2">Month</th>
              <th className="text-right px-3 py-2">Expected</th>
              <th className="text-right px-3 py-2">Paid</th>
              <th className="text-right px-3 py-2">Outstanding</th>
              <th className="text-left px-3 py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((r) => {
              // FIX #7: prefer backend-calculated fields, fall back to frontend estimation.
              // Use allPostedPaid (no date filter) for the PAID column so future-dated posted
              // payments are not hidden by the asOf cutoff.
              const isDue = r.isDue !== undefined ? r.isDue : true;
              const paid =
                r.allPostedPaid ?? (r.effectivePaidAmount !== undefined ? r.effectivePaidAmount : Number(r.paidAmount));
              const expected = r.expectedAsOf !== undefined ? r.expectedAsOf : isDue ? Number(r.expectedAmount) : 0;
              const outstanding = Math.max(0, expected - paid);
              const credit = Math.max(0, paid - expected);
              const statusLabel = r.status;
              const showAsCreditRow = !isDue && paid > 0.005;
              return (
                <tr key={r.id} className="border-t" data-testid={`row-ledger-${r.year}-${r.month}`}>
                  <td className="px-3 py-1.5">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      <span>
                        {MONTH_NAMES[r.month]} {r.year}
                      </span>
                      {!isDue && (
                        <span className="text-[10px] text-muted-foreground italic">{statusLabel ?? "not due"}</span>
                      )}
                      {isDue && credit > 0.005 && (
                        <span className="text-[10px] text-green-600 dark:text-green-400 font-medium">+credit</span>
                      )}
                      {statusLabel === "SCHEDULED" && (
                        <Badge variant="outline" className="text-[10px] border-amber-500 text-amber-600">
                          Scheduled
                        </Badge>
                      )}
                      {r.accrualVoucherId && (
                        <>
                          <Badge
                            variant="secondary"
                            className="text-[10px]"
                            data-testid={`badge-accrued-${r.year}-${r.month}`}
                          >
                            Accrued
                          </Badge>
                          {isAdmin && apiBase.includes("/erp/") && paid < 0.005 && (
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Reverse this accrual (posts Dr Accrued Rent Payable / Cr Rent Expense)"
                              onClick={(e) => {
                                e.stopPropagation();
                                reverseAccrual.mutate(r.id);
                              }}
                              disabled={reverseAccrual.isPending && reverseAccrual.variables === r.id}
                              data-testid={`button-reverse-accrual-${r.year}-${r.month}`}
                            >
                              <RotateCcw className="h-3 w-3" />
                            </Button>
                          )}
                        </>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                    {isDue ? fmtMoneyCurrency(expected, contract.currency) : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoneyCurrency(paid, contract.currency)}</td>
                  <td
                    className={`px-3 py-1.5 text-right tabular-nums font-semibold ${outstanding > 0.005 ? "text-red-600 dark:text-red-400" : credit > 0.005 || showAsCreditRow ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}
                  >
                    {credit > 0.005 || showAsCreditRow
                      ? `${fmtMoneyCurrency(showAsCreditRow ? paid : credit, contract.currency)} CR`
                      : fmtMoneyCurrency(outstanding, contract.currency)}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.notes || ""}</td>
                </tr>
              );
            })}
            <tr className="border-t-2 bg-muted/30 font-semibold">
              <td className="px-3 py-2">
                TOTALS <span className="font-normal text-[10px] text-muted-foreground">(as of today)</span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {fmtMoneyCurrency(totalExpected, contract.currency)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtMoneyCurrency(totalPaid, contract.currency)}</td>
              <td
                className={`px-3 py-2 text-right tabular-nums ${balance > 0 ? "text-red-600 dark:text-red-400" : balance < 0 ? "text-green-600 dark:text-green-400" : ""}`}
              >
                {balance < 0
                  ? `${fmtMoneyCurrency(Math.abs(balance), contract.currency)} CR`
                  : fmtMoneyCurrency(balance, contract.currency)}
              </td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
      {/* FIX #7: separate posted payment history from scheduled payments */}
      {postedPayments.length > 0 && (
        <details className="bg-muted/30 rounded-md p-2" open>
          <summary className="text-sm font-semibold cursor-pointer" data-testid="summary-rent-payment-history">
            Rent Payment History ({postedPayments.length})
          </summary>
          <table className="w-full text-xs mt-2">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left px-2 py-1">Date</th>
                <th className="text-left px-2 py-1">For</th>
                <th className="text-right px-2 py-1">Amount</th>
                <th className="text-left px-2 py-1">Notes</th>
              </tr>
            </thead>
            <tbody>
              {postedPayments.map((p) => (
                <tr key={p.id} className="border-t" data-testid={`row-rent-payment-${p.id}`}>
                  <td className="px-2 py-1">{format(new Date(p.paymentDate), "dd MMM yyyy")}</td>
                  <td className="px-2 py-1">
                    {MONTH_NAMES[p.forMonth]} {p.forYear}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">${fmtMoney(p.amount)}</td>
                  <td className="px-2 py-1 text-muted-foreground">{p.notes || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {scheduledPayments.length > 0 && (
        <details
          className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-2"
          open
        >
          <summary
            className="text-sm font-semibold cursor-pointer text-amber-800 dark:text-amber-300"
            data-testid="summary-scheduled-payments"
          >
            Scheduled Payments ({scheduledPayments.length})
          </summary>
          <p className="text-xs text-muted-foreground mt-1 mb-2">
            These payments are recorded but <strong>not yet posted</strong> — the cash entry will be created on the
            payment date.
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left px-2 py-1">Due Date</th>
                <th className="text-left px-2 py-1">For</th>
                <th className="text-right px-2 py-1">Amount</th>
                <th className="text-left px-2 py-1">Notes</th>
              </tr>
            </thead>
            <tbody>
              {scheduledPayments.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-amber-100 dark:border-amber-900"
                  data-testid={`row-scheduled-payment-${p.id}`}
                >
                  <td className="px-2 py-1">{format(new Date(p.paymentDate), "dd MMM yyyy")}</td>
                  <td className="px-2 py-1">
                    {MONTH_NAMES[p.forMonth]} {p.forYear}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums font-medium">${fmtMoney(p.amount)}</td>
                  <td className="px-2 py-1 text-muted-foreground">{p.notes || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {guaranteePayments.length > 0 && (
        <details
          className="rounded-md border border-purple-200 dark:border-purple-900 bg-purple-50/50 dark:bg-purple-950/20 p-2"
          open
        >
          <summary
            className="text-sm font-semibold cursor-pointer text-purple-800 dark:text-purple-300"
            data-testid="summary-guarantee-activity"
          >
            Guarantee / Deposit Activity ({guaranteePayments.length})
          </summary>
          <p className="text-xs text-muted-foreground mt-1 mb-2">
            These entries reflect guarantee or deposit movements. They do <strong>not</strong> affect rent balance or
            the Paid column above.
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left px-2 py-1">Date</th>
                <th className="text-left px-2 py-1">For</th>
                <th className="text-right px-2 py-1">Amount</th>
                <th className="text-left px-2 py-1">Notes</th>
              </tr>
            </thead>
            <tbody>
              {guaranteePayments.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-purple-100 dark:border-purple-900"
                  data-testid={`row-guarantee-payment-${p.id}`}
                >
                  <td className="px-2 py-1">{format(new Date(p.paymentDate), "dd MMM yyyy")}</td>
                  <td className="px-2 py-1">
                    {MONTH_NAMES[p.forMonth]} {p.forYear}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums font-medium">${fmtMoney(p.amount)}</td>
                  <td className="px-2 py-1 text-muted-foreground">{p.notes || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {/* ── Statement note ── */}
      {!readOnly && (
        <div className="border rounded-md p-3 space-y-2">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Statement Note</div>
          <Textarea
            placeholder="Add a note that will appear on the printed statement and Excel export…"
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            rows={3}
            className="text-sm resize-none"
            data-testid="textarea-statement-note"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => saveNote.mutate()}
              disabled={!noteChanged || saveNote.isPending}
              data-testid="button-save-statement-note"
            >
              {saveNote.isPending ? "Saving…" : "Save Note"}
            </Button>
          </div>
        </div>
      )}
      {readOnly && draftNote.trim() && (
        <div className="border rounded-md p-3 space-y-1">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Statement Note</div>
          <p className="text-sm whitespace-pre-wrap">{draftNote.trim()}</p>
        </div>
      )}
    </div>
  );
}
