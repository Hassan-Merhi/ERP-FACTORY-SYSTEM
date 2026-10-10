/**
 * NotesCell — extracted sub-component.
 *
 * Extracted from FactoryOtwTrackingTab.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { Input } from "@/components/ui/input";

export // ── Inline notes cell ────────────────────────────────────────────────────────
function NotesCell({
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

  function startEdit(e: React.MouseEvent) {
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
        className="h-7 text-xs min-w-[140px]"
        data-testid={`input-notes-${containerId}`}
      />
    );
  }
  return (
    <span
      className={`text-xs cursor-pointer rounded-sm px-1 py-0.5 hover-elevate max-w-[140px] truncate block ${current ? "text-foreground" : "text-muted-foreground italic"}`}
      onClick={startEdit}
      data-testid={`text-notes-${containerId}`}
      title={current || "Click to add note"}
    >
      {current || "Add note…"}
    </span>
  );
}

// ── Event Timeline Sheet ─────────────────────────────────────────────────────
