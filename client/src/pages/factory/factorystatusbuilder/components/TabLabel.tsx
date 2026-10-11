/**
 * TabLabel — extracted sub-component.
 *
 * Extracted from FactoryStatusBuilder.tsx during the Phase 4 god-file split.
 */
import { useState, useEffect, useRef } from "react";
import {} from "@/components/ui/dialog";
import { X } from "lucide-react";

export function TabLabel({
  name,
  active,
  onActivate,
  onRename,
  onDelete,
  canDelete,
}: {
  name: string;
  active: boolean;
  onActivate: () => void;
  onRename: (v: string) => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = () => {
    const v = draft.trim();
    if (v && v !== name) onRename(v);
    else setDraft(name);
    setEditing(false);
  };

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  return (
    <div
      data-testid={`sb-tab-${name}`}
      onClick={onActivate}
      onDoubleClick={() => {
        setEditing(true);
        setDraft(name);
      }}
      className={`relative flex items-center gap-1.5 px-3 py-2 cursor-pointer border-b-2 select-none whitespace-nowrap transition-colors
        ${
          active
            ? "border-primary text-foreground font-medium"
            : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted"
        }`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(name);
              setEditing(false);
            }
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          className="bg-transparent border-none outline-hidden w-24 text-sm font-medium"
          data-testid={`sb-tab-input-${name}`}
        />
      ) : (
        <span className="text-sm">{name}</span>
      )}
      {active && canDelete && (
        <button
          data-testid={`sb-tab-delete-${name}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="ml-1 rounded-xs opacity-60 hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
          style={{ visibility: "visible" }}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// ── Link Dialog ────────────────────────────────────────────────────────────────
