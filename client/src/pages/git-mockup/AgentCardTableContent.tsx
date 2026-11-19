// Extracted from ./AgentCardTable.tsx
import { formatUsd } from "@/lib/moneyDisplay";
import { Badge } from "@/components/ui/badge";
import { fmtD } from "./helpers";
import { useAgentCardTableState } from "./useAgentCardTableState";

export function AgentCardTableContent({
  clearedRows,
  isReconciled,
  openAndPartial,
  showCleared,
}: Pick<ReturnType<typeof useAgentCardTableState>, "clearedRows" | "isReconciled" | "openAndPartial" | "showCleared">) {
  return (
    <>
      {showCleared &&
        clearedRows.map((r) => (
          <tr key={`cleared-${r.id}`} className="border-b bg-slate-50/60 dark:bg-slate-800/20 opacity-70">
            <td className="py-0.5 px-2 font-mono text-muted-foreground">{r.containerNumber}</td>
            <td className="py-0.5 px-2 text-muted-foreground">{r.supplierCode ?? "—"}</td>
            <td className="py-0.5 px-2 font-mono text-muted-foreground">{r.numberPlate ?? "—"}</td>
            <td className="py-0.5 px-2 text-muted-foreground">{fmtD(r.offloadDate ?? null)}</td>
            <td className="py-0.5 px-2 text-muted-foreground">{fmtD(r.borderDate)}</td>
            <td className="py-0.5 px-2 text-muted-foreground">{r.transporter ?? "—"}</td>
            <td className="py-0.5 px-2 text-muted-foreground">{r.location ?? "—"}</td>
            <td className="py-0.5 px-2 text-right text-muted-foreground">{formatUsd(r.dutyFee, 0)}</td>
            <td className="py-0.5 px-2 text-right text-green-600 dark:text-green-500">{formatUsd(r.dutyFee, 0)}</td>
            <td className="py-0.5 px-2 text-right text-muted-foreground">—</td>
            <td className="py-0.5 px-2 text-center">
              <Badge
                variant="outline"
                className="text-[11px] text-slate-500 border-slate-300 dark:border-slate-600 no-default-active-elevate"
              >
                Cleared
              </Badge>
            </td>
            <td />
          </tr>
        ))}
      {showCleared &&
        isReconciled &&
        openAndPartial.map((r) => (
          <tr key={`reconciled-${r.id}`} className="border-b bg-purple-50/60 dark:bg-purple-900/10 opacity-70">
            <td className="py-0.5 px-2 font-mono text-muted-foreground">{r.containerNumber}</td>
            <td className="py-0.5 px-2 text-muted-foreground">{r.supplierCode ?? "—"}</td>
            <td className="py-0.5 px-2 font-mono text-muted-foreground">{r.numberPlate ?? "—"}</td>
            <td className="py-0.5 px-2 text-muted-foreground">{fmtD(r.offloadDate ?? null)}</td>
            <td className="py-0.5 px-2 text-muted-foreground">{fmtD(r.borderDate)}</td>
            <td className="py-0.5 px-2 text-muted-foreground">{r.transporter ?? "—"}</td>
            <td className="py-0.5 px-2 text-muted-foreground">{r.location ?? "—"}</td>
            <td className="py-0.5 px-2 text-right text-muted-foreground">{formatUsd(r.dutyFee, 0)}</td>
            <td className="py-0.5 px-2 text-right text-green-600 dark:text-green-500">
              {r.clearedAmount > 0 ? formatUsd(r.clearedAmount, 0) : "—"}
            </td>
            <td className="py-0.5 px-2 text-right text-muted-foreground">—</td>
            <td className="py-0.5 px-2 text-center">
              <Badge
                variant="outline"
                className="text-[11px] text-purple-600 dark:text-purple-400 border-purple-300 dark:border-purple-700 no-default-active-elevate"
              >
                Manual
              </Badge>
            </td>
            <td />
          </tr>
        ))}
    </>
  );
}
