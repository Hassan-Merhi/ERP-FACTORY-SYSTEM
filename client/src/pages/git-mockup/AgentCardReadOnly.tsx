import type { AgentDutySummary } from "./types";
import { fmt, fmtD } from "./helpers";
import { Building2 } from "lucide-react";

/** A projection only: do not mount AgentCard's mutations or prepaid repair effects for viewers. */
export function AgentCardReadOnly({ agent }: { agent: AgentDutySummary }) {
  const pending = [...agent.partialRows, ...agent.openRows];
  const rows = [...pending, ...agent.activePreviewRows.map((r) => ({
    ...r,
    offloadDate: null,
    clearedAmount: 0,
    remainingAmount: r.dutyFee,
    allocationStatus: "In Transit",
  }))];
  return (
    <section className="overflow-hidden rounded-2xl border border-violet-200/70 bg-card shadow-sm dark:border-violet-500/25" data-testid={`agent-view-only-${agent.agentName}`}>
      <div className="grid min-h-16 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-2 border-b border-violet-300/20 bg-gradient-to-r from-indigo-950 via-violet-950 to-indigo-950 px-3 py-3 text-white sm:px-5">
        <div className="flex justify-start"><span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-300/25 bg-violet-500/25 text-violet-200"><Building2 className="h-4 w-4" aria-hidden="true" /></span></div>
        <h3 className="min-w-0 truncate text-center text-base font-extrabold uppercase tracking-wider sm:text-lg" title={agent.agentName}>{agent.agentName}</h3>
        <span className="justify-self-end rounded-lg border border-violet-300/30 bg-white/10 px-2 py-1 text-[10px] font-semibold sm:text-xs">View Only</span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 border-b border-violet-200/50 bg-violet-50/40 p-3 text-sm dark:border-violet-500/15 dark:bg-slate-950/70 sm:grid-cols-4 [&>div]:rounded-xl [&>div]:border [&>div]:border-border/70 [&>div]:bg-background/90 [&>div]:p-3 dark:[&>div]:bg-violet-500/10">
        <div><p className="text-xs text-muted-foreground">Ledger balance</p><strong>{agent.ledgerBalance === null ? "—" : `$${fmt(agent.ledgerBalance, 2)}`}</strong></div>
        <div><p className="text-xs text-muted-foreground">Container duty</p><strong>$ {fmt(agent.containerDutyTotal, 2)}</strong></div>
        <div><p className="text-xs text-muted-foreground">Cleared</p><strong>$ {fmt(agent.clearedByPayments, 2)}</strong></div>
        <div><p className="text-xs text-muted-foreground">Open balance</p><strong>{agent.openBalance === null ? "—" : `$${fmt(agent.openBalance, 2)}`}</strong></div>
      </div>
      <div className="mx-3 mb-3 overflow-x-auto rounded-xl border border-border/70 dark:border-violet-500/20">
        <table className="w-full text-xs text-left">
          <thead className="bg-slate-100 text-slate-700 dark:bg-violet-950/60 dark:text-violet-100"><tr><th className="p-2">Container</th><th className="p-2">Supplier</th><th className="p-2">Offload date</th><th className="p-2">Transporter</th><th className="p-2 text-right">Duty</th><th className="p-2 text-right">Remaining</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-2 font-mono">{r.containerNumber}</td>
                <td className="p-2">{r.supplierCode || r.supplierName || "—"}</td>
                <td className="p-2">{fmtD(r.offloadDate)}</td>
                <td className="p-2">{r.transporter || "—"}</td>
                <td className="p-2 text-right">$ {fmt(r.dutyFee, 2)}</td>
                <td className="p-2 text-right">$ {fmt(r.remainingAmount, 2)}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td className="p-3 text-center text-muted-foreground" colSpan={6}>No open containers</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
