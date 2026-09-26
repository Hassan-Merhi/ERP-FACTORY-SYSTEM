import { useMobileCardTable } from "@/components/ui/mobile-card-table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ChevronsUp, ArrowUp, ArrowDown, ArrowLeftRight, XIcon } from "lucide-react";
import { fmt, fmtD } from "./helpers";
import type { ApiAllocatedRow, ApiPreviewRow } from "./types";

interface ReplaceTargetLite {
  id: number;
  containerNumber: string;
  dutyFee: number;
}

interface AgentCardTableProps {
  agentName: string;
  prepaidTransitRows: ApiPreviewRow[];
  visibleOpenPartial: ApiAllocatedRow[];
  openAndPartial: ApiAllocatedRow[];
  isReconciled: boolean;
  showCleared: boolean;
  setShowCleared: (v: boolean | ((prev: boolean) => boolean)) => void;
  isDbOverride: boolean;
  effectivePrepaidIds: number[];
  setAllPrepaidMutate: (ids: number[]) => void;
  remainingTransitRows: ApiPreviewRow[];
  setReplaceTarget: (t: ReplaceTargetLite | null) => void;
  setReplaceAmountWarning: (w: null) => void;
  setReplaceConfirmDiff: (b: boolean) => void;
  isCustomOrder: boolean;
  moveRow: (id: number, dir: "up" | "down") => void;
  moveToTop: (id: number) => void;
  ledgerBalance: number | null;
  openSum: number;
  hasBalance: boolean;
  hasAdjustments: boolean;
  adjustedBalance: number | null;
  isMismatch: boolean;
  allBudgetDesignated: boolean;
  clearedRows: ApiAllocatedRow[];
}

