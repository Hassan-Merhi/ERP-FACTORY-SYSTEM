import { Badge } from "@/components/ui/badge";
import { History as HistoryIcon } from "lucide-react";

interface StatusBuilderHistoryEntry {
  id: number;
  rowLabel: string;
  columnLabel: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

interface StatusHistoryPanelProps {
  historyLoading: boolean;
  historyLog: StatusBuilderHistoryEntry[] | undefined;
}

export function StatusHistoryPanel({ historyLoading, historyLog }: StatusHistoryPanelProps) {
  return (
    <div className="flex-1 overflow-auto p-4">
      {historyLoading ? (
        <div className="text-center text-sm text-muted-foreground py-8">Loading history…</div>
      ) : !historyLog || historyLog.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-8">No changes recorded yet for this page.</div>
      ) : (
        <div className="space-y-2 max-w-2xl mx-auto">
          {historyLog.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm"
              data-testid={`sb-history-entry-${entry.id}`}
            >
              <HistoryIcon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{entry.rowLabel}</span>
                  <Badge variant="outline" className="text-[11px]">
                    {entry.columnLabel}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {entry.oldValue ? `"${entry.oldValue}"` : "(empty)"} →{" "}
                  {entry.newValue ? `"${entry.newValue}"` : "(empty)"}
                </div>
              </div>
              <span className="text-xs text-muted-foreground shrink-0">
                {new Date(entry.createdAt).toLocaleString([], {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
