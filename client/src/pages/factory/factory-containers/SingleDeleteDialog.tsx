// Extracted from ./ContainerDialogs.tsx
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useAdminOverride } from "@/hooks/use-admin-override";
import type { ContainerWithSupplier } from "./otwHelpers";

export interface BulkDeleteDialogProps {
  open: boolean;
  selectedIds: Set<number>;
  onClose: () => void;
  onDeleted: () => void;
}

interface SingleDeleteDialogProps {
  containerId: number | null;
  onClose: () => void;
}

export function SingleDeleteDialog({ containerId, onClose }: SingleDeleteDialogProps) {
  const { toast } = useToast();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await factoryApiRequest("DELETE", `/api/factory/containers/${id}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to delete container");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      toast({ title: "Deleted", description: "Container removed" });
      onClose();
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <>
      <Dialog
        open={containerId !== null}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Delete Container?
            </DialogTitle>
            <DialogDescription>
              This will permanently delete the container and all its linked records — accounting entries, vouchers, FX
              allocations, mix batch links, offload charges, and raw stock. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={onClose} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() =>
                wrapAdminAction(() => {
                  if (containerId !== null) deleteMutation.mutate(containerId);
                }, "Delete Container")
              }
              data-testid="button-confirm-delete-container"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Container"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </>
  );
}

export interface ReverseOffloadDialogProps {
  container: ContainerWithSupplier | null;
  onClose: () => void;
}
