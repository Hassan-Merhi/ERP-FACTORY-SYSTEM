// Extracted from ./ShippingAvailabilityTable.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import { Archive, Check, Trash2, X } from "lucide-react";
import { useShippingAvailabilityTableState } from "./useShippingAvailabilityTableState";

export function ShippingAvailabilityTableContent({
  activeRows,
  adding,
  addMutation,
  archiveMutation,
  canAddRow,
  deleteMutation,
  editing,
  handleAddKey,
  handleEditKey,
  newRow,
  recordChanges,
  saveMutation,
  setAdding,
  setEditing,
  setNewRow,
  startEdit,
}: Pick<
  ReturnType<typeof useShippingAvailabilityTableState>,
  | "activeRows"
  | "adding"
  | "addMutation"
  | "archiveMutation"
  | "canAddRow"
  | "deleteMutation"
  | "editing"
  | "handleAddKey"
  | "handleEditKey"
  | "newRow"
  | "recordChanges"
  | "saveMutation"
  | "setAdding"
  | "setEditing"
  | "setNewRow"
  | "startEdit"
>) {
  return (
    <>
      {activeRows.map((row) =>
        recordChanges.allowed && editing?.id === row.id ? (
          <TableRow key={row.id} className="bg-muted/30">
            <TableCell>
              <Input
                type="date"
                value={editing.date}
                onChange={(e) => setEditing({ ...editing, date: e.target.value })}
                onKeyDown={handleEditKey}
                className="h-7 text-xs"
                data-testid={`input-avail-date-${row.id}`}
              />
            </TableCell>
            <TableCell>
              <Input
                value={editing.shippingCompany}
                onChange={(e) => setEditing({ ...editing, shippingCompany: e.target.value })}
                onKeyDown={handleEditKey}
                className="h-7 text-xs"
                placeholder="e.g. Maersk"
                data-testid={`input-avail-company-${row.id}`}
              />
            </TableCell>
            <TableCell>
              <Input
                type="number"
                min="0"
                value={editing.availableContainers}
                onChange={(e) => setEditing({ ...editing, availableContainers: e.target.value })}
                onKeyDown={handleEditKey}
                className="h-7 text-xs"
                data-testid={`input-avail-count-${row.id}`}
              />
            </TableCell>
            <TableCell>
              <Input
                value={editing.note}
                onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                onKeyDown={handleEditKey}
                className="h-7 text-xs"
                placeholder="Optional note"
                data-testid={`input-avail-note-${row.id}`}
              />
            </TableCell>
            <TableCell>
              <Input
                value={editing.details}
                onChange={(e) => setEditing({ ...editing, details: e.target.value })}
                onKeyDown={handleEditKey}
                className="h-7 text-xs"
                placeholder="Type anything"
                data-testid={`input-avail-details-${row.id}`}
              />
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => saveMutation.mutate(editing)}
                  disabled={saveMutation.isPending}
                  data-testid={`button-avail-save-${row.id}`}
                >
                  <Check className="h-3.5 w-3.5 text-green-600" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setEditing(null)}
                  data-testid={`button-avail-cancel-${row.id}`}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ) : (
          <TableRow
            key={row.id}
            className={recordChanges.allowed ? "hover-elevate cursor-pointer" : undefined}
            onClick={recordChanges.allowed ? () => startEdit(row) : undefined}
            data-testid={`row-avail-${row.id}`}
          >
            <TableCell>{row.date}</TableCell>
            <TableCell>{row.shippingCompany}</TableCell>
            <TableCell>{row.availableContainers}</TableCell>
            <TableCell className="text-muted-foreground">{row.note || "—"}</TableCell>
            <TableCell className="text-muted-foreground">{row.details || "—"}</TableCell>
            <TableCell>
              {recordChanges.allowed && (
                <div className="flex items-center justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      archiveMutation.mutate({ id: row.id, archived: true });
                    }}
                    disabled={archiveMutation.isPending}
                    title="Archive this availability row"
                    data-testid={`button-avail-archive-${row.id}`}
                  >
                    <Archive className="h-3.5 w-3.5 mr-1" /> Archive
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMutation.mutate(row.id);
                    }}
                    disabled={deleteMutation.isPending}
                    data-testid={`button-avail-delete-${row.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              )}
            </TableCell>
          </TableRow>
        )
      )}
      {canAddRow && adding && (
        <TableRow className="bg-muted/30">
          <TableCell>
            <Input
              type="date"
              value={newRow.date}
              onChange={(e) => setNewRow({ ...newRow, date: e.target.value })}
              onKeyDown={handleAddKey}
              className="h-7 text-xs"
              autoFocus
              data-testid="input-new-avail-date"
            />
          </TableCell>
          <TableCell>
            <Input
              value={newRow.shippingCompany}
              onChange={(e) => setNewRow({ ...newRow, shippingCompany: e.target.value })}
              onKeyDown={handleAddKey}
              className="h-7 text-xs"
              placeholder="e.g. Maersk"
              data-testid="input-new-avail-company"
            />
          </TableCell>
          <TableCell>
            <Input
              type="number"
              min="0"
              value={newRow.availableContainers}
              onChange={(e) => setNewRow({ ...newRow, availableContainers: e.target.value })}
              onKeyDown={handleAddKey}
              className="h-7 text-xs"
              placeholder="0"
              data-testid="input-new-avail-count"
            />
          </TableCell>
          <TableCell>
            <Input
              value={newRow.note}
              onChange={(e) => setNewRow({ ...newRow, note: e.target.value })}
              onKeyDown={handleAddKey}
              className="h-7 text-xs"
              placeholder="Optional note"
              data-testid="input-new-avail-note"
            />
          </TableCell>
          <TableCell>
            <Input
              value={newRow.details}
              onChange={(e) => setNewRow({ ...newRow, details: e.target.value })}
              onKeyDown={handleAddKey}
              className="h-7 text-xs"
              placeholder="Type anything"
              data-testid="input-new-avail-details"
            />
          </TableCell>
          <TableCell>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => addMutation.mutate()}
                disabled={addMutation.isPending || !newRow.date || !newRow.shippingCompany.trim()}
                data-testid="button-new-avail-save"
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
                    availableContainers: "",
                    note: "",
                    details: "",
                  });
                }}
                data-testid="button-new-avail-cancel"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