export function AgentCardTable(props: AgentCardTableProps) {
  const {
    agentName: _agentName,
    prepaidTransitRows,
    visibleOpenPartial,
    openAndPartial,
    isReconciled,
    showCleared,
    setShowCleared: _setShowCleared,
    isDbOverride: _isDbOverride,
    effectivePrepaidIds,
    setAllPrepaidMutate,
    remainingTransitRows,
    setReplaceTarget,
    setReplaceAmountWarning,
    setReplaceConfirmDiff,
    isCustomOrder: _isCustomOrder,
    moveRow,
    moveToTop,
    ledgerBalance,
    openSum,
    hasBalance,
    hasAdjustments,
    adjustedBalance,
    isMismatch,
    allBudgetDesignated,
    clearedRows,
  } = props;

  // ERP phones read each container as a card (labels from these headers); desktop keeps the grid.
  const { tableProps } = useMobileCardTable();
  const cols = [
    "CONTAINER",
    "SUPPLIER",
    "PLATE",
    "OFFLOAD DATE",
    "BORDER DATE",
    "TRANSPORTER",
    "LOCATION",
    "DUTY",
    "CLEARED",
    "REMAINING",
    "STATUS",
    "",
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs whitespace-nowrap border-collapse" {...tableProps}>
        <thead>
          <tr className="bg-slate-700 dark:bg-slate-800 text-slate-100 border-b border-slate-600">
            {cols.map((h) => (
              <th key={h} className="py-1.5 px-2 font-semibold text-center tracking-wide text-[11px]">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {prepaidTransitRows.map((r) => (
            <tr key={`prepaid-transit-${r.id}`} className="border-b bg-emerald-50/60 dark:bg-emerald-950/20">
              <td className="py-0.5 px-2 font-mono font-semibold text-center text-emerald-800 dark:text-emerald-300">
                {r.containerNumber}
              </td>
              <td className="py-0.5 px-2 text-center">{r.supplierCode ?? r.supplierName ?? "—"}</td>
              <td className="py-0.5 px-2 font-mono text-center">{r.numberPlate ?? "—"}</td>
              <td className="py-0.5 px-2 text-center text-muted-foreground italic text-[10px]">In Transit</td>
              <td className="py-0.5 px-2 text-center">{fmtD(r.borderDate)}</td>
              <td className="py-0.5 px-2 text-center">{r.transporter ?? "—"}</td>
              <td className="py-0.5 px-2 text-center">{r.location ?? "—"}</td>
              <td className="py-0.5 px-2 text-right">${fmt(r.dutyFee, 0)}</td>
              <td className="py-0.5 px-2 text-center text-muted-foreground">—</td>
              <td className="py-0.5 px-2 text-right font-semibold">${fmt(r.dutyFee, 0)}</td>
              <td className="py-0.5 px-2 text-center">
                <Badge
                  variant="outline"
                  className="text-[10px] text-emerald-700 border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 no-default-active-elevate"
                >
                  Prepaid
                </Badge>
              </td>
              <td className="py-0.5 px-1 text-center">
                <div className="flex items-center gap-0.5 justify-center">
                  {remainingTransitRows.length > 0 && (
                    <button
                      onClick={() => {
                        setReplaceTarget({ id: r.id, containerNumber: r.containerNumber, dutyFee: r.dutyFee });
                        setReplaceAmountWarning(null);
                        setReplaceConfirmDiff(false);
                      }}
                      title="Replace"
                      data-testid={`button-replace-prepaid-${r.id}`}
                      className="text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    >
                      <ArrowLeftRight className="h-3 w-3" />
                    </button>
                  )}
                  <button
                    onClick={() => setAllPrepaidMutate(effectivePrepaidIds.filter((id) => id !== r.id))}
                    title="Remove from prepaid"
                    data-testid={`button-unprepaid-transit-${r.id}`}
                    className="text-muted-foreground hover:text-red-500 dark:hover:text-red-400 transition-colors"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                </div>
              </td>
            </tr>
          ))}

          {isReconciled ? (
            <tr>
              <td colSpan={12} className="py-3 px-3 text-center text-green-700 dark:text-green-400 italic text-xs">
                All containers reconciled by manual entries — no outstanding balance.
              </td>
            </tr>
          ) : visibleOpenPartial.length === 0 && prepaidTransitRows.length === 0 ? (
            <tr>
              <td colSpan={12} className="py-3 px-3 text-center text-muted-foreground italic text-xs">
                No open containers — account balance is fully cleared.
              </td>
            </tr>
          ) : visibleOpenPartial.length === 0 && prepaidTransitRows.length > 0 ? null : (
            visibleOpenPartial.map((r, rowIdx) => (
              <tr
                key={r.id}
                className={cn(
                  "border-b",
                  r.allocationStatus === "Partially Cleared" && "bg-amber-50/80 dark:bg-amber-950/20"
                )}
              >
                <td className="py-0.5 px-2 font-mono font-semibold text-center">{r.containerNumber}</td>
                <td className="py-0.5 px-2 text-center">{r.supplierCode ?? "—"}</td>
                <td className="py-0.5 px-2 font-mono text-center">{r.numberPlate ?? "—"}</td>
                <td className="py-0.5 px-2 text-center">{fmtD(r.offloadDate ?? null)}</td>
                <td className="py-0.5 px-2 text-center">{fmtD(r.borderDate)}</td>
                <td className="py-0.5 px-2 text-center">{r.transporter ?? "—"}</td>
                <td className="py-0.5 px-2 text-center">{r.location ?? "—"}</td>
                <td className="py-0.5 px-2 text-right">${fmt(r.dutyFee, 0)}</td>
                <td className="py-0.5 px-2 text-right text-green-600 dark:text-green-500">
                  {r.clearedAmount > 0 ? `$${fmt(r.clearedAmount, 0)}` : "—"}
                </td>
                <td className="py-0.5 px-2 text-right font-semibold">${fmt(r.remainingAmount, 0)}</td>
                <td className="py-0.5 px-2 text-center">
                  {r.allocationStatus === "Partially Cleared" ? (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-amber-700 border-amber-400 no-default-active-elevate"
                    >
                      Partial
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] no-default-active-elevate">
                      Open
                    </Badge>
                  )}
                </td>
                <td className="py-0.5 px-1 text-center">
                  <div className="flex flex-col gap-px">
                    <button
                      disabled={rowIdx === 0}
                      onClick={() => moveToTop(r.id)}
                      title="Top priority"
                      data-testid={`button-move-top-${r.id}`}
                      className="disabled:opacity-20 hover:text-orange-600 dark:hover:text-orange-400 text-muted-foreground transition-colors"
                    >
                      <ChevronsUp className="h-3 w-3" />
                    </button>
                    <button
                      disabled={rowIdx === 0}
                      onClick={() => moveRow(r.id, "up")}
                      title="Move up"
                      data-testid={`button-move-up-${r.id}`}
                      className="disabled:opacity-20 hover:text-blue-600 dark:hover:text-blue-400 text-muted-foreground transition-colors"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button
                      disabled={rowIdx === visibleOpenPartial.length - 1}
                      onClick={() => moveRow(r.id, "down")}
                      title="Move down"
                      data-testid={`button-move-down-${r.id}`}
                      className="disabled:opacity-20 hover:text-blue-600 dark:hover:text-blue-400 text-muted-foreground transition-colors"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                  </div>
                </td>
              </tr>
            ))
          )}

          {hasBalance &&
            (() => {
              const rawBal = ledgerBalance ?? openSum;
              const isDebit = rawBal > 0;
              const isCredit = rawBal < 0;
              const baseCls = isDebit
                ? "bg-green-600 text-white font-bold"
                : isCredit
                  ? "bg-red-600 text-white font-bold"
                  : "bg-slate-500 text-white font-bold";
              const balLabel = isDebit ? "Dr" : isCredit ? "Cr" : "";
              if (hasAdjustments && adjustedBalance !== null) {
                if (isReconciled)
                  return (
                    <tr className={cn(baseCls, "opacity-70")}>
                      <td colSpan={9} className="py-2 px-3 text-[11px] uppercase tracking-widest font-semibold">
                        Account Balance
                      </td>
                      <td className="py-2 px-3 text-right text-sm font-bold tabular-nums" data-label="Balance">
                        ${fmt(Math.abs(rawBal), 0)}
                        {balLabel && <span className="ml-1.5 text-[11px] opacity-80 font-semibold">({balLabel})</span>}
                      </td>
                      <td colSpan={2} />
                    </tr>
                  );
                const adjAbs = Math.abs(adjustedBalance);
                const adjLabel = adjustedBalance >= 0 ? "Dr" : "Cr";
                const adjRowCls =
                  isMismatch && !allBudgetDesignated
                    ? "bg-red-700 text-white font-bold"
                    : adjustedBalance > 0
                      ? "bg-green-600 text-white font-bold"
                      : adjustedBalance < 0
                        ? "bg-red-600 text-white font-bold"
                        : "bg-slate-500 text-white font-bold";
                return (
                  <tr className={adjRowCls}>
                    <td colSpan={9} className="py-2 px-3 text-[11px] uppercase tracking-widest font-semibold">
                      Account Balance
                    </td>
                    <td className="py-2 px-3 text-right text-sm font-bold tabular-nums" data-label="Balance">
                      ${fmt(adjAbs, 0)}
                      <span className="ml-1.5 text-[11px] opacity-80 font-semibold">({adjLabel})</span>
                    </td>
                    <td colSpan={2} />
                  </tr>
                );
              }
              return (
                <tr className={baseCls}>
                  <td colSpan={9} className="py-2 px-3 text-[11px] uppercase tracking-widest font-semibold">
                    Account Balance
                  </td>
                  <td className="py-2 px-3 text-right text-sm font-bold tabular-nums" data-label="Balance">
                    ${fmt(Math.abs(rawBal), 0)}
                    {balLabel && <span className="ml-1.5 text-[11px] opacity-80 font-semibold">({balLabel})</span>}
                  </td>
                  <td />
                  <td />
                </tr>
              );
            })()}

          {(clearedRows.length > 0 || (isReconciled && openAndPartial.length > 0)) && (
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
                    <td className="py-0.5 px-2 text-right text-muted-foreground">${fmt(r.dutyFee, 0)}</td>
                    <td className="py-0.5 px-2 text-right text-green-600 dark:text-green-500">${fmt(r.dutyFee, 0)}</td>
                    <td className="py-0.5 px-2 text-right text-muted-foreground">—</td>
                    <td className="py-0.5 px-2 text-center">
                      <Badge
                        variant="outline"
                        className="text-[10px] text-slate-500 border-slate-300 dark:border-slate-600 no-default-active-elevate"
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
                    <td className="py-0.5 px-2 text-right text-muted-foreground">${fmt(r.dutyFee, 0)}</td>
                    <td className="py-0.5 px-2 text-right text-green-600 dark:text-green-500">
                      {r.clearedAmount > 0 ? `$${fmt(r.clearedAmount, 0)}` : "—"}
                    </td>
                    <td className="py-0.5 px-2 text-right text-muted-foreground">—</td>
                    <td className="py-0.5 px-2 text-center">
                      <Badge
                        variant="outline"
                        className="text-[10px] text-purple-600 dark:text-purple-400 border-purple-300 dark:border-purple-700 no-default-active-elevate"
                      >
                        Manual
                      </Badge>
                    </td>
                    <td />
                  </tr>
                ))}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
