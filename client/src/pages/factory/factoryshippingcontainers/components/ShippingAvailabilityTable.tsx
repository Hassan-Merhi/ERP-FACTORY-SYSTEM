/**
 * ShippingAvailabilityTable — extracted sub-component.
 *
 * Extracted from FactoryShippingContainers.tsx during the Phase 4 god-file split.
 */
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronRight, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useShippingAvailabilityTableState } from "./useShippingAvailabilityTableState";
import { ShippingAvailabilityTableContent } from "./ShippingAvailabilityTableContent";

export function ShippingAvailabilityTable() {
  const {
    recordChanges,
    canAddRow,
    editing,
    setEditing,
    setAdding,
    adding,
    expanded,
    setExpanded,
    setArchivedExpanded,
    archivedExpanded,
    newRow,
    setNewRow,
    isLoading,
    activeRows,
    archivedRows,
    addMutation,
    saveMutation,
    archiveMutation,
    deleteMutation,
    startEdit,
    handleAddKey,
    handleEditKey,
  } = useShippingAvailabilityTableState();

  return (
    <div className="space-y-3">
      <div className="rounded-md border overflow-hidden">
        <div className={`flex items-center justify-between px-4 py-3 bg-muted/20 ${expanded ? "border-b" : ""}`}>
          <button
            type="button"
            className="flex flex-1 items-center gap-2 text-left text-sm font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            data-testid="button-toggle-availability"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <span>Container Availability</span>
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
              data-testid="button-add-availability"
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
                  <TableHead className="text-xs w-40">Available Containers</TableHead>
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
                ) : activeRows.length === 0 && !adding ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                      No active rows. Click "Add Row" to start.
                    </TableCell>
                  </TableRow>
                ) : (
                  <ShippingAvailabilityTableContent
                    activeRows={activeRows}
                    adding={adding}
                    addMutation={addMutation}
                    archiveMutation={archiveMutation}
                    canAddRow={canAddRow}
                    deleteMutation={deleteMutation}
                    editing={editing}
                    handleAddKey={handleAddKey}
                    handleEditKey={handleEditKey}
                    newRow={newRow}
                    recordChanges={recordChanges}
                    saveMutation={saveMutation}
                    setAdding={setAdding}
                    setEditing={setEditing}
                    setNewRow={setNewRow}
                    startEdit={startEdit}
                  />
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <div className="rounded-md border overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-muted-foreground hover-elevate bg-muted/20"
          onClick={() => setArchivedExpanded((value) => !value)}
          aria-expanded={archivedExpanded}
          data-testid="button-toggle-archived-availability"
        >
          <span className="flex items-center gap-2">
            {archivedExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Archived Container Availability
            <span className="text-xs">({archivedRows.length})</span>
          </span>
          <span className="text-xs">Archived rows stay here until restored or deleted</span>
        </button>

        {archivedExpanded &&
          (archivedRows.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No archived availability rows yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table mobileLayout="cards" className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs w-36">Date</TableHead>
                    <TableHead className="text-xs">Shipping Company</TableHead>
                    <TableHead className="text-xs w-40">Available Containers</TableHead>
                    <TableHead className="text-xs">Note</TableHead>
                    <TableHead className="text-xs">Details</TableHead>
                    <TableHead className="text-xs w-44">Archived</TableHead>
                    <TableHead className="text-xs w-40" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {archivedRows.map((row) => (
                    <TableRow key={row.id} className="opacity-70" data-testid={`row-archived-avail-${row.id}`}>
                      <TableCell>{row.date}</TableCell>
                      <TableCell>{row.shippingCompany}</TableCell>
                      <TableCell>{row.availableContainers}</TableCell>
                      <TableCell className="text-muted-foreground">{row.note || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{row.details || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {row.archivedAt ? new Date(row.archivedAt).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell>
                        {recordChanges.allowed && (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => archiveMutation.mutate({ id: row.id, archived: false })}
                              disabled={archiveMutation.isPending}
                              data-testid={`button-avail-restore-${row.id}`}
                            >
                              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restore
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => deleteMutation.mutate(row.id)}
                              disabled={deleteMutation.isPending}
                              data-testid={`button-avail-delete-archived-${row.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
