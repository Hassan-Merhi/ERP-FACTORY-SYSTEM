import type { AgentDutySummary } from "./types";
import { fmt, fmtD } from "./helpers";

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
    <section className="rounded-md border overflow-hidden" data-testid={`agent-view-only-${agent.agentName}`}>
      <div className="bg-slate-800 text-white px-4 py-2 flex items-center justify-between gap-3">
        <h3 className="font-semibold">{agent.agentName}</h3>
        <span className="text-xs">View Only</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 text-sm border-b bg-muted/20">
        <div><p className="text-xs text-muted-foreground">Ledger balance</p><strong>{agent.ledgerBalance === null ? "—" : `$${fmt(agent.ledgerBalance, 2)}`}</strong></div>
        <div><p className="text-xs text-muted-foreground">Container duty</p><strong>$ {fmt(agent.containerDutyTotal, 2)}</strong></div>
        <div><p className="text-xs text-muted-foreground">Cleared</p><strong>$ {fmt(agent.clearedByPayments, 2)}</strong></div>
        <div><p className="text-xs text-muted-foreground">Open balance</p><strong>{agent.openBalance === null ? "—" : `$${fmt(agent.openBalance, 2)}`}</strong></div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left">
          <thead className="bg-muted/50"><tr><th className="p-2">Container</th><th className="p-2">Supplier</th><th className="p-2">Offload date</th><th className="p-2">Transporter</th><th className="p-2 text-right">Duty</th><th className="p-2 text-right">Remaining</th></tr></thead>
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
