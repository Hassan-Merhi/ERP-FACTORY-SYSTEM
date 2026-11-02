/**
 * EditableCellInput — extracted sub-component.
 *
 * Extracted from FactoryShippingContainers.tsx during the Phase 4 god-file split.
 */
import {useState, useEffect} from "react";
import {Input} from "@/components/ui/input";
import {Loader2} from "lucide-react";

export function EditableCellInput({
  value,
  placeholder,
  onSave,
  testId,
  saving,
}: {
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
  testId?: string;
  saving?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!editing) {
    return (
      <span
        className="shipping-editable cursor-pointer hover:text-foreground text-sm"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        data-testid={testId}
      >
        {saving ? (
          <Loader2 className="h-3 w-3 animate-spin inline" />
        ) : (
          value || <span className="text-muted-foreground italic text-xs">{placeholder || "—"}</span>
        )}
      </span>
    );
  }
  return (
    <Input
      autoFocus
      className="h-7 text-xs w-36"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        onSave(draft);
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onSave(draft);
          setEditing(false);
        }
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

// ─── Inline date cell ──────────────────────────────────────────────────────────
