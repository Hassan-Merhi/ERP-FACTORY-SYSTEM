import type { BaleDetail } from "./types";
import { STATUS_COLORS, formatDailyNum, formatHistoryDateTime } from "./utils";
import { StockEntryHistoryEditableDateCell } from "./EditableDateCell";

interface DetailedHistoryTableProps {
  isLoading: boolean;
  allBales: BaleDetail[];
  editingDateKey: string | null;
  setEditingDateKey: (key: string | null) => void;
  formatDisplayDate: (date: string) => string;
  onUpdateDate: (baleId: number, stockEntryDate: string) => void;
}

export function DetailedHistoryTable({
  isLoading,
  allBales,
  editingDateKey,
  setEditingDateKey,
  formatDisplayDate,
  onUpdateDate,
}: DetailedHistoryTableProps) {
  return (
    <div className="rounded-xl border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-30 bg-muted border-b-2 border-border/60">
          <tr className="text-left">
            <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground tracking-wide">Reference</th>
            <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground tracking-wide">Date</th>
            <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground tracking-wide">Location</th>
            <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground tracking-wide">Worker</th>
            <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground tracking-wide">Product</th>
            <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground tracking-wide">Article</th>
            <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground tracking-wide">
              Weight (kg)
            </th>
            <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground tracking-wide">Status</th>
            <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground tracking-wide">Finalized At</th>
          </tr>
        </thead>
        <tbody>
          {isLoading && (
            <tr>
              <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                Loading…
              </td>
            </tr>
          )}
          {!isLoading && allBales.length === 0 && (
            <tr>
              <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                No bales found for the selected filters.
              </td>
            </tr>
          )}
          {allBales.map((bale, index) => (
            <tr
              key={bale.id}
              className={`border-t ${index % 2 === 1 ? "bg-muted/20" : ""}`}
              data-testid={`row-bale-${bale.id}`}
            >
              <td className="px-3 py-1.5 font-mono text-xs">{bale.referenceNumber}</td>
              <td className="px-3 py-1.5">
                <StockEntryHistoryEditableDateCell
                  dateStr={bale.stockEntryDate || ""}
                  editKey={`bale-${bale.id}`}
                  onSave={(newDate) => onUpdateDate(bale.id, newDate)}
                  editingDateKey={editingDateKey}
                  setEditingDateKey={setEditingDateKey}
                  formatDisplayDate={formatDisplayDate}
                />
              </td>
              <td className="px-3 py-1.5">{bale.locationName}</td>
              <td className="px-3 py-1.5">
                {bale.workerName || <span className="italic text-muted-foreground text-xs">Unassigned</span>}
              </td>
              <td className="px-3 py-1.5">{bale.productName || "—"}</td>
              <td className="px-3 py-1.5 text-muted-foreground text-xs">{bale.articleCode || "—"}</td>
              <td className="px-3 py-1.5 text-right">{formatDailyNum(parseFloat(bale.weightKg || "0"))}</td>
              <td className="px-3 py-1.5">
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold ${STATUS_COLORS[bale.status] || "bg-muted text-muted-foreground"}`}
                >
                  {bale.status}
                </span>
              </td>
              <td className="px-3 py-1.5 text-muted-foreground text-xs">
                {formatHistoryDateTime(bale.finalizedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
