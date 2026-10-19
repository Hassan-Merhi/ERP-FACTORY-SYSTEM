import type { ClientErrorLike } from "@/lib/clientError";
/** Scheduled containers — a separate company-scoped schedule above container availability. */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Check, ChevronDown, ChevronRight, Loader2, Plus, Trash2, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
interface ScheduledRow {
  id: number;
  date: string;
  shippingCompany: string;
  scheduledContainers: number;
  note: string | null;
  details: string | null;
  isArchived: boolean;
  archivedAt: string | null;
}
interface EditingScheduled {
  id: number;
  date: string;
  shippingCompany: string;
  scheduledContainers: string;
  note: string;
  details: string;
}
const SCHEDULED_KEY = "/api/factory/scheduled-containers";

export function ScheduledContainersTable() {
  const { toast } = useToast();
  const [editing, setEditing] = useState<EditingScheduled | null>(null);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [newRow, setNewRow] = useState({
    date: "",
    shippingCompany: "",
    scheduledContainers: "",
    note: "",
    details: "",
  });

  const { data: rows = [], isLoading, isError, refetch } = useQuery<ScheduledRow[]>({
    queryKey: [SCHEDULED_KEY],
    // This is an editable schedule, not a live status feed. Background polling
    // used to refetch every five seconds while someone was typing into a row.
    // Successful add/edit/delete actions already invalidate this key.
    staleTime: 5 * 60 * 1000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const activeRows = rows.filter((row) => !row.isArchived);
  const addMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", SCHEDULED_KEY, {
        date: newRow.date,
        shippingCompany: newRow.shippingCompany.trim(),
        scheduledContainers: parseInt(newRow.scheduledContainers) || 0,
        note: newRow.note.trim() || null,
        details: newRow.details.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [SCHEDULED_KEY] });
      setNewRow({ date: "", shippingCompany: "", scheduledContainers: "", note: "", details: "" });
      setAdding(false);
      toast({ title: "Row added" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed to add", description: e.message, variant: "destructive" }),
  });

  const saveMutation = useMutation({
    mutationFn: (row: EditingScheduled) =>
      apiRequest("PATCH", `${SCHEDULED_KEY}/${row.id}`, {
        date: row.date,
        shippingCompany: row.shippingCompany.trim(),
        scheduledContainers: parseInt(row.scheduledContainers) || 0,
        note: row.note.trim() || null,
        details: row.details.trim() || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [SCHEDULED_KEY] });
      setEditing(null);
      toast({ title: "Row saved" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed to save", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${SCHEDULED_KEY}/${id}`, undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [SCHEDULED_KEY] });
      toast({ title: "Row deleted" });
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Failed to delete", description: e.message, variant: "destructive" }),
  });

  function startEdit(row: ScheduledRow) {
    setEditing({
      id: row.id,
      date: row.date,
      shippingCompany: row.shippingCompany,
      scheduledContainers: String(row.scheduledContainers),
      note: row.note || "",
      details: row.details || "",
    });
  }

  function handleAddKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") addMutation.mutate();
    if (e.key === "Escape") {
      setAdding(false);
      setNewRow({ date: "", shippingCompany: "", scheduledContainers: "", note: "", details: "" });
    }
  }

  function handleEditKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && editing) saveMutation.mutate(editing);
    if (e.key === "Escape") setEditing(null);
  }

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
                      editing?.id === row.id ? (
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
                          className="hover-elevate cursor-pointer"
                          onClick={() => startEdit(row)}
                          data-testid={`row-scheduled-${row.id}`}
                        >
                          <TableCell>{row.date}</TableCell>
                          <TableCell>{row.shippingCompany}</TableCell>
                          <TableCell>{row.scheduledContainers}</TableCell>
                          <TableCell className="text-muted-foreground">{row.note || "—"}</TableCell>
                          <TableCell className="text-muted-foreground">{row.details || "—"}</TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
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
                            </div>
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

