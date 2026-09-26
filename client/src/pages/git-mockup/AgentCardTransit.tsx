import { useMobileCardTable } from "@/components/ui/mobile-card-table";
import { useState } from "react";
import { ChevronUp, ChevronDown, ArrowUp, Filter } from "lucide-react";
import { fmt, fmtD } from "./helpers";
import type { ApiPreviewRow } from "./types";

interface AgentCardTransitProps {
  agentName: string;
  remainingTransitRows: ApiPreviewRow[];
  prepaidTransitRows: ApiPreviewRow[];
  effectivePrepaidIds: number[];
  setAllPrepaidMutate: (ids: number[]) => void;
  prepaidBudget: number;
  designatedPrepaidSum: number;
  transitTransporterFilter: string | null;
  setTransitTransporterFilter: (v: string | null) => void;
}

export function AgentCardTransit(props: AgentCardTransitProps) {
  const {
    agentName,
    remainingTransitRows,
    prepaidTransitRows,
    effectivePrepaidIds,
    setAllPrepaidMutate,
    prepaidBudget,
    designatedPrepaidSum,
    transitTransporterFilter,
    setTransitTransporterFilter,
  } = props;

  const [showActive, setShowActive] = useState(true);
  const { tableProps } = useMobileCardTable();

  if (remainingTransitRows.length === 0 && prepaidTransitRows.length === 0) return null;

  const transitTransporters = [...new Set(remainingTransitRows.map((r) => r.transporter).filter(Boolean))] as string[];
  const filteredTransitRows = (
    transitTransporterFilter
      ? remainingTransitRows.filter((r) => r.transporter === transitTransporterFilter)
      : remainingTransitRows
  )
    .slice()
    .sort((a, b) => (a.transporter ?? "").localeCompare(b.transporter ?? ""));

  return (
    <>
      <div className="flex items-center bg-slate-50 dark:bg-slate-800/40 border-t border-slate-200 dark:border-slate-700">
        <button
          onClick={() => setShowActive((v) => !v)}
          className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-xs hover-elevate"
          data-testid={`button-toggle-active-${agentName}`}
        >
          <span className="font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300 text-[11px]">
            In Transit — {remainingTransitRows.length} container{remainingTransitRows.length !== 1 ? "s" : ""}
            {prepaidTransitRows.length > 0 && (
              <span className="ml-1 text-emerald-600 dark:text-emerald-400">({prepaidTransitRows.length} prepaid)</span>
            )}{" "}
            · $
            {fmt(
              remainingTransitRows.reduce((s, r) => s + r.dutyFee, 0),
              0
            )}{" "}
            upcoming duty
          </span>
          {showActive ? (
            <ChevronUp className="h-3.5 w-3.5 text-slate-500" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
          )}
        </button>
        {transitTransporters.length > 1 && (
          <div className="flex items-center gap-1 pr-2" onClick={(e) => e.stopPropagation()}>
            <Filter className="h-3 w-3 text-slate-400 shrink-0" />
            <select
              value={transitTransporterFilter ?? ""}
              onChange={(e) => setTransitTransporterFilter(e.target.value || null)}
              className="text-[11px] bg-transparent border border-slate-300 dark:border-slate-600 rounded px-1.5 py-0.5 text-slate-600 dark:text-slate-300 focus:outline-none cursor-pointer"
              data-testid={`select-transit-transporter-${agentName}`}
            >
              <option value="">All transporters</option>
              {transitTransporters.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {showActive && (
        <div className="overflow-x-auto border-t border-slate-200 dark:border-slate-700">
          <table className="w-full text-xs whitespace-nowrap border-collapse" {...tableProps}>
            <thead>
              <tr className="bg-slate-600 dark:bg-slate-700 text-slate-100 border-b border-slate-500">
                {["CONTAINER", "SUPPLIER", "PLATE", "BORDER DATE", "TRANSPORTER", "LOCATION", "DUTY", ""].map((h) => (
                  <th key={h} className="py-1.5 px-2 font-semibold text-center tracking-wide text-[11px]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredTransitRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-3 px-3 text-center text-muted-foreground italic text-xs">
                    {transitTransporterFilter
                      ? "No containers for selected transporter."
                      : "All in-transit containers designated as prepaid."}
                  </td>
                </tr>
              ) : (
                filteredTransitRows.map((r) => {
                  const canDesignate =
                    prepaidBudget > 0 && designatedPrepaidSum + Number(r.dutyFee ?? 0) - 0.01 <= prepaidBudget;
                  return (
                    <tr key={r.id} className="border-b bg-sky-50/30 dark:bg-sky-950/10 text-muted-foreground">
                      <td className="py-0.5 px-2 font-mono text-center">{r.containerNumber}</td>
                      <td className="py-0.5 px-2 text-center">{r.supplierCode ?? r.supplierName ?? "—"}</td>
                      <td className="py-0.5 px-2 font-mono text-center">{r.numberPlate ?? "—"}</td>
                      <td className="py-0.5 px-2 text-center">{fmtD(r.borderDate)}</td>
                      <td className="py-0.5 px-2 text-center">{r.transporter ?? "—"}</td>
                      <td className="py-0.5 px-2 text-center">{r.location ?? "—"}</td>
                      <td className="py-0.5 px-2 text-right">${fmt(r.dutyFee, 0)}</td>
                      <td className="py-0.5 px-1 text-center">
                        {canDesignate && (
                          <button
                            onClick={() => {
                              const next = effectivePrepaidIds.includes(r.id)
                                ? effectivePrepaidIds
                                : [...effectivePrepaidIds, r.id];
                              setAllPrepaidMutate(next);
                            }}
                            title="Designate as prepaid"
                            data-testid={`button-designate-prepaid-${r.id}`}
                            className="text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
