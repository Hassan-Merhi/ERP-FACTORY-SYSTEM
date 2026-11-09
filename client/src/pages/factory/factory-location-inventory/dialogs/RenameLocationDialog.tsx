/**
 * RenameLocationDialog — extracted from FactoryLocationInventory.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useFactoryLocationInventory } from "../../FactoryLocationInventoryModel";

type FactoryLocationInventoryModel = ReturnType<typeof useFactoryLocationInventory>;
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function RenameLocationDialog({
  renameDialogOpen,
  renameInput,
  renameLocationMutation,
  renamingLocation,
  setRenameDialogOpen,
  setRenameInput,
}: {
  renameDialogOpen: FactoryLocationInventoryModel["renameDialogOpen"];
  renameInput: FactoryLocationInventoryModel["renameInput"];
  renameLocationMutation: FactoryLocationInventoryModel["renameLocationMutation"];
  renamingLocation: FactoryLocationInventoryModel["renamingLocation"];
  setRenameDialogOpen: FactoryLocationInventoryModel["setRenameDialogOpen"];
  setRenameInput: FactoryLocationInventoryModel["setRenameInput"];
}) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const [deleteMode, setDeleteMode] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const deleteLocationMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("DELETE", `/api/locations/${id}`);
      return res.json();
    },
    onSuccess: (result) => {
      toast({ title: "Location deleted", description: `"${result.name}" was archived safely.` });
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/locations"] });
      setDeleteMode(false);
      setDeleteConfirm("");
      setRenameDialogOpen(false);
    },
    onError: (error: Error) => {
      toast({ title: "Cannot delete location", description: error.message, variant: "destructive" });
    },
  });

  const closeDialog = () => {
    setDeleteMode(false);
    setDeleteConfirm("");
    setRenameDialogOpen(false);
  };

  return (
    <Dialog
      open={renameDialogOpen}
      onOpenChange={(open) => {
        if (!open) closeDialog();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{deleteMode ? "Delete Location" : "Manage Location"}</DialogTitle>
          <DialogDescription>
            {deleteMode ? (
              <>
                This safely archives <strong>{renamingLocation?.name}</strong>. Historical vouchers and transfers stay
                intact.
              </>
            ) : (
              <>
                Rename <strong>{renamingLocation?.name}</strong> or delete it if it no longer has stock.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {deleteMode ? (
          <div className="space-y-3 py-2">
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              A location with stock cannot be deleted. Move or remove all stock first.
            </div>
            <div className="space-y-1.5">
              <div className="text-sm text-muted-foreground">
                Type <strong>DELETE</strong> to confirm.
              </div>
              <Input
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder="DELETE"
                data-testid="input-delete-location-confirm"
                autoFocus
              />
            </div>
          </div>
        ) : (
          <div className="py-2">
            <Input
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              placeholder="Location name"
              data-testid="input-rename-location"
              onKeyDown={(e) => {
                if (e.key === "Enter" && recordChanges.allowed && renameInput.trim() && renamingLocation) {
                  renameLocationMutation.mutate({ id: renamingLocation.id, name: renameInput.trim() });
                }
              }}
              autoFocus
            />
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          {deleteMode ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setDeleteMode(false);
                  setDeleteConfirm("");
                }}
              >
                Back
              </Button>
              {recordChanges.allowed && (
                <Button
                  variant="destructive"
                  onClick={() => renamingLocation && deleteLocationMutation.mutate(renamingLocation.id)}
                  disabled={deleteConfirm !== "DELETE" || deleteLocationMutation.isPending}
                  data-testid="button-delete-location-confirm"
                >
                  {deleteLocationMutation.isPending ? "Deleting..." : "Delete Location"}
                </Button>
              )}
            </>
          ) : (
            <>
              {recordChanges.allowed && (
                <Button variant="destructive" onClick={() => setDeleteMode(true)} data-testid="button-delete-location">
                  Delete Location
                </Button>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={closeDialog} data-testid="button-rename-cancel">
                  Cancel
                </Button>
                {recordChanges.allowed && (
                  <Button
                    onClick={() => {
                      if (renameInput.trim() && renamingLocation) {
                        renameLocationMutation.mutate({ id: renamingLocation.id, name: renameInput.trim() });
                      }
                    }}
                    disabled={!renameInput.trim() || renameLocationMutation.isPending}
                    data-testid="button-rename-confirm"
                  >
                    {renameLocationMutation.isPending ? "Saving..." : "Rename"}
                  </Button>
                )}
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
