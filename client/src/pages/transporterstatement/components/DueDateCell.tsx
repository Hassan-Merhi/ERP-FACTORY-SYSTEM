/**
 * DueDateCell — extracted sub-component.
 *
 * Extracted from TransporterStatement.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Button } from "@/components/ui/button";
import { Pencil, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

import type { StatementRow } from "../types";
import { today } from "../utils";

export function DueDateCell({
  row,
  onSave,
}: {
  row: StatementRow;
  onSave: (entryId: number, dueDate: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.dateToBePaid ?? "");
  const { formatDisplayDate: formatDate } = useDateFormat();

  function handleSave() {
    onSave(row.id, value || null);
    setEditing(false);
  }

  function handleCancel() {
    setValue(row.dateToBePaid ?? "");
    setEditing(false);
  }

  const isOverdue = row.dateToBePaid && row.dateToBePaid < today() && row.status !== "paid";

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          type="date"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          className="w-[130px] h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-hidden focus:ring-1 focus:ring-ring"
          data-testid={`input-due-date-${row.id}`}
        />
        <Button size="icon" variant="ghost" onClick={handleSave} data-testid={`btn-due-save-${row.id}`}>
          <Check className="h-3.5 w-3.5 text-green-600" />
        </Button>
        <Button size="icon" variant="ghost" onClick={handleCancel} data-testid={`btn-due-cancel-${row.id}`}>
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-1.5 group cursor-pointer"
      onClick={() => {
        setValue(row.dateToBePaid ?? "");
        setEditing(true);
      }}
      data-testid={`cell-due-date-${row.id}`}
    >
      {row.dateToBePaid ? (
        <span className={cn("text-sm", isOverdue ? "text-destructive font-medium" : "text-foreground")}>
          {formatDate(row.dateToBePaid)}
          {row.hasManualDueDate && <span className="ml-1 text-xs text-muted-foreground">(manual)</span>}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground/60 italic">set date</span>
      )}
      <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0 print:hidden" />
    </div>
  );
}

// ─── Settings Popover ────────────────────────────────────────────────────────
