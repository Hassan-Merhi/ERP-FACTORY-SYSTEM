import type { CellValue } from "../types";
import { fmt } from "../utils";

/** Footer "DIFFERENCE" row, aligned with the visible columns. */
export function StatusDiffFooterRow({
  diffRow,
  columnIds,
  hiddenColumnIds,
}: {
  diffRow: Array<CellValue | "#REF!" | "#CYCLE!">;
  columnIds: string[];
  hiddenColumnIds: string[];
}) {
  return (
    <tr className="bg-amber-500/[0.10] dark:bg-amber-950/35">
      <td className="border-t-2 border-r border-amber-500/40 px-4 py-3">
        <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">DIFFERENCE</span>
      </td>
      {diffRow.map((val, ci) => {
        const isNeg = typeof val === "number" && val < 0;
        return (
          <td
            key={ci}
            className={`border-t-2 border-r border-amber-500/40 px-3 py-3 text-center text-sm font-bold tabular-nums ${hiddenColumnIds.includes(columnIds[ci]) ? "hidden" : ""}`}
            data-testid={`sb-footer-diff-${ci}`}
          >
            <span className={isNeg ? "text-red-500" : "text-amber-700 dark:text-amber-400"}>{fmt(val)}</span>
          </td>
        );
      })}
      <td className="border border-border" />
    </tr>
  );
}
