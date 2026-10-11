interface EditableDateCellProps {
  dateStr: string;
  editKey: string;
  editingDateKey: string | null;
  setEditingDateKey: (key: string | null) => void;
  formatDisplayDate: (date: string) => string;
  onSave: (newDate: string) => void;
}

export function StockEntryHistoryEditableDateCell({
  dateStr,
  editKey,
  editingDateKey,
  setEditingDateKey,
  formatDisplayDate,
  onSave,
}: EditableDateCellProps) {
  const isEditing = editingDateKey === editKey;
  if (isEditing) {
    return (
      <input
        autoFocus
        type="date"
        defaultValue={dateStr}
        className="border rounded-sm px-1 py-0.5 text-xs w-32"
        onBlur={(event) => {
          const value = event.target.value;
          if (value && value !== dateStr) onSave(value);
          else setEditingDateKey(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setEditingDateKey(null);
          if (event.key === "Enter") {
            const value = (event.target as HTMLInputElement).value;
            if (value && value !== dateStr) onSave(value);
            else setEditingDateKey(null);
          }
        }}
      />
    );
  }

  return (
    <span
      className="cursor-pointer hover:underline hover:text-primary"
      title="Click to edit date"
      onClick={() => setEditingDateKey(editKey)}
    >
      {dateStr ? formatDisplayDate(dateStr) : "—"}
    </span>
  );
}
