import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
/**
 * MarkPayrollPaidDialog — extracted from FactoryWorkerDetail.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useFactoryWorkerDetailModel } from "../../factoryworkerdetail/useFactoryWorkerDetailModel";

type FactoryWorkerDetailModel = ReturnType<typeof useFactoryWorkerDetailModel>;
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function MarkPayrollPaidDialog({
  cashAccounts,
  markPaidMutation,
  payCashAccountId,
  payOpen,
  payTargetId,
  setPayCashAccountId,
  setPayOpen,
  setPayTargetId,
  wrapAdminAction,
}: {
  cashAccounts: FactoryWorkerDetailModel["cashAccounts"];
  markPaidMutation: FactoryWorkerDetailModel["markPaidMutation"];
  payCashAccountId: FactoryWorkerDetailModel["payCashAccountId"];
  payOpen: FactoryWorkerDetailModel["payOpen"];
  payTargetId: FactoryWorkerDetailModel["payTargetId"];
  setPayCashAccountId: FactoryWorkerDetailModel["setPayCashAccountId"];
  setPayOpen: FactoryWorkerDetailModel["setPayOpen"];
  setPayTargetId: FactoryWorkerDetailModel["setPayTargetId"];
  wrapAdminAction: FactoryWorkerDetailModel["wrapAdminAction"];
}) {
  return (
    <Dialog
      open={payOpen}
      onOpenChange={(open) => {
        if (!open) {
          setPayOpen(false);
          setPayTargetId(null);
        }
      }}
    >
      <DialogContent data-testid="dialog-pay-payroll">
        <DialogHeader>
          <DialogTitle>Mark Payroll as Paid</DialogTitle>
          <DialogDescription>Select a cash account to record this payment.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Cash Account</Label>
            <UnifiedAccountPicker
              options={(cashAccounts ?? []).map((a) => ({ value: String(a.id), name: a.name }))}
              value={payCashAccountId}
              onChange={setPayCashAccountId}
              placeholder="Select account"
              testId="select-pay-cash"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPayOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              wrapAdminAction(
                () => payTargetId && markPaidMutation.mutate({ id: payTargetId, cashId: payCashAccountId }),
                "Confirm Payment"
              )
            }
            disabled={markPaidMutation.isPending}
            data-testid="button-confirm-pay"
          >
            {markPaidMutation.isPending ? "Saving..." : "Confirm Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
