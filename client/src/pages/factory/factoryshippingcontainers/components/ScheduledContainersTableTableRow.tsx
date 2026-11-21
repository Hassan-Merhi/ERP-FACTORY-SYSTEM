// Extracted from ./ScheduledContainersTable.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import { Check, X } from "lucide-react";
import { useScheduledContainersTableState } from "./useScheduledContainersTableState";

export function ScheduledContainersTableTableRow({
  addMutation,
  handleAddKey,
  newRow,
  setAdding,
  setNewRow,
}: Pick<
  ReturnType<typeof useScheduledContainersTableState>,
  "addMutation" | "handleAddKey" | "newRow" | "setAdding" | "setNewRow"
>) {
  return (
    <TableRow className="bg-muted/30">
      <TableCell>
        <Input
          type="date"
          value={newRow.date}
          onChange={(e) => setNewRow({ ...newRow, date: e.target.value })}
          onKeyDown={handleAddKey}
          className="h-7 text-xs"
          autoFocus
          data-testid="input-new-scheduled-date"
        />
      </TableCell>
      <TableCell>
        <Input
          value={newRow.shippingCompany}
          onChange={(e) => setNewRow({ ...newRow, shippingCompany: e.target.value })}
          onKeyDown={handleAddKey}
          className="h-7 text-xs"
          placeholder="e.g. Maersk"
          data-testid="input-new-scheduled-company"
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          min="0"
          value={newRow.scheduledContainers}
          onChange={(e) => setNewRow({ ...newRow, scheduledContainers: e.target.value })}
          onKeyDown={handleAddKey}
          className="h-7 text-xs"
          placeholder="0"
          data-testid="input-new-scheduled-count"
        />
      </TableCell>
      <TableCell>
        <Input
          value={newRow.note}
          onChange={(e) => setNewRow({ ...newRow, note: e.target.value })}
          onKeyDown={handleAddKey}
          className="h-7 text-xs"
          placeholder="Optional note"
          data-testid="input-new-scheduled-note"
        />
      </TableCell>
      <TableCell>
        <Input
          value={newRow.details}
          onChange={(e) => setNewRow({ ...newRow, details: e.target.value })}
          onKeyDown={handleAddKey}
          className="h-7 text-xs"
          placeholder="Type anything"
          data-testid="input-new-scheduled-details"
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => addMutation.mutate()}
            disabled={addMutation.isPending || !newRow.date || !newRow.shippingCompany.trim()}
            data-testid="button-new-scheduled-save"
          >
            <Check className="h-3.5 w-3.5 text-green-600" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => {
              setAdding(false);
              setNewRow({
                date: "",
                shippingCompany: "",
                scheduledContainers: "",
                note: "",
                details: "",
              });
            }}
            data-testid="button-new-scheduled-cancel"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
