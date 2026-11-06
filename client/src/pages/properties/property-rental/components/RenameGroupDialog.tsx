/**
 * Renames a Properties location group for every warehouse or shop in it.
 * Extracted from PropertyRentalPage.tsx to keep it under the 900-line cap.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ClientErrorLike } from "@/lib/clientError";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  apiBase: string;
  testIdPrefix: string;
  group: { name: string; unitId: number; count: number };
  onClose: () => void;
}

export function RenameGroupDialog({ apiBase, testIdPrefix, group, onClose }: Props) {
  const { toast } = useToast();
  const [newGroupName, setNewGroupName] = useState(group.name);
  const renameLocationGroup = useMutation({
    mutationFn: ({ unitId, locationGroup }: { unitId: number; locationGroup: string }) =>
      apiRequest("PATCH", `${apiBase}/units/${unitId}`, { renameGroup: true, locationGroup }),
    onSuccess: () => {
      toast({ title: "Location group renamed" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      onClose();
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Could not rename location group", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !renameLocationGroup.isPending && onClose()}>
      <DialogContent data-testid={`dialog-${testIdPrefix}-rename-group`}>
        <DialogHeader>
          <DialogTitle>Rename location group</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rename-rental-location-group">Group name</Label>
          <Input
            id="rename-rental-location-group"
            value={newGroupName}
            maxLength={120}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                newGroupName.trim() &&
                newGroupName.trim().toUpperCase() !== group.name.toUpperCase() &&
                !renameLocationGroup.isPending
              ) {
                renameLocationGroup.mutate({ unitId: group.unitId, locationGroup: newGroupName.trim() });
              }
            }}
            data-testid={`input-${testIdPrefix}-rename-group`}
          />
          <p className="text-xs text-muted-foreground">
            Renames this location for all its warehouses or shops in this company. Contracts, payments, and accounting
            records are unchanged.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose()} disabled={renameLocationGroup.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => renameLocationGroup.mutate({ unitId: group.unitId, locationGroup: newGroupName.trim() })}
            disabled={
              !newGroupName.trim() ||
              newGroupName.trim().toUpperCase() === group.name.toUpperCase() ||
              renameLocationGroup.isPending
            }
            data-testid={`button-${testIdPrefix}-save-group`}
          >
            {renameLocationGroup.isPending ? "Saving…" : `Rename ${group.count} units`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
