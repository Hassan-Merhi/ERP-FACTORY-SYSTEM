import { useState } from "react";
import type { MouseEvent } from "react";
import { CalendarDays } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fmtDate } from "../utils";

/** Inline ETA editing is intentionally preserved by the OTW redesign. */
export function EtaCell({
  containerId,
  arrivalDate,
  overdue,
  onSave,
}: {
  containerId: number;
  arrivalDate: string | null | undefined;
  overdue: boolean;
  onSave: (id: number, val: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  function startEdit(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    setDraft(arrivalDate ? arrivalDate.slice(0, 10) : "");
    setEditing(true);
  }

  function commit() {
    onSave(containerId, draft || null);
    setEditing(false);
  }

  if (editing) {
    return (
      <Input
        autoFocus
        type="date"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-8 w-[138px] rounded-lg text-xs"
        data-testid={"input-eta-" + containerId}
      />
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "inline-flex min-h-7 items-center gap-1.5 rounded-lg border border-transparent px-2 py-1 text-xs font-semibold transition-colors hover:border-blue-500/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50",
        overdue
          ? "bg-red-500/10 text-red-700 dark:bg-red-400/15 dark:text-red-300"
          : arrivalDate
            ? "bg-blue-500/10 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300"
            : "bg-muted/70 text-muted-foreground"
      )}
      onClick={startEdit}
      data-testid={"text-eta-" + containerId}
      title="Click to edit ETA"
      aria-label={"Edit ETA for container " + containerId}
    >
      <CalendarDays className="h-3.5 w-3.5 shrink-0" />
      {arrivalDate ? fmtDate(arrivalDate) : "Set ETA..."}
    </button>
  );
}
