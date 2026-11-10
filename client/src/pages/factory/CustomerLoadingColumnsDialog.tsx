import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { COLUMN_OPTIONS, type ColumnKey } from "./customerLoadingTypes";

interface CustomerLoadingColumnsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  visibleColumns: ReadonlySet<ColumnKey>;
  onToggleColumn: (key: ColumnKey, checked: boolean) => void;
  onShowAll: () => void;
}

export function CustomerLoadingColumnsDialog({
  open,
  onOpenChange,
  visibleColumns,
  onToggleColumn,
  onShowAll,
}: CustomerLoadingColumnsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden rounded-2xl border-slate-200 p-0 dark:border-slate-700">
        <DialogHeader className="border-b bg-gradient-to-r from-indigo-50 to-violet-50 px-5 py-4 dark:border-slate-700 dark:from-[hsl(var(--factory-hue)_51%_21%)] dark:to-[hsl(var(--factory-hue)_33%_22%)]">
          <DialogTitle className="text-lg font-bold">Visible Columns</DialogTitle>
          <DialogDescription>
            Choose which columns to show. Your preferences are saved in this browser.
          </DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[55vh] gap-2 overflow-y-auto px-5 py-4 sm:grid-cols-2">
          {COLUMN_OPTIONS.map((column) => (
            <label
              key={column.key}
              className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-sm transition-colors hover:bg-indigo-50 dark:border-slate-700 dark:bg-slate-800/40 dark:hover:bg-indigo-500/10"
            >
              <Checkbox
                checked={visibleColumns.has(column.key)}
                onCheckedChange={(checked) => onToggleColumn(column.key, Boolean(checked))}
              />
              <span>{column.label}</span>
            </label>
          ))}
        </div>
        <DialogFooter className="gap-2 border-t bg-slate-50 px-5 py-4 dark:border-slate-700 dark:bg-slate-800/30 sm:justify-between">
          <Button variant="outline" onClick={onShowAll}>
            Show All
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
