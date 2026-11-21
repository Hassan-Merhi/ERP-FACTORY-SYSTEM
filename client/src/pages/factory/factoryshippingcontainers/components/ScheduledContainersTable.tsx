/** Scheduled containers — a separate company-scoped schedule above container availability. */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Check, ChevronDown, ChevronRight, Loader2, Plus, Trash2, X } from "lucide-react";
import { useScheduledContainersTableState } from "./useScheduledContainersTableState";
import { ScheduledContainersTableTableRow } from "./ScheduledContainersTableTableRow";

export function ScheduledContainersTable() {
  const {
    recordChanges,
    canAddRow,
    editing,
    setEditing,
    setAdding,
    adding,
    expanded,
    setExpanded,
    newRow,
    setNewRow,
    isLoading,
    isError,
    refetch,
    activeRows,
    addMutation,
    saveMutation,
    deleteMutation,
    startEdit,
    handleAddKey,
    handleEditKey,
  } = useScheduledContainersTableState();

  return (
    <div className="space-y-3">
      <div className="rounded-md border overflow-hidden">
        <div className={`flex items-center justify-between px-4 py-3 bg-muted/20 ${expanded ? "border-b" : ""}`}>
          <button
            type="button"
            className="flex flex-1 items-center gap-2 text-left text-sm font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            data-testid="button-toggle-scheduled"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span>Scheduled Containers</span>
            <span className="text-xs text-muted-foreground">({activeRows.length})</span>
          </button>
          {canAddRow && (
            <Button
              size="sm"
              onClick={() => {
                setExpanded(true);
                setAdding(true);
              }}
              disabled={adding}
              data-testid="button-add-scheduled"
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Row
            </Button>
          )}
        </div>

        {expanded && (
          <div className="overflow-x-auto">
            <Table mobileLayout="cards" className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs w-36">Date</TableHead>
                  <TableHead className="text-xs">Shipping Company</TableHead>
                  <TableHead className="text-xs w-40">Scheduled Containers</TableHead>
                  <TableHead className="text-xs">Note</TableHead>
                  <TableHead className="text-xs">Details</TableHead>
                  <TableHead className="text-xs w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : isError && activeRows.length === 0 && !adding ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-6 text-destructive">
                      Could not load scheduled containers.
                      <Button size="sm" variant="outline" className="ml-3" onClick={() => void refetch()}>
                        Retry
                      </Button>
                    </TableCell>
                  </TableRow>
                ) : activeRows.length === 0 && !adding ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                      No active rows. Click "Add Row" to start.
                    </TableCell>
                  </TableRow>
                ) : (
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
                              data-testid={`input-scheduled-date-${row.id}`}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={editing.shippingCompany}
                              onChange={(e) => setEditing({ ...editing, shippingCompany: e.target.value })}
                              onKeyDown={handleEditKey}
                              className="h-7 text-xs"
                              placeholder="e.g. Maersk"
                              data-testid={`input-scheduled-company-${row.id}`}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min="0"
                              value={editing.scheduledContainers}
                              onChange={(e) => setEditing({ ...editing, scheduledContainers: e.target.value })}
                              onKeyDown={handleEditKey}
                              className="h-7 text-xs"
                              data-testid={`input-scheduled-count-${row.id}`}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={editing.note}
                              onChange={(e) => setEditing({ ...editing, note: e.target.value })}
                              onKeyDown={handleEditKey}
                              className="h-7 text-xs"
                              placeholder="Optional note"
                              data-testid={`input-scheduled-note-${row.id}`}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              value={editing.details}
                              onChange={(e) => setEditing({ ...editing, details: e.target.value })}
                              onKeyDown={handleEditKey}
                              className="h-7 text-xs"
                              placeholder="Type anything"
                              data-testid={`input-scheduled-details-${row.id}`}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => saveMutation.mutate(editing)}
                                disabled={saveMutation.isPending}
                                data-testid={`button-scheduled-save-${row.id}`}
                              >
                                <Check className="h-3.5 w-3.5 text-green-600" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setEditing(null)}
                                data-testid={`button-scheduled-cancel-${row.id}`}
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
                          data-testid={`row-scheduled-${row.id}`}
                        >
                          <TableCell>{row.date}</TableCell>
                          <TableCell>{row.shippingCompany}</TableCell>
                          <TableCell>{row.scheduledContainers}</TableCell>
                          <TableCell className="text-muted-foreground">{row.note || "—"}</TableCell>
                          <TableCell className="text-muted-foreground">{row.details || "—"}</TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              {recordChanges.allowed && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    deleteMutation.mutate(row.id);
                                  }}
                                  disabled={deleteMutation.isPending}
                                  data-testid={`button-scheduled-delete-${row.id}`}
                                >
                                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    )}
                    {canAddRow && adding && (
                      <ScheduledContainersTableTableRow
                        addMutation={addMutation}
                        handleAddKey={handleAddKey}
                        newRow={newRow}
                        setAdding={setAdding}
                        setNewRow={setNewRow}
                      />
                    )}
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
