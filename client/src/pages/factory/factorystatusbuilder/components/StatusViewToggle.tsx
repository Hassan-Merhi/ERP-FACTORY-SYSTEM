import { History as HistoryIcon, LayoutGrid } from "lucide-react";

interface StatusViewToggleProps {
  viewMode: "sheet" | "history";
  onChange: (mode: "sheet" | "history") => void;
}

export function StatusViewToggle({ viewMode, onChange }: StatusViewToggleProps) {
  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-2 bg-card">
      <div className="flex shrink-0 items-center gap-1 overflow-hidden rounded-xl border border-border/60 bg-muted/50 p-1 shadow-inner">
        <button
          onClick={() => onChange("sheet")}
          data-testid="sb-button-view-sheet"
          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            viewMode === "sheet" ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20" : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
          }`}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          Sheet
        </button>
        <button
          onClick={() => onChange("history")}
          data-testid="sb-button-view-history"
          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
            viewMode === "history" ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20" : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
          }`}
        >
          <HistoryIcon className="h-3.5 w-3.5" />
          History
        </button>
      </div>
    </div>
  );
}
