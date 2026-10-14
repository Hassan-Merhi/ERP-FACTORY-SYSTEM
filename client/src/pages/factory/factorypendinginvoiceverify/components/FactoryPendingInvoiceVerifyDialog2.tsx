import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RotateCcw } from "lucide-react";
import type { useFactoryPendingInvoiceVerifyModel } from "../useFactoryPendingInvoiceVerifyModel";

type Model = ReturnType<typeof useFactoryPendingInvoiceVerifyModel>;

export function FactoryPendingInvoiceVerifyDialog2({ model }: { model: Model }) {
  const { showReturnDialog, setShowReturnDialog, returnToLoadingMutation } = model;
  return (
    <Dialog open={showReturnDialog} onOpenChange={setShowReturnDialog}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Return to Loading</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This will return the order back to the loading stage. Are you sure?
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => setShowReturnDialog(false)} data-testid="button-cancel-return">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                returnToLoadingMutation.mutate();
                setShowReturnDialog(false);
              }}
              disabled={returnToLoadingMutation.isPending}
              data-testid="button-confirm-return"
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Confirm Return
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
