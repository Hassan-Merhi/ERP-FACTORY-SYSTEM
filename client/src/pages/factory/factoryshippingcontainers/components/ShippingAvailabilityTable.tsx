import type { ClientErrorLike } from "@/lib/clientError";
/**
 * ShippingAvailabilityTable — extracted sub-component.
 *
 * Extracted from FactoryShippingContainers.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Trash2, Check, X, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { AvailRow, EditingAvail } from "../types";
import { AVAIL_KEY } from "../utils";

export function ShippingAvailabilityTable() {
  const { toast } = useToast();
  const [editing, setEditing] = useState<EditingAvail | null>(null);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [newRow, setNewRow] = useState({ date: "", shippingCompany: "", availableContainers: "", note: "" });

  const { data: rows = [], isLoading } = useQuery<AvailRow[]>({
    queryKey: [AVAIL_KEY],
  });

  const addMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", AVAIL_KEY, {
        date: newRow.date,
        shippingCompany: newRow.shippingCompany.trim(),
        availableContainers: parseInt(newRow.availableContainers) || 0,
        note: newRow.note.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [AVAIL_KEY] });
      setNewRow({ date: "", shippingCompany: "", availableContainers: "", note: "" });
      setAdding(false);
      toast({ title: "Row added" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed to add", description: e.message, variant: "destructive" }),
  });

  const saveMutation = useMutation({
    mutationFn: (row: EditingAvail) =>
      apiRequest("PATCH", `${AVAIL_KEY}/${row.id}`, {
        date: row.date,
        shippingCompany: row.shippingCompany.trim(),
        availableContainers: parseInt(row.availableContainers) || 0,
        note: row.note.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [AVAIL_KEY] });
      setEditing(null);
      toast({ title: "Row saved" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed to save", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${AVAIL_KEY}/${id}`, undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [AVAIL_KEY] });
      toast({ title: "Row deleted" });
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Failed to delete", description: e.message, variant: "destructive" }),
  });

  function startEdit(row: AvailRow) {
    setEditing({
      id: row.id,
      date: row.date,
      shippingCompany: row.shippingCompany,
      availableContainers: String(row.availableContainers),
      note: row.note || "",
    });
  }

  function handleAddKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") addMutation.mutate();
    if (e.key === "Escape") {
      setAdding(false);
      setNewRow({ date: "", shippingCompany: "", availableContainers: "", note: "" });
    }
  }

  function handleEditKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && editing) saveMutation.mutate(editing);
    if (e.key === "Escape") setEditing(null);
  }

  return (
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
          <span className="text-xs text-muted-foreground">({rows.length})</span>
        </button>
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
      </div>

      {expanded && <div className="overflow-x-auto">
        <Table mobileLayout="cards" className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs w-36">Date</TableHead>
              <TableHead className="text-xs">Shipping Company</TableHead>
              <TableHead className="text-xs w-40">Available Containers</TableHead>
              <TableHead className="text-xs">Note</TableHead>
              <TableHead className="text-xs w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                  Loading…
                </TableCell>
              </TableRow>
            ) : rows.length === 0 && !adding ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-6 text-muted-foreground">
                  No rows yet. Click "Add Row" to start.
                </TableCell>
              </TableRow>
            ) : (
              <>
                {rows.map((row) =>
                  editing?.id === row.id ? (
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
                      className="hover-elevate cursor-pointer"
                      onClick={() => startEdit(row)}
                      data-testid={`row-avail-${row.id}`}
                    >
                      <TableCell>{row.date}</TableCell>
                      <TableCell>{row.shippingCompany}</TableCell>
                      <TableCell>{row.availableContainers}</TableCell>
                      <TableCell className="text-muted-foreground">{row.note || "—"}</TableCell>
                      <TableCell>
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
                      </TableCell>
                    </TableRow>
                  )
                )}
                {adding && (
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
                            setNewRow({ date: "", shippingCompany: "", availableContainers: "", note: "" });
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
            )}
          </TableBody>
        </Table>
      </div>}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
