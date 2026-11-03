import { Plus } from "lucide-react";

/** The sheet's "Add row" table row, aligned with the visible columns. */
export function StatusAddRow({
  columnIds,
  hiddenColumnIds,
  onAddRow,
}: {
  columnIds: string[];
  hiddenColumnIds: string[];
  onAddRow: () => void;
}) {
  return (
    <tr>
      <td className="border-b border-r border-border/50 bg-muted/10 px-2 py-2">
        <button
          data-testid="sb-button-add-row"
          onClick={onAddRow}
          className="flex w-full items-center gap-1 rounded px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-blue-600 dark:hover:text-blue-400"
        >
          <Plus className="h-3 w-3" />
          Add row
        </button>
      </td>
      {columnIds.map((id) => (
        <td key={id} className={`border-b border-r border-border/50 ${hiddenColumnIds.includes(id) ? "hidden" : ""}`} />
      ))}
      <td className="border-b border-border/50" />
    </tr>
  );
}
