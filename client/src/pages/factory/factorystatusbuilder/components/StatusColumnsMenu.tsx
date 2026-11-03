import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Columns3 } from "lucide-react";

/** The sheet's "Columns" menu: show or hide each column, or show them all. */
export function StatusColumnsMenu({
  columns,
  hiddenColumnIds,
  onSetHidden,
  onShowAll,
}: {
  columns: Array<{ id: string; label: string }>;
  hiddenColumnIds: string[];
  onSetHidden: (columnId: string, hidden: boolean) => void;
  onShowAll: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 rounded-lg border-border/70 bg-background/80 text-foreground shadow-sm"
          data-testid="sb-button-columns"
          aria-label="Choose visible columns"
        >
          <Columns3 className="mr-1.5 h-4 w-4 text-blue-500" />
          Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 rounded-lg">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Show or hide columns</div>
        <DropdownMenuSeparator />
        {columns.map((col, ci) => (
          <DropdownMenuCheckboxItem
            key={col.id}
            checked={!hiddenColumnIds.includes(col.id)}
            onCheckedChange={(checked) => onSetHidden(col.id, !checked)}
            data-testid={`sb-toggle-column-${ci}`}
          >
            <span className="truncate">{col.label || `Column ${ci + 1}`}</span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onShowAll} data-testid="sb-show-all-columns">
          Show all columns
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
