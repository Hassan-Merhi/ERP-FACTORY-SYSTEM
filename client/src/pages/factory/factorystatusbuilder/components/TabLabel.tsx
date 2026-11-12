/**
 * TabLabel — extracted sub-component.
 *
 * Extracted from FactoryStatusBuilder.tsx during the Phase 4 god-file split.
 */
import { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useActiveTabVisibility } from "@/components/ui/tabs";

export function TabLabel({
  name,
  active,
  onActivate,
  onRename,
  onDelete,
  canDelete,
  canRename = true,
}: {
  name: string;
  active: boolean;
  onActivate: () => void;
  onRename: (v: string) => void;
  onDelete: () => void;
  canDelete: boolean;
  /** False for read-only company roles: the page name cannot be edited. */
  canRename?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const tabRef = useRef<HTMLDivElement>(null);
  useActiveTabVisibility(tabRef, active);

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
      ref={tabRef}
      data-testid={`sb-tab-${name}`}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        } else if (event.key === "F2" && canRename) {
          // Keyboard equivalent of double-click rename.
          event.preventDefault();
          setEditing(true);
          setDraft(name);
        }
      }}
      onDoubleClick={() => {
        if (!canRename) return;
        setEditing(true);
        setDraft(name);
      }}
      className={`relative flex min-h-11 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-full border px-4 py-2 text-sm transition-all motion-reduce:transition-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-9 ${active ? "border-blue-500/50 bg-blue-600/10 font-semibold text-blue-700 shadow-sm dark:border-blue-500/60 dark:bg-blue-500/15 dark:text-blue-300" : "border-border/60 bg-muted/30 text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground"}`}
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
          type="button"
          aria-label={`Delete page ${name}`}
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
