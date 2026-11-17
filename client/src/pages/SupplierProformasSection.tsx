// Extracted from ./SupplierProformas.tsx to keep that module under the source-size cap.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Pencil, Star, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { useSupplierProformasState } from "./useSupplierProformasState";

export function SupplierProformasSection({
  commitRename,
  deleteMutation,
  destinationLabel,
  destinations,
  filterDestinationId,
  ownerCompanyId,
  proformas,
  recordChanges,
  renameInputRef,
  renameValue,
  renamingId,
  selectedProformaId,
  setFilterDestinationId,
  setPendingDelete,
  setRenameValue,
  setRenamingId,
  setSelectedProformaId,
  starMutation,
  startRename,
}: Pick<
  ReturnType<typeof useSupplierProformasState>,
  | "commitRename"
  | "deleteMutation"
  | "destinationLabel"
  | "destinations"
  | "filterDestinationId"
  | "ownerCompanyId"
  | "proformas"
  | "recordChanges"
  | "renameInputRef"
  | "renameValue"
  | "renamingId"
  | "selectedProformaId"
  | "setFilterDestinationId"
  | "setPendingDelete"
  | "setRenameValue"
  | "setRenamingId"
  | "setSelectedProformaId"
  | "starMutation"
  | "startRename"
>) {
  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Proformas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(!proformas || proformas.length === 0) && (
            <p className="text-sm text-muted-foreground">No proformas yet. Create one to get started.</p>
          )}
          <div className="mb-3">
            <Select value={filterDestinationId} onValueChange={setFilterDestinationId}>
              <SelectTrigger data-testid="filter-proforma-company">
                <SelectValue placeholder="Destination company" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All destinations</SelectItem>
                {destinations.map((company) => (
                  <SelectItem key={company.id} value={String(company.id)}>
                    {company.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {proformas
            ?.filter(
              (p) =>
                filterDestinationId === "all" ||
                String(p.destinationCompanyId ?? ownerCompanyId) === filterDestinationId
            )
            .sort(
              (a, b) =>
                (a.destinationCompanyId ?? ownerCompanyId ?? 0) - (b.destinationCompanyId ?? ownerCompanyId ?? 0)
            )
            .map((p) => (
              <div
                key={p.id}
                className={`flex items-center justify-between gap-2 p-2 rounded-md cursor-pointer ${selectedProformaId === p.id ? "bg-accent" : "hover-elevate"}`}
                onClick={() => setSelectedProformaId(p.id)}
                data-testid={`row-proforma-${p.id}`}
              >
                <div className="min-w-0 flex-1" onClick={(e) => renamingId === p.id && e.stopPropagation()}>
                  {renamingId === p.id ? (
                    <Input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(p.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRename(p.id);
                        }
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setRenamingId(null);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="h-7 text-sm px-2 py-0"
                      data-testid={`input-rename-proforma-${p.id}`}
                    />
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5">
                        {p.isStarred && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                        <span className="text-sm font-medium truncate">{p.reference}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {destinationLabel(p.destinationCompanyId)} · {format(new Date(p.createdAt), "MMM d, yyyy")}
                      </div>
                    </>
                  )}
                </div>
                {recordChanges.allowed && renamingId !== p.id && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => startRename(e, p)}
                    data-testid={`button-rename-proforma-${p.id}`}
                    title="Rename"
                  >
                    <Pencil className="h-3 w-3 text-muted-foreground" />
                  </Button>
                )}
                {recordChanges.allowed && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      starMutation.mutate(p.id);
                    }}
                    data-testid={`button-star-proforma-${p.id}`}
                    title={p.isStarred ? "Remove default for this destination" : "Use as default for this destination"}
                  >
                    <Star
                      className={`h-3.5 w-3.5 ${p.isStarred ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`}
                    />
                  </Button>
                )}
                {recordChanges.allowed && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDelete(() => () => deleteMutation.mutate(p.id));
                    }}
                    data-testid={`button-delete-proforma-${p.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function SupplierProformasDialogSection({
  createDestinationId,
  createMutation,
  createNotes,
  createRef,
  destinations,
  ownerCompanyId,
  setCreateDestinationId,
  setCreateNotes,
  setCreateRef,
  setShowCreateDialog,
  showCreateDialog,
}: Pick<
  ReturnType<typeof useSupplierProformasState>,
  | "createDestinationId"
  | "createMutation"
  | "createNotes"
  | "createRef"
  | "destinations"
  | "ownerCompanyId"
  | "setCreateDestinationId"
  | "setCreateNotes"
  | "setCreateRef"
  | "setShowCreateDialog"
  | "showCreateDialog"
>) {
  return (
    <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create Proforma</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Reference *</label>
            <Input
              value={createRef}
              onChange={(e) => setCreateRef(e.target.value)}
              placeholder="e.g. PF-2026-001"
              data-testid="input-proforma-ref"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Notes</label>
            <Textarea
              value={createNotes}
              onChange={(e) => setCreateNotes(e.target.value)}
              placeholder="Optional notes..."
              data-testid="input-proforma-notes"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Destination company *</label>
            <Select value={createDestinationId || String(ownerCompanyId ?? "")} onValueChange={setCreateDestinationId}>
              <SelectTrigger data-testid="select-proforma-destination">
                <SelectValue placeholder="Select destination" />
              </SelectTrigger>
              <SelectContent>
                {destinations.map((company) => (
                  <SelectItem key={company.id} value={String(company.id)}>
                    {company.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                createMutation.mutate({
                  reference: createRef,
                  notes: createNotes,
                  destinationCompanyId: Number(createDestinationId || ownerCompanyId),
                })
              }
              disabled={!createRef.trim() || !Number(createDestinationId || ownerCompanyId) || createMutation.isPending}
              data-testid="button-confirm-create"
            >
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
