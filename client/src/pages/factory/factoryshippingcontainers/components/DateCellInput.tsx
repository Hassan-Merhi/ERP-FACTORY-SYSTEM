/**
 * DateCellInput — extracted sub-component.
 *
 * Extracted from FactoryShippingContainers.tsx during the Phase 4 god-file split.
 */
import {useState, useEffect} from "react";
import {Input} from "@/components/ui/input";
import {fmtDate} from "../utils";

export function DateCellInput({
  value,
  placeholder,
  onSave,
  testId,
}: {
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
  testId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!editing) {
    const display = fmtDate(value);
    return (
      <span
        className="shipping-editable cursor-pointer hover:text-foreground text-sm"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        data-testid={testId}
      >
        {display !== "—" ? display : <span className="text-muted-foreground italic text-xs">{placeholder || "—"}</span>}
      </span>
    );
  }
  return (
    <Input
      autoFocus
      type="date"
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

// ─── Documents Modal ───────────────────────────────────────────────────────────
