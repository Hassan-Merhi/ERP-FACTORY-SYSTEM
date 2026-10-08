import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { StockEntryWorker } from "./derived";
import type { BaleDetail } from "./types";
import { STATUS_COLORS, formatDailyNum, formatHistoryDateTime } from "./utils";
import { StockEntryHistoryEditableDateCell } from "./EditableDateCell";

interface DetailedHistoryTableProps {
  isLoading: boolean;
  allBales: BaleDetail[];
  workers: StockEntryWorker[];
  editingDateKey: string | null;
  setEditingDateKey: (key: string | null) => void;
  formatDisplayDate: (date: string) => string;
  onUpdateDate: (baleId: number, stockEntryDate: string) => void;
  onAssignWorker: (baleId: number, workerId: number) => void;
}

export function DetailedHistoryTable({
  isLoading,
  allBales,
  workers,
  editingDateKey,
  setEditingDateKey,
  formatDisplayDate,
  onUpdateDate,
  onAssignWorker,
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
                <Select
                  value={bale.workerId != null ? String(bale.workerId) : ""}
                  onValueChange={(value) => {
                    const workerId = Number(value);
                    if (Number.isInteger(workerId) && workerId > 0 && workerId !== bale.workerId) {
                      onAssignWorker(bale.id, workerId);
                    }
                  }}
                >
                  <SelectTrigger
                    className="h-7 min-w-32 text-xs"
                    aria-label={`Change assigned name for ${bale.referenceNumber}`}
                    data-testid={`select-assign-worker-bale-${bale.id}`}
                  >
                    <SelectValue placeholder={bale.workerName || "Unassigned"} />
                  </SelectTrigger>
                  <SelectContent>
                    {bale.workerId != null &&
                      !workers.some((worker) => worker.id === bale.workerId && worker.active) && (
                        <SelectItem value={String(bale.workerId)} disabled>
                          {bale.workerName || "Inactive worker"}
                        </SelectItem>
                      )}
                    {workers
                      .filter((worker) => worker.active)
                      .map((worker) => (
                        <SelectItem key={worker.id} value={String(worker.id)}>
                          {worker.fullName || worker.full_name || worker.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
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
              <td className="px-3 py-1.5 text-muted-foreground text-xs">{formatHistoryDateTime(bale.finalizedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
