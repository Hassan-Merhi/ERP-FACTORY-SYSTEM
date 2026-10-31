import { useState } from "react";
import type { MouseEvent } from "react";
import { Pencil } from "lucide-react";
import { Input } from "@/components/ui/input";

/** The existing inline note PATCH workflow stays intact. */
export function NotesCell({
  containerId,
  note,
  onSave,
}: {
  containerId: number;
  note: string;
  onSave: (id: number, val: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const current = note ?? "";

  function startEdit(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    setDraft(current);
    setEditing(true);
  }
  function commit() {
    onSave(containerId, draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-8 min-w-[140px] rounded-lg text-xs"
        data-testid={"input-notes-" + containerId}
      />
    );
  }

  return (
    <button
      type="button"
      className="inline-flex min-h-8 w-full max-w-[180px] items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-blue-500/40 hover:bg-blue-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
      onClick={startEdit}
      data-testid={"text-notes-" + containerId}
      title={current || "Click to add a note"}
      aria-label={"Edit note for container " + containerId}
    >
      <span className="min-w-0 flex-1 truncate">{current || "Add note..."}</span>
      <Pencil className="h-3 w-3 shrink-0 opacity-50" />
    </button>
  );
}
