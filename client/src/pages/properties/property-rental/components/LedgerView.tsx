import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CalendarDays, Wrench } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { format } from "date-fns";
import type { Contract, LedgerRow, Payment } from "../types";
import { MONTH_NAMES, billingDayLabel, fmtMoney, fmtMoneyCurrency } from "../utils";
import { useLedgerViewState } from "./useLedgerViewState";
import { LedgerViewSection } from "./LedgerViewSection";

export // ──────────────────────────────────────────────────────────
// LEDGER VIEW / STATEMENT
// ──────────────────────────────────────────────────────────
function LedgerView(props: {
  ledger: LedgerRow[];
  postedPayments: Payment[];
  scheduledPayments: Payment[];
  guaranteePayments: Payment[];
  contract: Contract;
  unitId: number;
  onNoteUpdated?: () => void;
  readOnly?: boolean;
}) {
  const {
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
  } = useLedgerViewState(props);

  return (
    <div className="space-y-3 pt-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm flex-1 min-w-0">
          <div className="bg-muted/40 rounded-sm p-2">
            <div className="text-xs text-muted-foreground">Tenant</div>
            <div className="font-semibold truncate">{contract.tenantName}</div>
          </div>
          <div className="bg-muted/40 rounded-sm p-2">
            <div className="text-xs text-muted-foreground">Monthly Rent</div>
            <div className="font-semibold">{fmtMoneyCurrency(contract.rentalAmount, contract.currency)}</div>
          </div>
          <div className="bg-muted/40 rounded-sm p-2">
            <div className="text-xs text-muted-foreground">Billing Day</div>
            <div className="font-semibold flex items-center gap-1">
              <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {billingDayLabel(contract.startDate) ?? "—"}
            </div>
          </div>
          <div className="bg-muted/40 rounded-sm p-2">
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
          <ExportButton
            kind="excel"
            size="sm"
            busy={exportingExcel}
            onClick={handleExcel}
            data-testid="button-export-excel"
          />
          <ExportButton kind="print" size="sm" onClick={handlePrint} data-testid="button-print-statement" />
        </div>
      </div>
      <LedgerViewSection
        apiBase={apiBase}
        balance={balance}
        contract={contract}
        isAdmin={isAdmin}
        ledger={ledger}
        ledgerCards={ledgerCards}
        readOnly={readOnly}
        reverseAccrual={reverseAccrual}
        totalExpected={totalExpected}
        totalPaid={totalPaid}
      />
      {/* FIX #7: separate posted payment history from scheduled payments */}
      {postedPayments.length > 0 && (
        <details className="bg-muted/30 rounded-md p-2" open>
          <summary className="text-sm font-semibold cursor-pointer" data-testid="summary-rent-payment-history">
            Rent Payment History ({postedPayments.length})
          </summary>
          <table className="w-full text-xs mt-2" {...paymentCards.tableProps}>
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
                  <td className="px-2 py-1 text-muted-foreground" data-mobile-cell={p.notes ? undefined : "hidden"}>
                    {p.notes || ""}
                  </td>
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
          <table className="w-full text-xs" {...scheduledCards.tableProps}>
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
                  <td className="px-2 py-1 text-muted-foreground" data-mobile-cell={p.notes ? undefined : "hidden"}>
                    {p.notes || ""}
                  </td>
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
                  <td className="px-2 py-1 text-muted-foreground" data-mobile-cell={p.notes ? undefined : "hidden"}>
                    {p.notes || ""}
                  </td>
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
