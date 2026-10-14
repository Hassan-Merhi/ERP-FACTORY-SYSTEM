import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Check } from "lucide-react";
import type { useFactoryPendingInvoiceVerifyModel } from "../useFactoryPendingInvoiceVerifyModel";

type Model = ReturnType<typeof useFactoryPendingInvoiceVerifyModel>;

export function FactoryPendingInvoiceVerifyDialog1({ model }: { model: Model }) {
  const { showApproveDialog, setShowApproveDialog, approveNotes, setApproveNotes, verifyMutation } = model;
  return (
    <Dialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Approve & Verify Order</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This will mark the order as VERIFIED. You can add optional notes below.
          </p>
          <Textarea
            value={approveNotes}
            onChange={(e) => setApproveNotes(e.target.value)}
            placeholder="Optional notes..."
            data-testid="input-approve-notes"
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => setShowApproveDialog(false)} data-testid="button-cancel-approve">
              Cancel
            </Button>
            <Button
              onClick={() => {
                verifyMutation.mutate({ approved: true, notes: approveNotes || undefined });
                setShowApproveDialog(false);
              }}
              disabled={verifyMutation.isPending}
              data-testid="button-confirm-approve"
            >
              <Check className="mr-2 h-4 w-4" />
              Confirm
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
