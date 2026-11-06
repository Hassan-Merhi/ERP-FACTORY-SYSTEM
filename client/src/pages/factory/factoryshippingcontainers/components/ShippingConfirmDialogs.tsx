import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ShippingConfirmDialogsProps {
  pendingDeleteId: number | null;
  onCancelDelete: () => void;
  onConfirmDelete: (id: number) => void;
  pendingDoneId: number | null;
  onCancelDone: () => void;
  onConfirmDone: (id: number) => void;
}

/** The "Delete this record?" and "Mark as Done?" confirmations of the shipping page. */
export function ShippingConfirmDialogs({
  pendingDeleteId,
  onCancelDelete,
  onConfirmDelete,
  pendingDoneId,
  onCancelDone,
  onConfirmDone,
}: ShippingConfirmDialogsProps) {
  return (
    <>
      {/* Confirm delete */}
      <AlertDialog
        open={!!pendingDeleteId}
        onOpenChange={(v) => {
          if (!v) onCancelDelete();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the shipping container record and all its attached documents. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => {
                if (pendingDeleteId) onConfirmDelete(pendingDeleteId);
              }}
              data-testid="button-confirm-delete-row"
            >
              Yes, Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm before marking done */}
      <AlertDialog
        open={!!pendingDoneId}
        onOpenChange={(v) => {
          if (!v) onCancelDone();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as Done?</AlertDialogTitle>
            <AlertDialogDescription>
              This will move the shipment to the Done / Hidden section. You can restore it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDoneId) onConfirmDone(pendingDoneId);
              }}
              data-testid="button-confirm-done"
            >
              Yes, Mark as Done
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
