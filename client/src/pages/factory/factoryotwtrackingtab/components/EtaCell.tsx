/**
 * EtaCell — extracted sub-component.
 *
 * Extracted from FactoryOtwTrackingTab.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fmtDate } from "../utils";

export // ── Inline ETA cell ──────────────────────────────────────────────────────────
function EtaCell({
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

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation();
    const plain = arrivalDate ? arrivalDate.slice(0, 10) : "";
    setDraft(plain);
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
        className="h-7 text-xs w-[120px]"
        data-testid={`input-eta-${containerId}`}
      />
    );
  }
  return (
    <span
      className={cn(
        "text-xs cursor-pointer rounded-sm px-1 py-0.5 hover-elevate block font-medium",
        overdue ? "text-red-600 dark:text-red-400" : arrivalDate ? "text-foreground" : "text-muted-foreground italic"
      )}
      onClick={startEdit}
      data-testid={`text-eta-${containerId}`}
      title="Click to edit ETA"
    >
      {arrivalDate ? fmtDate(arrivalDate) : "Set ETA…"}
    </span>
  );
}

// ── Inline notes cell ────────────────────────────────────────────────────────
